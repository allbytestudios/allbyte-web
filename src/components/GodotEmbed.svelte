<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { subscribeToFile } from "../lib/testEvents";
  import { initSaveBridge, teardownSaveBridge } from "../lib/saves.svelte.ts";
  import VirtualGamepad from "./VirtualGamepad.svelte";

  interface Props {
    fixture?: string;
  }
  let { fixture }: Props = $props();

  let loading = $state(true);
  let error = $state("");
  let iframeEl = $state<HTMLIFrameElement | null>(null);
  // After the iframe finishes loading we hold the overlay open as a
  // "Tap to play" gate. This guarantees a real user-gesture context for
  // the fullscreen + orientation-lock request, which is what reliably
  // hides the Android status bar and nav bar. The first-pointerdown
  // listener below was firing only after a user tapped the gamepad, by
  // which point the bars had already been visible for several seconds.
  let userActivated = $state(false);

  function startPlay() {
    if (userActivated) return;
    userActivated = true;
    tryEnterFullscreen();
  }

  // Served from /godot/ in both dev and prod. Astro dev sets the required
  // COOP/COEP headers via vite.server.headers; CloudFront sets them in prod.
  let gameUrl = $state("/godot/index.html");

  // Dev-only: listen for SSE file-change event from the godot-reload plugin
  // and reload just the iframe when Arc redeploys.
  //
  // Reload-state handshake (Phase 1 per APP_CLAUDE_FIXTURE_SAVE_SYNC_PROPOSAL):
  // 1. Post `allbyte:prepare-reload` to the game.
  // 2. Wait for `allbyte:reload-ready` from game (or 2s timeout).
  // 3. Reload iframe. Godot side checks a localStorage marker on boot and
  //    auto-loads the reserved reload slot if fresh (<60s).
  let sseUnsub: (() => void) | null = null;
  let messageOff: (() => void) | null = null;
  let reloadReadyResolve: (() => void) | null = null;

  function awaitReloadReady(timeoutMs = 2000): Promise<void> {
    return new Promise((resolve) => {
      reloadReadyResolve = resolve;
      setTimeout(() => {
        if (reloadReadyResolve) {
          console.warn("[godot-reload] reload-ready timed out, reloading anyway");
          reloadReadyResolve();
          reloadReadyResolve = null;
        }
      }, timeoutMs);
    });
  }

  async function doReload() {
    if (!iframeEl?.contentWindow) return;
    console.log("[godot-reload] SSE event received, starting reload handshake");
    try {
      iframeEl.contentWindow.postMessage({ type: "allbyte:prepare-reload" }, "*");
      await awaitReloadReady(2000);
    } catch (err) {
      console.warn("[godot-reload] handshake failed, reloading anyway", err);
    }
    if (!iframeEl) return;
    loading = true;
    error = "";
    iframeEl.src = `/godot/index.html?t=${Date.now()}`;
  }

  // Owner spec for quit/exit:
  //   PWA mode (standalone/fullscreen)  -> close the app
  //   Browser tab                       -> return to home page
  // Wired both as the save-bridge onExit (called when the game posts
  // allbyte:request-exit) and as an Escape-key handler on the parent
  // window for desktop fallback before Arc ships the in-game quit.
  function handleExit() {
    const standalone =
      typeof window !== "undefined" &&
      ((window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
        (window.matchMedia &&
          window.matchMedia("(display-mode: fullscreen)").matches));

    if (standalone) {
      // Installed PWA — close the window. window.close() works for
      // PWAs in Chrome (script-opened-window-like context). On the rare
      // browser/version that refuses, fall back to exiting fullscreen so
      // the user can use system back/home gesture.
      try {
        window.close();
      } catch {}
      setTimeout(() => {
        try {
          if (document.fullscreenElement && document.exitFullscreen) {
            document.exitFullscreen().catch(() => {});
          }
        } catch {}
      }, 200);
    } else {
      // Browser tab — go home.
      window.location.href = "/";
    }
  }

  function handleEscape(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      handleExit();
    }
  }

  // First-interaction fullscreen + orientation lock. For installed PWA
  // users the manifest's display: "fullscreen" already hides Android
  // system chrome (status + nav bars), so this is a no-op for them. For
  // browser-tab users (not installed) it kicks in on the first touch
  // anywhere — the Fullscreen API and orientation.lock both require user
  // activation, so we hook the first pointerdown to satisfy that.
  let fullscreenAttempted = false;
  function tryEnterFullscreen() {
    if (fullscreenAttempted) return;
    fullscreenAttempted = true;
    try {
      const el = document.documentElement;
      if (!document.fullscreenElement && el.requestFullscreen) {
        el.requestFullscreen().catch(() => {});
      }
    } catch {}
    try {
      const orientation = (screen as any).orientation;
      if (orientation && typeof orientation.lock === "function") {
        orientation.lock("landscape").catch(() => {});
      }
    } catch {}
  }

  onMount(() => {
    // Listen anywhere on the page for the first user gesture and try the
    // fullscreen request once. Use pointerdown so it covers mouse + touch
    // with a single handler. { once: true } auto-removes after firing.
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", tryEnterFullscreen, { once: true });
      window.addEventListener("keydown", handleEscape);
    }

    if (!import.meta.env.DEV) return;

    sseUnsub = subscribeToFile("godot/reload", doReload);

    const onMessage = (ev: MessageEvent) => {
      if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
      if (ev.data?.type === "allbyte:reload-ready" && reloadReadyResolve) {
        reloadReadyResolve();
        reloadReadyResolve = null;
      }
    };
    window.addEventListener("message", onMessage);
    messageOff = () => window.removeEventListener("message", onMessage);
  });
  onDestroy(() => {
    sseUnsub?.();
    messageOff?.();
    teardownSaveBridge();
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", tryEnterFullscreen);
      window.removeEventListener("keydown", handleEscape);
    }
  });

  // Wire the save bridge once the iframe is mounted. The /play/ URL is the
  // PWA's start_url, so this is where mobile users land on launch — they
  // need the save sync protocol (so future in-game Import/Download works),
  // the virtual gamepad (so they can actually play), and onExit (so the
  // future in-game quit button can close the PWA or return to home).
  $effect(() => {
    if (iframeEl) {
      initSaveBridge(iframeEl, { onExit: handleExit });
    }
  });

  function onLoad() {
    loading = false;
    if (fixture && iframeEl?.contentWindow) {
      // Give the game engine a moment to initialize TestBridge
      setTimeout(() => {
        iframeEl?.contentWindow?.postMessage(
          { type: "load_fixture", path: `test_fixtures/${fixture}.json` },
          "*",
        );
      }, 2000);
    }
  }

  function onError() {
    loading = false;
    error = "Game failed to load.";
  }
