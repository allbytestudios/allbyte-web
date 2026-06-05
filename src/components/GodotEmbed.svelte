<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { subscribeToFile } from "../lib/testEvents";
  import { initSaveBridge, teardownSaveBridge } from "../lib/saves.svelte.ts";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import VirtualGamepad from "./VirtualGamepad.svelte";
  import MinimapPanel from "./MinimapPanel.svelte";

  interface Props {
    fixture?: string;
  }
  let { fixture }: Props = $props();

  let loading = $state(true);
  let error = $state("");
  let iframeEl = $state<HTMLIFrameElement | null>(null);

  // Tier-gated build variants — see APP_CLAUDE_TIER_GATED_BUILDS.md.
  // Arc's deploy will produce two Godot exports (`/godot/public/` debug
  // stripped, `/godot/debug/` current state). Until Arc lands the variant
  // paths in S3, VARIANT_PATHS_AVAILABLE stays false and everyone gets the
  // single legacy `/godot/` path — no behavioral change at runtime.
  //
  // When Arc confirms both paths populate: flip the flag, the iframe routes
  // by tier. Add a re-resolve in onMount at the same time so SSR'd "public"
  // upgrades to "debug" for admin/legend users after auth hydrates.
  const VARIANT_PATHS_AVAILABLE = false;

  type Variant = "public" | "debug";

  function getBuildOverride(): Variant | null {
    if (typeof window === "undefined") return null;
    const value = new URLSearchParams(window.location.search).get("build");
    return value === "public" || value === "debug" ? value : null;
  }

  function resolveVariant(): Variant {
    const override = getBuildOverride();
    if (override && isAdmin(auth.currentUser)) return override;
    if (isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend")) {
      return "debug";
    }
    return "public";
  }

  function resolveGameUrl(): string {
    if (!VARIANT_PATHS_AVAILABLE) return "/godot/index.html";
    return `/godot/${resolveVariant()}/index.html`;
  }

  let gameUrl = $state(resolveGameUrl());

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
    iframeEl.src = `${gameUrl}?t=${Date.now()}`;
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

  // First-interaction fullscreen + orientation lock — MOBILE ONLY.
  // Owner spec: fullscreen is default on mobile browser + mobile PWA,
  // NOT on desktop browser or desktop PWA. Desktop users keep their
  // windowed experience; F11 is still available if they want it.
  // Manifest is "standalone" now, so installed PWAs don't auto-
  // fullscreen via the manifest either — JS gates it on viewport.
  function isMobileViewport(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(pointer: coarse) and (max-width: 1100px)").matches;
  }

  let fullscreenAttempted = false;
  function tryEnterFullscreen() {
    if (fullscreenAttempted) return;
    fullscreenAttempted = true;
    if (!isMobileViewport()) return;
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

    // Start the load-status poller. 500ms cadence balances responsiveness
    // (Drew sees fresh log lines within half a second) against same-origin
    // poll overhead (touching iframe DOM is cheap but not free).
    loadPoller = setInterval(pollLoadStatus, 500);
    pollLoadStatus();

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
    stopLoadPolling();
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

  // Loading status panel — Drew flagged 2026-06-01 that he wants info
  // visible during the load phase, both for debugging and for users to
  // feel like something's happening. The Chronicles boot shell inside
  // the iframe shows the dot/icon animation; this panel sits BELOW that
  // (semi-transparent strip at the bottom of the play container) with:
  //   - elapsed wall-clock seconds since the iframe started loading
  //   - last few lines of window._consoleLogs (the GDScript print() trail
  //     that index.html's ARC-DEV-CONSOLE script captures)
  //   - a current-phase heuristic from what we can poll same-origin
  //
  // Hides as soon as the engine reports a scene via window.gameState
  // (set by the title scene's _ready).
  const loadStart = Date.now();
  let loadElapsed = $state(0);
  let loadStatus = $state("Starting...");
  let loadLogTail = $state<string[]>([]);
  let loadPanelVisible = $state(true);
  let loadPoller: ReturnType<typeof setInterval> | null = null;

  // Download progress: observe completed resource fetches inside the
  // iframe and sum the bytes. PerformanceObserver fires per-resource on
  // completion, so the progress bar advances in chunks rather than
  // smoothly — but that's good enough to convince a user that something
  // is happening, and it's the only same-origin path that doesn't
  // require modifying the iframe's HTML to wrap fetch().
  //
  // EXPECTED_DOWNLOAD_BYTES is a soft target — actual total depends on
  // the current export. Today it's roughly index.wasm (~37MB) +
  // index.pck (~24MB) + Laria.pck (~43MB) = ~104MB. The progress bar
  // caps visually at 100% and the phase text takes over once downloads
  // complete (WASM compile + engine init are CPU work, no fetch events).
  const EXPECTED_DOWNLOAD_BYTES = 105 * 1024 * 1024;
  let bytesDownloaded = $state(0);
  let filesDownloaded = $state(0);

  function pollLoadStatus() {
    loadElapsed = Math.floor((Date.now() - loadStart) / 1000);

    if (!iframeEl?.contentWindow) {
      loadStatus = "Waiting for iframe...";
      return;
    }

    // Same-origin: we can read iframe.contentWindow.* directly.
    let scene: string | null = null;
    let logs: string[] = [];
    let bootShell = true;
    try {
      const w = iframeEl.contentWindow as any;
      scene = w.gameState?.scene ?? null;
      logs = Array.isArray(w._consoleLogs) ? w._consoleLogs : [];
      bootShell = !!iframeEl.contentDocument?.getElementById("chronicles-shell");

      // Sum bytes for resources fetched inside the iframe under /godot/*.
      // transferSize is what crossed the wire (0 for memory-cache hits and
      // for SW cache hits, so on warm cache the progress bar effectively
      // stays at 0 — that's correct, because no actual download happened).
      // encodedBodySize is the network payload size; we fall back to it
      // when transferSize is unavailable.
      const perf = w.performance;
      if (perf && typeof perf.getEntriesByType === "function") {
        const entries = perf.getEntriesByType("resource");
        let totalBytes = 0;
        let count = 0;
        let mostRecent: { name: string; bytes: number } | null = null;
        for (const e of entries) {
          if (typeof e.name !== "string" || !e.name.includes("/godot/")) continue;
          const sz = e.transferSize || e.encodedBodySize || 0;
          if (sz > 0) {
            totalBytes += sz;
            count++;
            mostRecent = { name: e.name, bytes: sz };
          }
        }
        // Only post if the numbers actually moved — avoids spamming the
        // iframe with identical messages every 500ms when no fetches are
        // in flight (e.g. mid-compile, mid-scene-init).
        if (totalBytes !== bytesDownloaded || count !== filesDownloaded) {
          bytesDownloaded = totalBytes;
          filesDownloaded = count;
          // Owner spec (2026-06-01): web reports transport-level progress,
          // game owns the visible loading UI. Emit the postMessage so Arc's
          // Chronicles boot shell can drive a real progress bar instead of
          // the time-based dot animation. Same-origin so safe to use "*".
          try {
            (iframeEl.contentWindow as any).postMessage(
              {
                type: "allbyte:download-progress",
                bytesDownloaded: totalBytes,
                expectedBytes: EXPECTED_DOWNLOAD_BYTES,
                filesDownloaded: count,
                currentFile: mostRecent?.name ?? null,
              },
              "*",
            );
          } catch {
            /* iframe may not be ready to receive */
          }
        }
      }
    } catch {
      /* iframe still booting / not accessible yet */
    }

    // Game has reported a scene -> engine is up and rendering. Hide the
    // panel for good.
    if (scene) {
      loadStatus = `Ready: ${scene}`;
      loadPanelVisible = false;
      stopLoadPolling();
      return;
    }

    // Show the last 3 log lines (most recent at bottom). Trim each line
    // so the panel doesn't get wide.
    loadLogTail = logs.slice(-3).map((l) => String(l).slice(0, 110));

    // Heuristic phase indicator based on elapsed time + boot-shell state.
    // We can't observe Godot's WASM compile or PCK load directly, but the
    // boot-shell DOM goes away when the engine has resolved startGame().
    if (loadElapsed < 3) {
      loadStatus = "Loading game files...";
    } else if (loadElapsed < 12) {
      loadStatus = "Compiling engine...";
    } else if (bootShell) {
      loadStatus = "Initializing...";
    } else {
      loadStatus = "Loading title scene...";
    }
  }

  function stopLoadPolling() {
    if (loadPoller) {
      clearInterval(loadPoller);
      loadPoller = null;
    }
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
    <MinimapPanel />
    {#if loadPanelVisible}
      {@const pct = Math.min(100, Math.round((bytesDownloaded / EXPECTED_DOWNLOAD_BYTES) * 100))}
      {@const mbDl = (bytesDownloaded / (1024 * 1024)).toFixed(1)}
      {@const mbTotal = (EXPECTED_DOWNLOAD_BYTES / (1024 * 1024)).toFixed(0)}
      <div class="load-status" role="status" aria-live="polite">
        <div class="load-status-line load-status-primary">
          {loadStatus} <span class="load-status-elapsed">{loadElapsed}s</span>
        </div>
        {#if bytesDownloaded > 0}
          <div class="load-progress" aria-label="Download progress">
            <div class="load-progress-fill" style="width: {pct}%"></div>
            <div class="load-progress-label">
              Downloading: {mbDl} MB / ~{mbTotal} MB ({pct}%, {filesDownloaded} {filesDownloaded === 1 ? "file" : "files"})
            </div>
          </div>
        {/if}
        {#if loadLogTail.length > 0}
          <div class="load-status-logs">
            {#each loadLogTail as line}
              <div class="load-status-log-line">{line}</div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}
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

  /* Load status overlay — sits at the bottom of the play container while
     the engine is still booting. Semi-transparent strip so the Chronicles
     boot shell inside the iframe stays visible above it (the dot + icon
     animation reassures the user that something's happening; this panel
     adds debug-grade detail without overpowering the boot shell). */
  .load-status {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    z-index: 3;
    background: rgba(10, 14, 23, 0.78);
    color: rgba(224, 231, 255, 0.92);
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
    line-height: 1.35;
    padding: 0.5rem 0.75rem;
    border-top: 1px solid rgba(167, 243, 208, 0.18);
    pointer-events: none;
    max-height: 35%;
    overflow: hidden;
    backdrop-filter: blur(4px);
  }

  .load-status-primary {
    color: #a7f3d0;
    font-weight: bold;
  }

  .load-status-elapsed {
    color: rgba(224, 231, 255, 0.55);
    font-weight: normal;
    margin-left: 0.4rem;
  }

  .load-status-logs {
    margin-top: 0.35rem;
    color: rgba(224, 231, 255, 0.7);
    font-size: 0.72rem;
  }

  .load-status-log-line {
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    text-overflow: clip;
  }

  .load-progress {
    margin-top: 0.4rem;
    position: relative;
    height: 14px;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 3px;
    overflow: hidden;
  }

  .load-progress-fill {
    position: absolute;
    inset: 0;
    background: linear-gradient(
      90deg,
      rgba(167, 243, 208, 0.55) 0%,
      rgba(167, 243, 208, 0.8) 100%
    );
    transition: width 0.4s ease;
  }

  .load-progress-label {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 0.7rem;
    color: rgba(10, 14, 23, 0.85);
    font-weight: bold;
    text-shadow: 0 0 1px rgba(255, 255, 255, 0.4);
    pointer-events: none;
  }
</style>
