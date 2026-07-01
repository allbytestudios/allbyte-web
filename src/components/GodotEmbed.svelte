<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { subscribeToFile } from "../lib/testEvents";
  import { initSaveBridge, teardownSaveBridge } from "../lib/saves.svelte.ts";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import VirtualGamepad from "./VirtualGamepad.svelte";
  import MinimapPanel from "./MinimapPanel.svelte";
  import { initPlayAnalytics } from "../lib/playAnalytics";
  import DownloadGate from "./DownloadGate.svelte";
  import { downloadState, ackDownload } from "../lib/downloadGate";
  import gameVersion from "../data/game-version.json";

  // Build-freshness recovery — the "PWA stuck on an old version" fix.
  //
  // The service worker caches the whole game under a version-keyed name. On a
  // new deploy a stale PWA can keep serving the OLD cached build: the SW update
  // installs but the iframe gets handed stale assets before the new worker
  // takes control, and the deferred-update logic won't reload a game that
  // booted fine (only a STUCK one). So we verify after boot: if the loaded
  // build's version != what this webapp expects, the SW served stale — force a
  // SW update and reload once (sessionStorage-guarded against loops).
  const EXPECTED_BUILD = (gameVersion.version || "").replace(/^v/, "");
  let freshnessChecked = false;
  let recoveryTriggered = false;

  // Hard self-heal for a stale service-worker cache. A plain reg.update() often
  // no-ops on iOS standalone PWAs (and deleting the home-screen icon doesn't
  // clear Safari's website data), so nuke the SW + ALL caches and reload. The
  // next load fetches /godot/* fresh; the SW then re-registers and re-caches.
  // Once-per-session guarded so it can't loop, and only ever called on a real
  // staleness signal — never for up-to-date clients.
  async function hardResetAndReload(reason: string) {
    if (recoveryTriggered) return;
    recoveryTriggered = true;
    try {
      if (sessionStorage.getItem("ab_stale_reload")) return; // already tried this session
      sessionStorage.setItem("ab_stale_reload", "1");
    } catch {
      /* private mode — proceed without the loop guard */
    }
    console.warn(`[recover] ${reason} — clearing SW + caches and reloading`);
    try {
      const regs = (await navigator.serviceWorker?.getRegistrations?.()) ?? [];
      await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
    } catch {
      /* ignore */
    }
    try {
      const keys = (await caches?.keys?.()) ?? [];
      await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
    } catch {
      /* ignore */
    }
    location.reload();
  }

  // Case 1 — boots but STALE: the loaded build's version != what this webapp
  // expects, so the SW served an old (but self-consistent) cached build.
  function checkBuildFreshness(loadedVersion: unknown) {
    if (freshnessChecked) return;
    freshnessChecked = true;
    const loaded = String(loadedVersion ?? "").replace(/^v/, "");
    if (!loaded || !EXPECTED_BUILD || loaded === EXPECTED_BUILD) return;
    hardResetAndReload(`loaded build ${loaded} != expected ${EXPECTED_BUILD}`);
  }

  // Case 2 — MISMATCHED PAIR crash (Arc 2026-06-28): a cached old index.wasm
  // served against a new index.pck (or vice-versa) traps with "out of bounds
  // memory access" during instantiation — the game NEVER boots, so the version
  // check above can't fire. Detect the fatal trap in the engine's captured
  // console (window._consoleLogs) and self-heal the same way.
  const CRASH_SIGNATURES = [
    "out of bounds memory access",
    "memory access out of bounds",
    "Aborted(",
  ];
  function scanForEngineCrash(logs: unknown) {
    if (recoveryTriggered || !Array.isArray(logs)) return;
    for (const line of logs) {
      const s = String(line);
      if (CRASH_SIGNATURES.some((sig) => s.includes(sig))) {
        hardResetAndReload(`engine crash (mismatched cached assets?): ${s.slice(0, 90)}`);
        return;
      }
    }
  }

  interface Props {
    fixture?: string;
  }
  let { fixture }: Props = $props();

  let loading = $state(true);
  let error = $state("");
  let iframeEl = $state<HTMLIFrameElement | null>(null);

  // Download gate — hold the ~100 MB first load until the user consents.
  // The iframe's `src` is the trigger: as long as we don't render the iframe,
  // nothing is fetched. `allowed` gates that render; `showGate` shows the
  // notice. The decision is made client-side in onMount (localStorage isn't
  // available during SSR), so the server emits neither the iframe nor a wrong
  // gate state. Admin fixture deep-loads skip the gate entirely.
  let allowed = $state(false);
  let showGate = $state(false);
  let gateMode = $state<"fresh" | "update">("fresh");

  function consentToDownload() {
    ackDownload();
    showGate = false;
    allowed = true;
    loadStart = Date.now(); // count load time from consent, not page arrival
  }

  // Tier-gated build variants — see APP_CLAUDE_TIER_GATED_BUILDS.md.
  // Arc's deploy will produce two Godot exports (`/godot/public/` debug
  // stripped, `/godot/debug/` current state). Until Arc lands the variant
  // paths in S3, VARIANT_PATHS_AVAILABLE stays false and everyone gets the
  // single legacy `/godot/` path — no behavioral change at runtime.
  //
  // When Arc confirms both paths populate: flip the flag, the iframe routes
  // by tier. Add a re-resolve in onMount at the same time so SSR'd "public"
  // upgrades to "debug" for admin/legend users after auth hydrates.
  //
  // TEMPORARILY FORCED OFF (2026-06-24): the public export at
  // `/godot/public/` was looping on load (stale/threads-enabled cached build
  // + missing files incl. Laria pack) and direct loads of /play/ resolve to
  // it before auth hydrates, so anonymous/social visitors got an infinite
  // "Loading" loop. Routing everyone to the single network-first `/godot/`
  // path (the proven-working build) until Arc/Port fix the public export —
  // see APP_CLAUDE_PUBLIC_BUILD_DEPLOY_GAPS.md. Flip back to true once the
  // public build is verified clean on S3.
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

  /** Installed-PWA detection: standalone/fullscreen display mode, plus iOS
   *  Safari's navigator.standalone. The installed app is the player-facing
   *  surface, so it gets the clean NON-DEBUG (public) build — no debug HUD /
   *  TestBridge. Browser tabs keep the existing routing. */
  function isStandalonePWA(): boolean {
    if (typeof window === "undefined") return false;
    try {
      if ((navigator as any).standalone === true) return true; // iOS Safari
      return (
        !!window.matchMedia &&
        (window.matchMedia("(display-mode: standalone)").matches ||
          window.matchMedia("(display-mode: fullscreen)").matches)
      );
    } catch {
      return false;
    }
  }

  function resolveGameUrl(): string {
    // Installed PWA → the clean public (non-debug) build (owner: "pwa only
    // install non debug"). The public export boots as of v0.7.2066+. Bonus:
    // it's a different path than the debug build, so a PWA stuck on a stale
    // /godot/ cache gets a fresh fetch from /godot/public/.
    if (isStandalonePWA()) return "/godot/public/index.html";
    // Browser — Arc's deploy layout (CON_CLAUDE_TIER_GATED_LANDED.md 2026-06-05):
    //   debug  → /godot/index.html         (current path, kept)
    //   public → /godot/public/index.html  (new subdir)
    if (!VARIANT_PATHS_AVAILABLE) return "/godot/index.html";
    return resolveVariant() === "debug"
      ? "/godot/index.html"
      : "/godot/public/index.html";
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
  let analyticsOff: (() => void) | null = null;

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

  // === Mobile-context signal → game (Arc's contract) =====================
  // The in-engine Title control-hint HUD (mode icon + WASD/KLO glyphs) and the
  // Title-Menu "Controls" button are desktop-only; on mobile WEB the controls
  // are our web-side VirtualGamepad, so the engine HUD must be suppressed.
  // The engine can't detect mobile-web itself — OS.has_feature("mobile") is
  // FALSE in Chrome-mobile-web — so it reads a flag off the PARENT /play page:
  //   parent._allbyteMobileContext === true   (OR'd with OS.has_feature)
  // matching the existing parent-flag pattern (allbyteUpdatePending /
  // allbyteRequestExit in Title.gd). See CON_CLAUDE_MOBILE_CONTEXT_CONTRACT.md.
  //
  // Source of truth = the SAME media query that renders the VirtualGamepad
  // overlay, so the engine HUD hides EXACTLY when the touch gamepad shows (one
  // source, no divergence — a 1200px touch tablet gets neither). This component
  // runs ON the /play page (the iframe's parent), so `window` here is the
  // parent window the engine reads. Set before the WASM boots, kept live across
  // rotation so a resize during play retoggles it.
  function pushMobileContext() {
    if (typeof window === "undefined") return;
    (window as any)._allbyteMobileContext = isMobileViewport();
  }

  // Live media-query listener so a rotation/resize DURING play retoggles the
  // flag — the load poller stops once the game boots, so we can't ride it.
  // Registered in onMount, torn down in onDestroy.
  let mobileCtxMqlOff: (() => void) | null = null;

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
    // Set the mobile-context flag FIRST — before the iframe/WASM boots — so the
    // engine sees it at Title startup (Arc's contract). The download gate often
    // holds the iframe behind a click anyway, but set it up-front regardless.
    pushMobileContext();

    // Re-resolve client-side — PWA (standalone) detection needs `window`, which
    // isn't available during SSR, so the installed app routes to the public
    // build here rather than the SSR default.
    gameUrl = resolveGameUrl();

    // Decide the download gate now that localStorage is available. Already
    // acknowledged (so cached), an admin fixture load, or a non-touch device
    // (desktop/laptop — assumed unmetered) → straight through; otherwise hold
    // the iframe behind the consent notice. The size gate is touch-only.
    const dlState = downloadState();
    if (fixture || dlState === "ready" || !isTouchPrimary()) {
      allowed = true;
    } else {
      gateMode = dlState; // "fresh" (first load) or "update" (version bumped)
      showGate = true;
    }

    // Listen anywhere on the page for the first user gesture and try the
    // fullscreen request once. Use pointerdown so it covers mouse + touch
    // with a single handler. { once: true } auto-removes after firing.
    if (typeof window !== "undefined") {
      window.addEventListener("pointerdown", tryEnterFullscreen, { once: true });
      window.addEventListener("keydown", handleEscape);
      if (window.matchMedia) {
        const mql = window.matchMedia("(pointer: coarse) and (max-width: 1100px)");
        const onChange = () => pushMobileContext();
        mql.addEventListener("change", onChange);
        // orientationchange/resize can flip the rule without firing `change`
        // on some engines — belt-and-suspenders; the push is idempotent.
        window.addEventListener("orientationchange", onChange);
        window.addEventListener("resize", onChange);
        mobileCtxMqlOff = () => {
          mql.removeEventListener("change", onChange);
          window.removeEventListener("orientationchange", onChange);
          window.removeEventListener("resize", onChange);
        };
      }
    }

    // Start the load-status poller. 500ms cadence balances responsiveness
    // (the owner sees fresh log lines within half a second) against same-origin
    // poll overhead (touching iframe DOM is cheap but not free).
    loadPoller = setInterval(pollLoadStatus, 500);
    pollLoadStatus();

    // Anonymous play-depth funnel (no-op off prod / until backend deployed).
    // Reads same-origin gameState so we can see how far players get: location
    // (scene), combat (inBattle — combat is an overlay, not a scene), story
    // progress (lastTriggeredEventId), and first move (isMoving). All present
    // in the public build per Arc (2026-06-25).
    analyticsOff = initPlayAnalytics(() => {
      try {
        const g = (iframeEl?.contentWindow as any)?.gameState;
        if (!g) return null;
        return {
          scene: g.scene ?? null,
          inBattle: !!g.inBattle,
          event: g.lastTriggeredEventId ?? null,
          moving: !!g.isMoving,
        };
      } catch {
        return null;
      }
    });

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
    analyticsOff?.();
    teardownSaveBridge();
    stopLoadPolling();
    teardownKbNudge();
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerdown", tryEnterFullscreen);
      window.removeEventListener("keydown", handleEscape);
    }
    mobileCtxMqlOff?.();
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
    // Re-assert the parent mobile-context flag in case it was cleared; the
    // engine re-reads it at Title startup on every (re)load.
    pushMobileContext();
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

  // Loading status panel — the owner flagged 2026-06-01 that he wants info
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
  let loadStart = Date.now();
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
  // EXPECTED_DOWNLOAD_BYTES is the to-Title download: index.wasm (~37MB) +
  // index.pck (~24MB) = ~59MB. The boot shell's first-load bar is designed
  // around this total so it reads 100% exactly when the player reaches Title
  // (verified: 37/59 → 63%, matching Arc's v0.7.2049 bar). We intentionally
  // do NOT include Laria.pck (~43MB): it preloads in the background AFTER
  // Title (Arc's Title.gd preload), and this poller stops once gameState.scene
  // is set — so the bar completes at "you're in the game", not "everything
  // incl. the next area is cached". Bytes are capped at 100% either way.
  const EXPECTED_DOWNLOAD_BYTES = 36879516 + 24929996; // WASM + index.pck
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

      // Catch a mismatched-cached-pair crash (never boots) — self-heal.
      scanForEngineCrash(logs);

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
      // Verify the SW served the CURRENT build, not a stale cached one.
      checkBuildFreshness((iframeEl?.contentWindow as any)?.gameState?.version);
      loadStatus = `Ready: ${scene}`;
      loadPanelVisible = false;
      startKbNudge(scene);
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

  // --- Keyboard-suggestion nudge ------------------------------------------
  // A bouncing hint nudging desktop players toward the keyboard scheme
  // (WASD move + K/O/L/; actions), shown as Kenney keycap glyphs in large
  // ModernGoth. The play-funnel showed most sessions stall before ever
  // moving; a mouse-defaulter never discovers the keyboard works. Pure shell
  // overlay (no game-side work). Behaviour (owner spec 2026-06-25):
  //   - Shows on the Title scene (bottom-right, above the version) and again
  //     on EliasHouse (in the letterbox), staying visible while on that scene.
  //   - Each scene nudges once per device (localStorage) — not over and over.
  //   - Two presses of any scheme key dismiss it for good (persisted): the
  //     player has clearly found the keyboard. Touch devices + admin fixture
  //     loads are skipped. The same-origin iframe lets us count keypresses
  //     even while the game canvas has focus.
  let showKbHint = $state(false);
  let kbHintPos = $state<"title" | "elias">("title");
  let kbUsed = false;
  let kbPressCount = 0;
  let kbActiveScene: "title" | "elias" | null = null;
  let kbScenePoller: ReturnType<typeof setInterval> | null = null;
  let kbDoc: Document | null = null; // iframe doc we attached a listener to
  let kbStarted = false;

  const KB_KEYS = new Set([
    "w", "a", "s", "d", "k", "o", "l", ";",
    "W", "A", "S", "D", "K", "O", "L", ":",
  ]);
  // Scene names confirmed from the game's WebBootstrap (2026-06-25): the boot
  // main_scene "MainLoader" is a transient shim that immediately swaps to
  // Title.tscn (root node "Title"). So the title screen — the real drop-off —
  // reports gameState.scene === "Title", NOT the first booted scene.
  const TITLE_SCENE = "Title";
  const ELIAS_SCENE = "EliasHouse";
  const LS_USED = "ab_kb_used";
  const LS_TITLE = "ab_kb_hint_title";
  const LS_ELIAS = "ab_kb_hint_elias";

  function lsGet(k: string): string | null {
    try { return localStorage.getItem(k); } catch { return null; }
  }
  function lsSet(k: string, v: string): void {
    try { localStorage.setItem(k, v); } catch { /* private mode — ignore */ }
  }

  function isDesktopPointer(): boolean {
    try {
      return (
        window.matchMedia("(pointer: fine)").matches &&
        !window.matchMedia("(pointer: coarse)").matches
      );
    } catch {
      return true;
    }
  }

  function onKbKey(e: KeyboardEvent): void {
    if (!KB_KEYS.has(e.key)) return;
    kbPressCount += 1;
    if (kbPressCount >= 2) markKbUsed(); // found the keyboard — stop nudging for good
  }

  function markKbUsed(): void {
    if (kbUsed) return;
    kbUsed = true;
    lsSet(LS_USED, "1");
    showKbHint = false;
    kbActiveScene = null;
  }

  function showAt(pos: "title" | "elias"): void {
    kbHintPos = pos;
    kbActiveScene = pos;
    showKbHint = true;
  }
  function hideKbHint(): void {
    showKbHint = false;
    kbActiveScene = null;
  }

  function evalKbScene(scene: string | null): void {
    if (kbUsed) { hideKbHint(); return; }
    if (!scene) return;
    if (scene === TITLE_SCENE) {
      if (lsGet(LS_TITLE) !== "1") showAt("title");
      return;
    }
    if (scene === ELIAS_SCENE) {
      if (lsGet(LS_ELIAS) !== "1") showAt("elias");
      return;
    }
    // Left the nudge scene — consume its once-per-device flag and hide.
    if (kbActiveScene === "title") lsSet(LS_TITLE, "1");
    else if (kbActiveScene === "elias") lsSet(LS_ELIAS, "1");
    hideKbHint();
  }

  function startKbNudge(bootScene: string): void {
    if (kbStarted || fixture) return; // once per mount; skip admin fixture loads
    if (!isDesktopPointer()) return; // touch users get the VirtualGamepad
    kbStarted = true;
    kbUsed = lsGet(LS_USED) === "1";

    // Catch keyboard use regardless of focus: parent window AND (same-origin)
    // the game iframe's own document.
    if (typeof window !== "undefined") window.addEventListener("keydown", onKbKey);
    try {
      kbDoc = iframeEl?.contentDocument ?? null;
      kbDoc?.addEventListener("keydown", onKbKey);
    } catch {
      kbDoc = null;
    }

    if (kbUsed) return; // known keyboard user — never nudge

    evalKbScene(bootScene); // Title check immediately
    kbScenePoller = setInterval(() => {
      try {
        const g = (iframeEl?.contentWindow as any)?.gameState;
        if (!g) return;
        if (kbUsed) { teardownKbNudge(); return; }
        evalKbScene(g.scene ?? null);
      } catch {
        /* iframe not accessible — ignore */
      }
    }, 1000);
  }

  function teardownKbNudge(): void {
    if (kbScenePoller) { clearInterval(kbScenePoller); kbScenePoller = null; }
    if (typeof window !== "undefined") window.removeEventListener("keydown", onKbKey);
    try { kbDoc?.removeEventListener("keydown", onKbKey); } catch { /* ignore */ }
    kbDoc = null;
  }
