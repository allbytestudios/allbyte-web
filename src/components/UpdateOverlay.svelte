<script lang="ts">
  /**
   * Update-available signal for the PWA.
   *
   * Owner spec (2026-05-31): "Auto updates to PWA are very painful as a
   * user, I don't want to update when I'm mid-game and lose my progress.
   * Updates should be made when loading the Title screen."
   *
   * What we do now:
   *   1. Browser fetches /sw.js on navigation / visibilitychange.
   *   2. New sw.js bytes -> browser installs new SW + activates -> fires
   *      `controllerchange` on every client.
   *   3. We set `window.allbyteUpdatePending = true` and post
   *      `allbyte:update-available` to every iframe (game).
   *   4. We do NOT reload. The game checks the flag (or listens for the
   *      postMessage) and decides when to actually apply — typically when
   *      the user is on the Title screen and no save state is at risk.
   *   5. Game calls `parent.allbyteApplyUpdate()` (via JavaScriptBridge)
   *      when it's safe. That shows a brief "Updating..." overlay and
   *      reloads.
   *
   * Until the game wires its end up, updates are detected but not auto-
   * applied. Users still get the new version on the next manual page
   * refresh / PWA relaunch — just no surprise reloads mid-battle.
   *
   * The controllerchange event fires on first install too (no previous
   * controller). We suppress that case so first-time visitors don't see
   * a phantom update.
   */
  import { onMount, onDestroy } from "svelte";

  let applying = $state(false);
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  function broadcastToIframes() {
    document.querySelectorAll("iframe").forEach((iframe) => {
      try {
        iframe.contentWindow?.postMessage(
          { type: "allbyte:update-available" },
          "*",
        );
      } catch {
        /* cross-origin iframe — ignore */
      }
    });
  }

  function applyUpdate() {
    if (applying) return;
    applying = true;
    reloadTimer = setTimeout(() => {
      window.location.reload();
    }, 600);
  }

  function onControllerChange() {
    (window as any).allbyteUpdatePending = true;
    broadcastToIframes();
  }

  onMount(() => {
    // Expose the apply-update entrypoint regardless of whether an update
    // is currently pending — game-side polling can check pending first
    // and call apply when ready.
    (window as any).allbyteApplyUpdate = applyUpdate;

    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    // Snapshot whether we already have a controller. If yes, any subsequent
    // controllerchange is a real update. If no, the first event is the
    // initial install on a first-time visit — suppress.
    const hadControllerAtMount = !!navigator.serviceWorker.controller;
    let firstChangeFired = false;

    function onChange() {
      if (!hadControllerAtMount && !firstChangeFired) {
        firstChangeFired = true;
        return;
      }
      onControllerChange();
    }

    navigator.serviceWorker.addEventListener("controllerchange", onChange);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
      delete (window as any).allbyteApplyUpdate;
    };
  });

  onDestroy(() => {
    if (reloadTimer) clearTimeout(reloadTimer);
  });
</script>

{#if applying}
  <div class="update-overlay" role="status" aria-live="polite">
    <div class="update-content">
      <div class="update-spinner" aria-hidden="true"></div>
      <p class="update-title">Updating to the latest version</p>
      <p class="update-subtitle">Just a moment&hellip;</p>
    </div>
  </div>
{/if}

<style>
  .update-overlay {
    position: fixed;
    inset: 0;
    background: #0a0e17;
    z-index: 100000;
    display: flex;
    align-items: center;
    justify-content: center;
    color: rgba(224, 231, 255, 0.95);
    /* Echoes the in-game Chronicles boot shell style so the visual
       transition from "site running" to "updating" is consistent. */
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    animation: update-fade-in 0.18s ease-out;
  }

  @keyframes update-fade-in {
    from { opacity: 0; }
    to   { opacity: 1; }
  }

  .update-content {
    text-align: center;
    padding: 1.5rem;
  }

  .update-spinner {
    width: 48px;
    height: 48px;
    border: 3px solid rgba(167, 243, 208, 0.25);
    border-top-color: #a7f3d0;
    border-radius: 50%;
    animation: update-spin 1s linear infinite;
    margin: 0 auto 1.5rem;
  }

  @keyframes update-spin {
    to { transform: rotate(360deg); }
  }

  .update-title {
    font-size: 1.5rem;
    margin: 0 0 0.4rem;
    color: #a7f3d0;
    letter-spacing: 0.02em;
  }

  .update-subtitle {
    font-size: 1rem;
    margin: 0;
    color: rgba(224, 231, 255, 0.6);
    font-family: "Courier New", monospace;
  }

  @media (prefers-reduced-motion: reduce) {
    .update-spinner { animation-duration: 2.5s; }
    .update-overlay { animation: none; }
  }
</style>
