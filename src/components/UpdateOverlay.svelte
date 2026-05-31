<script lang="ts">
  /**
   * Full-screen "Updating..." overlay shown when the service worker
   * detects a new build of the site and takes over from the previous one.
   *
   * Flow:
   *   1. Browser fetches /sw.js on navigation.
   *   2. sw.js bytes differ from the cached worker (because we injected a
   *      new BUILD_VERSION at build time). Browser installs new SW.
   *   3. New SW calls self.skipWaiting() + clients.claim(), takes over
   *      the page synchronously.
   *   4. navigator.serviceWorker fires `controllerchange` on every client.
   *   5. We show this overlay so the user knows something is happening,
   *      wait a short beat for the visual to register, then location.reload().
   *      The reload pulls fresh HTML through the new SW which now has the
   *      new cache name and refetches from network.
   *
   * Guard: the controllerchange event ALSO fires on the very first SW
   * install (no previous controller). We suppress in that case so first-
   * time visitors don't see "Updating..." flash for no reason. The
   * heuristic is "had a controller at register time" → this is a real
   * update; if `navigator.serviceWorker.controller` was null, it's an
   * initial install and we skip the overlay.
   */
  import { onMount, onDestroy } from "svelte";

  let visible = $state(false);
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  function handleControllerChange() {
    visible = true;
    // Brief delay so the user actually sees the overlay register before
    // the page goes through reload. 1.2s is enough to read the message
    // without dragging out the update unnecessarily.
    reloadTimer = setTimeout(() => {
      window.location.reload();
    }, 1200);
  }

  onMount(() => {
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
      handleControllerChange();
    }

    navigator.serviceWorker.addEventListener("controllerchange", onChange);

    return () => {
      navigator.serviceWorker.removeEventListener("controllerchange", onChange);
    };
  });

  onDestroy(() => {
    if (reloadTimer) clearTimeout(reloadTimer);
  });
</script>

{#if visible}
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