</script>

<div class="godot-container">
  {#if error}
    <div class="loading-screen">
      <div class="loading-title">AllByte Studios</div>
      <p class="loading-note">{error}</p>
    </div>
  {:else if showGate}
    <DownloadGate
      mode={gateMode}
      oncontinue={consentToDownload}
      oncancel={() => (window.location.href = "/")}
    />
  {:else if allowed}
    {#if loading}
      <div class="loading-screen">
        <div class="loading-title">AllByte Studios</div>
        <div class="loading-subtitle">Loading game...</div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: 30%"></div>
        </div>
      </div>
    {/if}
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
    {#if showKbHint}
      <div class="kb-hint-layer kb-hint-{kbHintPos}">
        <div class="kb-hint" role="status" aria-live="polite">
          <span class="kb-hint-text">Keyboard&nbsp;(</span>
          <span class="kb-keys" aria-label="W A S D K O L semicolon">
            <img src="/keys/keyboard_w.png" alt="" />
            <img src="/keys/keyboard_a.png" alt="" />
            <img src="/keys/keyboard_s.png" alt="" />
            <img src="/keys/keyboard_d.png" alt="" />
            <span class="kb-keys-gap"></span>
            <img src="/keys/keyboard_k.png" alt="" />
            <img src="/keys/keyboard_o.png" alt="" />
            <img src="/keys/keyboard_l.png" alt="" />
            <img src="/keys/keyboard_semicolon.png" alt="" />
          </span>
          <span class="kb-hint-text">)&nbsp;input suggested</span>
        </div>
      </div>
    {/if}
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

  /* Keyboard-suggestion nudge. A placement layer (covers the container,
     pointer-events: none) positions the bouncing pill per scene; the pill
     draws the eye via peripheral motion and never blocks the game. */
  .kb-hint-layer {
    position: absolute;
    inset: 0;
    z-index: 4;
    display: flex;
    pointer-events: none;
  }
  /* Title: bottom-right, just above the in-game version line. */
  .kb-hint-layer.kb-hint-title {
    justify-content: flex-end;
    align-items: flex-end;
    padding: 0 0.9rem 2.6rem 0;
  }
  /* EliasHouse: down in the bottom letterbox bar. */
  .kb-hint-layer.kb-hint-elias {
    justify-content: center;
    align-items: flex-end;
    padding-bottom: 0.5rem;
  }

  .kb-hint {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
    padding: 0.45rem 0.95rem;
    background: rgba(10, 14, 23, 0.92);
    border: 1.5px solid #a7f3d0;
    border-radius: 14px;
    box-shadow: 0 0 18px rgba(167, 243, 208, 0.4);
    white-space: nowrap;
    animation: kbHintBounceY 1.15s ease-in-out infinite,
      kbHintFadeIn 0.3s ease-out;
  }
  .kb-hint-text {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.5rem;
    line-height: 1;
    color: #eafff6;
  }
  .kb-keys {
    display: inline-flex;
    align-items: center;
    gap: 0.16rem;
  }
  .kb-keys img {
    height: 1.7rem;
    width: auto;
    display: block;
  }
  .kb-keys-gap {
    width: 0.5rem;
  }

  @keyframes kbHintBounceY {
    0%,
    100% {
      transform: translateY(0);
    }
    50% {
      transform: translateY(-7px);
    }
  }
  @keyframes kbHintFadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .kb-hint {
      animation: kbHintFadeIn 0.3s ease-out;
    }
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