</script>

<div class="godot-container">
  {#if (loading || !userActivated) && !error}
    <button
      type="button"
      class="loading-screen"
      onclick={startPlay}
      aria-label={loading ? "Loading game" : "Tap to play"}
      disabled={loading}
    >
      <div class="loading-title">AllByte Studios</div>
      {#if loading}
        <div class="loading-subtitle">Loading game...</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: 30%"></div>
        </div>
      {:else}
        <div class="tap-to-play">Tap to play</div>
        <div class="loading-subtitle subtle">Goes fullscreen on tap</div>
      {/if}
    </button>
  {/if}

  {#if error}
    <div class="loading-screen error">
      <div class="loading-title">AllByte Studios</div>
      <p class="loading-note">{error}</p>
    </div>
  {:else}
    <iframe
      bind:this={iframeEl}
      src={gameUrl}
      title="The Chronicles of Nesis"
      class="game-frame"
      onload={onLoad}
      onerror={onError}
      allow="cross-origin-isolated"
    ></iframe>
    <VirtualGamepad iframe={iframeEl} />
  {/if}
</div>

<style>
  .godot-container {
    width: 100%;
    /* Fill the available height — the parent (.play-page in play.astro)
       is sized to the viewport so the game iframe gets the full screen.
       Godot's canvasResizePolicy: 2 handles the 1.38:1 letterboxing
       inside, and the virtual gamepad lives in those letterbox bars on
       mobile. */
    height: 100%;
    background: #0a0e17;
    position: relative;
    margin: 0 auto;
  }

  .loading-screen {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    z-index: 2;
    background: #0a0e17;
    color: #e0e7ff;
    font-family: "Courier New", monospace;
    /* When the element is a <button> (the tap-to-play affordance), reset
       browser default button styles so it looks like a normal screen. */
    border: 0;
    width: 100%;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
    touch-action: manipulation;
  }

  .loading-screen:disabled {
    cursor: default;
  }

  .loading-screen:not(:disabled):active {
    background: #131a26;
  }

  .tap-to-play {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.75rem;
    color: #a7f3d0;
    margin-bottom: 0.5rem;
    letter-spacing: 0.02em;
    animation: tap-pulse 1.6s ease-in-out infinite;
  }

  @keyframes tap-pulse {
    0%, 100% { opacity: 1; }
    50%      { opacity: 0.55; }
  }

  @media (prefers-reduced-motion: reduce) {
    .tap-to-play { animation: none; }
  }

  .subtle {
    opacity: 0.45;
  }

  .loading-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }

  .loading-subtitle {
    font-size: 0.875rem;
    opacity: 0.6;
    margin-bottom: 1.5rem;
  }

  .progress-bar {
    width: 60%;
    max-width: 300px;
    height: 4px;
    background: rgba(0, 255, 136, 0.1);
    border-radius: 2px;
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    background: #a7f3d0;
    transition: width 0.3s;
  }

  .loading-note {
    margin-top: 2rem;
    font-size: 0.85rem;
    opacity: 0.6;
    color: #f87171;
  }

  .game-frame {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
  }
</style>
