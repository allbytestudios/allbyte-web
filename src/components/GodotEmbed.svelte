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
    }
  });

  // Wire the save bridge once the iframe is mounted. The /play/ URL is the
  // PWA's start_url, so this is where mobile users land on launch — they
  // need both the save sync protocol (so future in-game Import/Download
  // works) and the virtual gamepad (so they can actually play). Bridge is
  // wired with no onExit callback because /play/ has no "exit play mode"
  // notion — it's the standalone page. Game-side quit posts the request
  // and we route it via the in-page handler at the page level if needed,
  // or just rely on browser-back for now.
  $effect(() => {
    if (iframeEl) {
      initSaveBridge(iframeEl);
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
  {#if loading}
    <div class="loading-screen">
      <div class="loading-title">AllByte Studios</div>
      <div class="loading-subtitle">Loading game...</div>
      <div class="progress-bar">
        <div class="progress-fill" style="width: 30%"></div>
      </div>
    </div>
  {/if}

  {#if error}
    <div class="loading-screen">
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
