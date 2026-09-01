<script lang="ts">
  import { onMount, onDestroy } from "svelte";
  import { subscribeToFile } from "../lib/testEvents";
  import { initSaveBridge, teardownSaveBridge } from "../lib/saves.svelte.ts";
  import { initDevSession, teardownDevSession } from "../lib/devSession";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import VirtualGamepad from "./VirtualGamepad.svelte";
  import ManualLetterboxPanel from "./ManualLetterboxPanel.svelte";
  import { initPlayAnalytics } from "../lib/playAnalytics";
  import { initConsoleLogShipper } from "../lib/consoleLogShipper";
  import DownloadGate from "./DownloadGate.svelte";
  import { downloadState, ackDownload } from "../lib/downloadGate";
  import gameVersion from "../data/game-version.json";
  import spriteGifs from "../data/sprite-gifs.json";
  import { MANUAL_CARDS, EPISODE_1_SPRITES, SPRITE_DISPLAY, SPRITE_LORE } from "../lib/manualCards.ts";
  import EmailSignup from "./EmailSignup.svelte";
  import { SIGNUP_ENABLED, alreadySignedUp } from "../lib/emailSignup";
  import { versionById, isUnlocked, DEBUG_CHANNEL_ID } from "../lib/gameVersions";
  import { ensureBetaCookies, isBetaPath, stopBetaRefresh } from "../lib/betaGate";
  import { submitBugReport, type BugReportContext } from "../lib/bugReport";
  import BugReportOverlay from "./BugReportOverlay.svelte";
  // Inline (blob) worker — NOT `?worker` (that loads from an /_astro/*.js URL,
  // which fails under cross-origin isolation because those chunks carry no COEP
  // header; the COI CloudFront policy only covers /play + /godot). A blob worker
  // inherits the document's policy container, so it loads under COI.
  import LoadScreenWorker from "../lib/loadScreenWorker.ts?worker&inline";

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

  // Builds whose version legitimately differs from game-version.json (self-
  // versioned channels + scenario loads). The freshness + crash self-heals below
  // assume the DEFAULT build (alpha/alpha-debug, stamped at game-version.json),
  // so they must NOT fire for these — otherwise the expected version mismatch
  // triggers an endless "loads then reloads" cache-clear loop. alpha/alpha-debug
  // still get the self-heal (their version SHOULD match).
  // Empty since develop + staging were retired (2026-08-17): both surviving
  // channels (prod = alpha, prod debug = alpha-debug) ARE stamped at
  // game-version.json, so both legitimately get the freshness/crash self-heal.
  // Kept as a set rather than deleted — scenario loads still bypass the self-heal
  // via the `scenario` check below, and a future self-versioned channel just
  // slots back in here.
  const SELF_VERSIONED = new Set<string>([]);
  function isNonDefaultBuild(): boolean {
    if (typeof window === "undefined") return false;
    const q = new URLSearchParams(window.location.search);
    if (q.has("scenario")) return true;
    const id = q.get("v") || q.get("channel");
    return !!id && SELF_VERSIONED.has(id);
  }

  // Case 1 — boots but STALE: the loaded build's version != what this webapp
  // expects, so the SW served an old (but self-consistent) cached build.
  // Cloud-exported builds stamp themselves "<version>-<commit>" while
  // game-version.json carries the bare "<version>", so compare the semantic
  // version only — a strict compare false-positives on the suffix and forces
  // every fresh visitor through a pointless cache-clear double load
  // (2026-07-16 incognito double-load bug).
  function checkBuildFreshness(loadedVersion: unknown) {
    if (freshnessChecked) return;
    freshnessChecked = true;
    if (isNonDefaultBuild()) return;
    const norm = (v: unknown) => String(v ?? "").replace(/^v/, "").split("-")[0];
    const loaded = norm(loadedVersion);
    const expected = norm(EXPECTED_BUILD);
    if (!loaded || !expected || loaded === expected) return;
    hardResetAndReload(`loaded build ${loaded} != expected ${expected}`);
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
    if (recoveryTriggered || !Array.isArray(logs) || isNonDefaultBuild()) return;
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
  let containerEl = $state<HTMLDivElement | null>(null);
  // Surfaced ONLY with ?fsdebug=1 — Chrome's actual fullscreen rejection reason,
  // so an on-device failure is diagnosable without remote debugging.
  let fsDebug = $state("");

  // Letterbox cursor: when the game reports MOUSE input mode, show its feather
  // cursor over App's black bars too (the game only sets the custom cursor INSIDE
  // the iframe), so the pointer stays continuous across the letterbox edge.
  // Driven by the game's `allbyte:input-mode` postMessage — inert (default
  // cursor, current behavior) until that signal arrives. Feather is bundled from
  // the game (Assets/featherCursor.png, 32x32, hotspot 0,0 = Godot's
  // set_custom_mouse_cursor default). Bead ChroniclesOfNesis-98qs.
  let inputMode = $state<string | null>(null);
  let letterboxCursor = $derived(
    inputMode === "mouse"
      ? "url(/featherCursor.png) 0 0, auto"
      : inputMode === "controller"
        ? "none"
        : null,
  );

  // Download gate — hold the ~100 MB first load until the user consents.
  // The iframe's `src` is the trigger: as long as we don't render the iframe,
  // nothing is fetched. `allowed` gates that render; `showGate` shows the
  // notice. The decision is made client-side in onMount (localStorage isn't
  // available during SSR), so the server emits neither the iframe nor a wrong
  // gate state. Admin fixture deep-loads skip the gate entirely.
  // --- Instruction Booklet letterbox panel: OFF by default (feature flag) ----
  // It iframes /manual/, and /play/ is cross-origin-isolated (COEP), so a nested
  // document that doesn't send its own COEP is refused by the browser — wide
  // desktop visitors got a "allbyte.studio refused to connect" box in the left
  // bar instead of the manual (owner-reported 2026-08-08, Chrome/macOS).
  //
  // Hidden for everyone until the header is in place and the owner has tested
  // it. Enable per-URL with ?manualpanel=1 — deliberately NOT persisted, so a
  // stray flag can never leak the panel back to players.
  //
  // NOTE: enabling this alone still shows the refusal box; /manual/ must also
  // serve Cross-Origin-Embedder-Policy (+ CORP) before the panel can render.
  const manualPanelEnabled =
    typeof window !== "undefined" &&
    new URLSearchParams(window.location.search).has("manualpanel");

  let allowed = $state(false);
  let showGate = $state(false);
  // Returning mobile users skip the download gate, so /play never gets a
  // guaranteed PARENT-page gesture to enter fullscreen (Android rejects a
  // fullscreen request driven by a tap INSIDE the game iframe). This one-tap
  // start layer supplies that gesture. Desktop + new users (who tap the gate)
  // never see it.
  let showStartTap = $state(false);
  let gateMode = $state<"fresh" | "update">("fresh");

  function consentToDownload() {
    ackDownload();
    showGate = false;
    allowed = true;
    // The game brings its own music — pause the persistent site player so
    // they don't double-stack.
    window.dispatchEvent(new CustomEvent("music-player:pause"));
    loadStart = Date.now(); // count load time from consent, not page arrival
    lastProgressAt = Date.now(); // reset the boot-watchdog grace window too
    // The consent tap is a user gesture — enter mobile fullscreen right here
    // instead of waiting to catch a later pointerdown (new users' guaranteed gesture).
    tryEnterFullscreen();
  }

  // Returning mobile user's start-layer tap — the guaranteed parent gesture.
  function startTapPlay() {
    showStartTap = false;
    tryEnterFullscreen();
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
  // RE-ENABLED (2026-07-07): was forced off 2026-06-24 when the public export
  // looped on load (stale/threads-enabled cached build + missing Laria pack —
  // APP_CLAUDE_PUBLIC_BUILD_DEPLOY_GAPS.md). Evidence it's fixed: the
  // 2026-07-07 CI Deploy QA run (qa-runs/2026-07-07T14-09-07Z_8a6bf03) passes
  // BOOT + NEW GAME (Laria pack) + MOVEMENT on /godot/public/ across
  // Chromium + WebKit, and `smoke_prod.py` boots it to Title; PWA users have
  // been routed to it since v0.7.2066+ without incident. The auth-hydration
  // race that stranded anonymous visitors is handled by the one-shot
  // re-resolve $effect below. If this regresses: flip to false (isolated
  // commit, safe revert) and everyone routes to /godot/ again.
  const VARIANT_PATHS_AVAILABLE = true;

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

  // Version selection: the landing picker navigates here with ?v=<id>; a channel
  // deep-link (?channel=<id>, e.g. the scenario launcher) is an alias. Loads that
  // build IF the user's tier unlocks it (isUnlocked: alpha=everyone,
  // beta=Initiate+, develop/debug=Legend/admin) — otherwise falls through to the
  // normal default. Since the picker already gated the choice, this just honours
  // it; a hand-crafted URL for a locked tier safely falls back.
  function getVersionSelection(): string | null {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const id = q.get("v") || q.get("channel");
    if (!id) return null;
    const v = versionById(id);
    if (!v || !isUnlocked(v, auth.currentUser)) return null;
    return v.path;
  }

  function resolveGameUrl(): string {
    const selected = getVersionSelection();
    if (selected) return selected;
    // Installed PWA → the clean public (non-debug) build (owner: "pwa only
    // install non debug"). The public export boots as of v0.7.2066+. Bonus:
    // it's a different path than the debug build, so a PWA stuck on a stale
    // /godot/ cache gets a fresh fetch from /godot/public/.
    // SINGLE GATED BUILD (Arc, CON_CLAUDE_SINGLE_GATED_BUILD_VERIFIED.md,
    // build 0.8.2440). There is no longer a separate debug ARTIFACT to route
    // to: one Public export ships everywhere, with its dev surface gated at
    // call time behind ?debug=<token>. So everybody — visitor, Legend, admin,
    // installed PWA — loads the same file, and the ONLY difference is whether
    // debugParam() forwards the token (admins) or strips it (everyone else).
    //
    // This is what closes APP_CLAUDE_PROD_IS_DEBUG_BUILD.md: prod used to serve
    // the debug export to every visitor, cheat hooks and DEV ADMIN included.
    // Routing by tier is now the wrong shape — a tier can no longer buy you a
    // different build, only a different authorisation on the same one.
    return "/godot/public/index.html";
  }

  // A tier-gated deep-link (?v= / ?channel=, which every scenario jump carries)
  // CANNOT be resolved before auth hydrates: isUnlocked() sees a null user, the
  // link falls back to the public build, and the one-shot effect below then
  // swaps the src once /auth/me lands. That swap reboots the game — a second
  // full ~75 MB download from a different cache path — and the first boot's
  // onLoad already fired with the user still anonymous, so it dismissed the
  // loader while runScenario() silently no-oped at its admin gate.
  //
  // So when such a link is present and auth hasn't settled, mount NOTHING yet
  // (the loader is already up) and let the effect below mount the right build
  // exactly once. Normal loads still mount immediately — they resolve the same
  // build before and after auth, so nothing is gained by waiting.
  function hasGatedDeepLink(): boolean {
    if (typeof window === "undefined") return false;
    const q = new URLSearchParams(window.location.search);
    return !!(q.get("v") || q.get("channel") || q.get("scenario"));
  }
  /** resolveGameUrl(), but yields null while a gated deep-link waits on auth. */
  function resolveGameUrlOrHold(): string | null {
    return hasGatedDeepLink() && !auth.authReady ? null : resolveGameUrl();
  }

  // --- ?debug passthrough (single-build debug gate) --------------------------
  // Two independent layers, and neither half knows the other's:
  //   site  gates on IDENTITY  — admin, verified server-side by /auth/me
  //   game  gates on the TOKEN — checked against a constant in its own build
  // The token is NEVER stored in this repo (it is public); it arrives in the
  // owner's URL and is forwarded verbatim for admins, or dropped for everyone
  // else. So a non-admin who finds the URL has the param stripped before it
  // reaches the game, and anyone hitting /godot/ directly still needs the token.
  //
  // Gated on auth.authReady for the same reason the ?v=/?channel= deep-links are:
  // a pre-auth read sees a null user, forwards nothing, and the game boots
  // dormant — with no second chance, since we never swap builds mid-session.
  function debugParam(): string {
    if (typeof window === "undefined" || !auth.authReady) return "";
    if (!isAdmin(auth.currentUser)) return "";
    const t = new URLSearchParams(window.location.search).get("debug");
    return t ? `&debug=${encodeURIComponent(t)}` : "";
  }

  /** The iframe src: the resolved build plus the admin-only debug passthrough. */
  function gameSrc(base: string): string {
    return `${base}?t=${Date.now()}${debugParam()}`;
  }
  let gameUrl = $state<string | null>(resolveGameUrlOrHold());

  // Re-resolve ONCE when auth hydrates (the /auth/me fetch resolves after
  // mount): an admin/Legend's early "public" resolution upgrades to the debug
  // build, and a tier-gated ?v=/?channel= deep-link that fell back pre-auth
  // gets honoured. One-shot — never switch builds under a running session.
  let authResolved = false;
  $effect(() => {
    if (!authResolved && auth.authReady) {
      authResolved = true;
      const next = resolveGameUrl();
      if (next === gameUrl) return;
      // An upgrade INTO the beta channel (e.g. a ?v=beta deep-link that could
      // only unlock post-auth) must get its cookie grant before the iframe
      // fetches, same as the mount path. Denied/unavailable → stay on the
      // build we already resolved rather than mounting a build the edge will
      // refuse.
      if (isBetaPath(next)) {
        void ensureBetaCookies().then((r) => {
          if (r === "granted") gameUrl = next;
        });
      } else {
        gameUrl = next;
      }
    }
  });

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
  let bugReportOff: (() => void) | null = null;
  let rotateOff: (() => void) | null = null;
  let creditsSignupOff: (() => void) | null = null;
  let creditsSignupOpen = $state(false);
  let visibilityOff: (() => void) | null = null;
  let fsChangeOff: (() => void) | null = null;

  // --- In-game bug report → DOM text-entry overlay (native mobile keyboard) ---
  // The game canvas can't raise the mobile soft keyboard, so text entry happens in
  // a real <textarea> on THIS parent page. The game posts `allbyte:bug_report_open`
  // with context; we collect the text here and submit via bugReport.ts.
  let brOpen = $state(false);
  let brCtx = $state<BugReportContext | null>(null);
  let brStatus = $state<"idle" | "sending" | "sent" | "error">("idle");
  let brError = $state<string | null>(null);

  function bugReportMeta() {
    let gameVer: string | undefined;
    try {
      gameVer = (iframeEl?.contentWindow as any)?.gameState?.version;
    } catch {
      /* cross-origin/unavailable — the report is still filed */
    }
    return {
      channel: getVersionSelection() || resolveVariant(),
      gameVersion: gameVer ?? null,
      tier: (auth.currentUser as any)?.tier ?? null,
    };
  }
  function ackGame(r: { ok: boolean; reportId?: string; error?: string }) {
    try {
      iframeEl?.contentWindow?.postMessage(
        { type: "allbyte:bug_report_ack", ok: r.ok, reportId: r.reportId, error: r.error },
        window.location.origin,
      );
    } catch {
      /* iframe navigated away before the ack — nothing to do */
    }
  }
  async function brSubmit(payload: { text: string; category: string }) {
    brStatus = "sending";
    brError = null;
    const r = await submitBugReport(
      { text: payload.text, category: payload.category, context: brCtx ?? undefined },
      bugReportMeta(),
    );
    ackGame(r);
    if (r.ok) {
      brStatus = "sent";
      setTimeout(() => {
        brOpen = false;
        brStatus = "idle";
        brCtx = null;
        unlockOrientation(); // free orientation after the portrait form
      }, 1600);
    } else {
      brStatus = "error";
      brError = r.error ?? null;
    }
  }
  function brClose() {
    brOpen = false;
    brStatus = "idle";
    brError = null;
    brCtx = null;
    unlockOrientation(); // free orientation after the portrait form
  }
  let reloadReadyResolve: (() => void) | null = null;
  let analyticsOff: (() => void) | null = null;
  let logShipOff: (() => void) | null = null;

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
    if (!gameUrl) return; // still waiting on auth to pick the build
    iframeEl.src = gameSrc(gameUrl);
  }

  // Owner spec for quit/exit:
  //   PWA mode (standalone/fullscreen)  -> close the app
  //   Browser tab                       -> return to home page
  // Wired both as the save-bridge onExit (called when the game posts
  // allbyte:request-exit) and as an Escape-key handler on the parent
  // window for desktop fallback before Arc ships the in-game quit.
  function handleExit() {
    // A TRUE installed PWA only — NOT browser fullscreen. `display-mode:
    // fullscreen` also matches when we've merely requestFullscreen'd the page,
    // so including it made an in-fullscreen exit request drop out of fullscreen
    // instead of leaving the game. Installed = standalone display mode or iOS
    // navigator.standalone.
    const standalone =
      typeof window !== "undefined" &&
      ((window.matchMedia &&
        window.matchMedia("(display-mode: standalone)").matches) ||
        (navigator as any).standalone === true);

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

  // Orientation lock only succeeds while ALREADY in fullscreen (browsers reject a
  // bare lock) and on Android (iOS Safari has no screen.orientation.lock). Mobile-
  // only, best-effort. The bug-report overlay locks PORTRAIT while open (the game's
  // forced landscape is too cramped to read/type the form) and restores landscape
  // on close.
  function lockOrientation(mode: "landscape" | "portrait") {
    if (!isMobileViewport()) return;
    try {
      const orientation = (screen as any).orientation;
      if (orientation && typeof orientation.lock === "function") {
        orientation.lock(mode).catch(() => {});
      }
    } catch {}
  }
  // Release any orientation lock → all 4 orientations follow the device (owner
  // spec 2026-07-15: the game renders fine in portrait, so we no longer force
  // the game's landscape; applies fullscreen OR windowed).
  function unlockOrientation() {
    if (!isMobileViewport()) return;
    try {
      const o = (screen as any).orientation;
      if (o && typeof o.unlock === "function") o.unlock();
    } catch {}
  }

  function reportFsError(err: any) {
    try {
      console.warn("[fullscreen] request rejected:", err?.name, err?.message || err);
    } catch {}
    if (
      typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("fsdebug")
    ) {
      fsDebug = `fullscreen rejected: ${err?.name || ""} ${err?.message || String(err)}`.slice(0, 200);
    }
  }

  // First-gesture fullscreen. Two hard-won rules:
  //  1. Latch ONLY on success. Chrome Android rejects fullscreen from some
  //     activation contexts (notably `pointerdown`); if we latched on attempt,
  //     that first silent rejection would block the retry from the stronger
  //     `click`/`pointerup` context — the 2026-07-09 "nothing happens" bug.
  //  2. Request on the CONTAINER (holds the iframe + touch gamepad), so the
  //     gamepad stays visible in fullscreen; documentElement is the fallback.
  let fullscreenDone = false; // succeeded (or already fullscreen) — stop trying
  let fsPending = false; // a request is in flight — don't fire a second
  // Reactive fullscreen state (owner 2026-07-15): default fullscreen on mobile,
  // but let the user leave it and STAY windowed. A deliberate exit (fullscreen
  // dropped while the page is still visible — not an app-switcher background)
  // sets userOptedOut, which stops reArm from yanking them back; a parent-side
  // button re-enters from a real gesture.
  let isFullscreen = $state(false);
  let userOptedOutFullscreen = $state(false);
  let mobileFs = $state(false); // mobile viewport (set on mount) — gates the button
  function tryEnterFullscreen() {
    if (fullscreenDone || fsPending) return;
    if (userOptedOutFullscreen) return; // user chose windowed — reenter via the button
    if (!isMobileViewport()) return;
    if (document.fullscreenElement) {
      fullscreenDone = true;
      return;
    }
    const target: any = containerEl ?? document.documentElement;
    if (!target || typeof target.requestFullscreen !== "function") {
      reportFsError(new Error("requestFullscreen unsupported on this browser"));
      return;
    }
    fsPending = true;
    try {
      target.requestFullscreen()
        .then(() => {
          fullscreenDone = true;
          fsPending = false;
          if (typeof window !== "undefined")
            window.removeEventListener("pointerup", tryEnterFullscreen);
          unlockOrientation(); // all 4 orientations follow the device
        })
        .catch((err: any) => {
          fsPending = false; // stay unlatched → the next gesture retries
          reportFsError(err);
        });
    } catch (err) {
      fsPending = false;
      reportFsError(err);
    }
  }

  // Mobile browsers DROP fullscreen when you switch away (app switcher / tab
  // background), and returning isn't a user gesture — so we can't re-enter
  // programmatically. RE-ARM instead: reset the latch + re-attach the pointerup
  // listener so the player's next tap (usually the touch controls) re-enters
  // fullscreen. Owner spec is "mobile = fullscreen", so this is on by default —
  // no toggle (a toggle couldn't bypass the required gesture anyway).
  function reArmFullscreen() {
    if (typeof window === "undefined" || !isMobileViewport()) return;
    if (document.fullscreenElement) return; // still fullscreen — nothing to do
    if (userOptedOutFullscreen) return; // user chose windowed — don't yank them back
    fullscreenDone = false;
    fsPending = false;
    window.removeEventListener("pointerup", tryEnterFullscreen); // avoid a dupe
    window.addEventListener("pointerup", tryEnterFullscreen);
  }

  // Parent-side re-enter — the /play "fullscreen" button. The tap IS a parent
  // gesture (an in-iframe/postMessage tap gets rejected by Android), so this
  // reliably enters. Clears the opt-out + resets the latches first.
  function reenterFullscreen() {
    userOptedOutFullscreen = false;
    fullscreenDone = false;
    fsPending = false;
    tryEnterFullscreen();
  }

  onMount(() => {
    // Set the mobile-context flag FIRST — before the iframe/WASM boots — so the
    // engine sees it at Title startup (Arc's contract). The download gate often
    // holds the iframe behind a click anyway, but set it up-front regardless.
    pushMobileContext();

    // Scenario loads: flag it BEFORE Title inits so the game can mute the audio
    // bus across the load window and avoid the transient pop (Arc bead ansl —
    // he gates on the truthy read, unmutes once the scenario scene settles).
    if (new URLSearchParams(window.location.search).has("scenario")) {
      (window as any)._allbyteScenarioPending = true;
    }

    // Re-resolve client-side — PWA (standalone) detection needs `window`, which
    // isn't available during SSR, so the installed app routes to the public
    // build here rather than the SSR default. Must go through the HOLD variant:
    // a plain resolveGameUrl() here runs before /auth/me lands and overwrites
    // the withheld null with the public build, which is exactly the double-boot
    // this guard exists to prevent.
    gameUrl = resolveGameUrlOrHold();

    // No download gate anymore (owner 2026-08-03 — the ~75MB data-cost warning
    // isn't necessary and any gate loses players). DESKTOP and MOBILE both go
    // straight to the game; the new loading screen (studio intro + manual cards)
    // covers the download. Title audio: browsers block autoplay until a user
    // gesture, and the homepage "Play" click can't carry it (window.location.href
    // is a full navigation, which drops user-activation).
    //   • Desktop: the game's own audio resumes on the player's first
    //     click/keypress into it (Godot default) — brief silent title, then music.
    //   • Mobile: still needs a gesture to enter fullscreen (iOS rule) AND to
    //     unlock audio, so it gets a *hovering* "tap for fullscreen" prompt OVER
    //     the loading screen (not an opaque cover) — the whole area is tappable
    //     and the loading art shows through.
    const proceedToGame = () => {
      const hasScenario = new URLSearchParams(window.location.search).has("scenario");
      allowed = true;
      // Game brings its own music — pause the persistent site player.
      window.dispatchEvent(new CustomEvent("music-player:pause"));
      if (!fixture && !hasScenario && isMobileViewport()) showStartTap = true;
    };
    // Beta is edge-gated (CloudFront signed cookies): obtain the grant BEFORE
    // the iframe mounts, or an entitled user's first load 403s at the edge.
    // Not the security boundary (the edge check is) — just correct sequencing
    // plus a friendly message instead of a raw CloudFront error page.
    // gameUrl is null while a gated deep-link waits on auth — proceed (so the
    // container is ready) and let the post-auth effect above do the beta-cookie
    // grant for whatever it resolves to. Calling isBetaPath(null) here throws
    // and aborts onMount before proceedToGame(), leaving the game unmountable.
    if (gameUrl && isBetaPath(gameUrl)) {
      void ensureBetaCookies().then((r) => {
        if (r === "granted") proceedToGame();
        else if (r === "denied")
          error =
            "The Beta build is for Initiate-tier patrons and up. Episode One is free for everyone.";
        else
          error = "The Beta build isn't available right now — please try again later.";
      });
    } else {
      proceedToGame();
    }

    // Listen anywhere on the page for a user gesture and try to enter
    // fullscreen. Use `pointerup` (not `pointerdown`) — Chrome Android grants
    // fullscreen more reliably from the completed tap. NOT `{ once: true }`:
    // tryEnterFullscreen self-removes this listener on the first SUCCESS, so a
    // silently-rejected attempt is retried on the next tap instead of being
    // permanently latched out.
    if (typeof window !== "undefined") {
      window.addEventListener("pointerup", tryEnterFullscreen);
      window.addEventListener("keydown", handleEscape);
      mobileFs = isMobileViewport();
      // Track fullscreen state (drives the re-enter button) and detect a
      // DELIBERATE exit: fullscreen dropped while the page is still VISIBLE — an
      // app-switcher background goes hidden instead, so that path re-arms. A
      // deliberate exit sets userOptedOut → the user stays windowed.
      const onFsChange = () => {
        isFullscreen = !!document.fullscreenElement;
        if (!isFullscreen && fullscreenDone && document.visibilityState === "visible") {
          userOptedOutFullscreen = true;
        }
      };
      document.addEventListener("fullscreenchange", onFsChange);
      fsChangeOff = () => document.removeEventListener("fullscreenchange", onFsChange);
      // Returning from the app switcher drops fullscreen — re-arm so the next tap
      // re-enters it (see reArmFullscreen). visibilitychange→visible is the signal.
      const onVisible = () => {
        const visible = document.visibilityState === "visible";
        // Feed the game's hidden-time accumulator (window._allbyteHiddenAccumMs,
        // maintained by the game's shim) so mobile background time isn't counted
        // toward playtime. GodotEmbed is the reliable app-pause signal for mobile
        // wrappers where the iframe's own visibilitychange can be throttled/missed.
        // Contract: { type:"allbyte:visibility", visible:bool }; the shim folds it in.
        try {
          iframeEl?.contentWindow?.postMessage({ type: "allbyte:visibility", visible }, "*");
        } catch {}
        if (visible) reArmFullscreen();
      };
      document.addEventListener("visibilitychange", onVisible);
      visibilityOff = () => document.removeEventListener("visibilitychange", onVisible);
      // Rotation re-nudge (owner 2026-08-27: rotating portrait -> landscape on
      // the loading screen left the picture stuck in the left half).
      //
      // The canvas DOES follow the iframe under an emulated rotation, so this
      // is not a plain missing-resize bug. On real devices — iOS Safari most of
      // all — `orientationchange` fires BEFORE layout settles, so anything that
      // samples dimensions at that moment reads the PRE-rotation size and keeps
      // it. Godot sizes its canvas from the window, and mid-boot it has no
      // handler installed yet to correct itself afterwards.
      //
      // So: after rotation, re-dispatch resize INTO the iframe once layout has
      // actually settled. Twice, because "settled" is device-dependent and a
      // slow phone mid-wasm-compile can miss the first. Same-origin, so this is
      // allowed; idempotent, so extra fires cost nothing.
      const nudgeIframeResize = () => {
        const win = iframeEl?.contentWindow;
        if (!win) return;
        try {
          win.dispatchEvent(new Event("resize"));
        } catch {
          /* cross-origin (shouldn't happen — same origin in dev and prod) */
        }
      };
      // The LOADING screen is our own HTML, and its type is sized in vw
      // (clamp(2.6rem, 9vw, 5rem) and friends). iOS Safari recomputes viewport
      // units only after the rotation animation finishes, so the studio mark
      // and the manual card visibly lag ~a second behind the rotation while the
      // Godot canvas — which sizes itself off the window — turns immediately.
      // Owner 2026-08-27: "it does look to switch just kind of slow".
      //
      // Reading offsetWidth forces a synchronous layout, which prompts Safari
      // to settle the viewport units on this subtree sooner. It cannot beat
      // Safari's own rotation animation, so this narrows the lag rather than
      // removing it.
      const reflowLoader = () => {
        const el = containerEl?.querySelector(".loading-screen") as HTMLElement | null;
        if (el) void el.offsetWidth;
      };
      const onRotate = () => {
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            reflowLoader();
            nudgeIframeResize();
            setTimeout(() => { reflowLoader(); nudgeIframeResize(); }, 250);
            setTimeout(() => { reflowLoader(); nudgeIframeResize(); }, 700);
          }),
        );
      };
      window.addEventListener("orientationchange", onRotate);
      window.visualViewport?.addEventListener("resize", onRotate);
      rotateOff = () => {
        window.removeEventListener("orientationchange", onRotate);
        window.visualViewport?.removeEventListener("resize", onRotate);
      };

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
          newGame: !!g.newGameStarted,
          dialogue: !!g.inDialogue,
          touch: touchAcceptSeen,
        };
      } catch {
        return null;
      }
    });

    // Remote console-log shipper — PROD DEBUG channel only, so Arc can read a real
    // device's console without USB debugging. Never ships public logs. Followed the
    // debug build from /godot/develop/ to /godot/alpha-debug/ when develop was
    // retired (2026-08-17) — keyed off the channel table so it can't drift again.
    const debugPath = versionById(DEBUG_CHANNEL_ID)?.path ?? "";
    if (typeof gameUrl === "string" && debugPath && gameUrl.startsWith(debugPath.replace(/index\.html$/, ""))) {
      logShipOff = initConsoleLogShipper(
        () => {
          try {
            return (iframeEl?.contentWindow as any)?._consoleLogs ?? null;
          } catch {
            return null;
          }
        },
        () => {
          let version: string | null = null;
          try {
            version = (iframeEl?.contentWindow as any)?.gameState?.version ?? null;
          } catch {
            /* not booted yet */
          }
          return {
            version,
            channel: DEBUG_CHANNEL_ID,
            url: window.location.href,
            userAgent: navigator.userAgent,
            viewport: `${window.innerWidth}x${window.innerHeight}`,
          };
        },
      );
    }

    // Bug-report relay (PROD + dev — registered BEFORE the dev-only block below).
    // Two messages from the game:
    //   allbyte:bug_report_open {context}  → open the DOM text-entry overlay (the
    //     game canvas can't raise the mobile keyboard; a real <textarea> can).
    //   allbyte:bug_report {text, context} → legacy direct submit (kept for compat).
    // Both enrich parent-side + ack allbyte:bug_report_ack. See
    // APP_CLAUDE_BUG_REPORT_MOBILE_ADDENDUM.md.
    const onBugReport = (ev: MessageEvent) => {
      if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
      const d = ev.data;
      if (!d) return;
      if (d.type === "allbyte:bug_report_open") {
        brCtx = (d.context ?? {}) as BugReportContext;
        brStatus = "idle";
        brError = null;
        brOpen = true;
        lockOrientation("portrait"); // the game's landscape is too cramped to type in
      } else if (d.type === "allbyte:bug_report" && typeof d.text === "string") {
        void submitBugReport(
          { text: d.text, category: d.category, context: d.context },
          bugReportMeta(),
        ).then(ackGame);
      } else if (d.type === "allbyte:input-mode" && typeof d.mode === "string") {
        // Game reports its active input mode (mouse/controller/keyboard) so the
        // letterbox cursor can mirror it (bead ChroniclesOfNesis-98qs).
        inputMode = d.mode;
      }
    };
    window.addEventListener("message", onBugReport);
    bugReportOff = () => window.removeEventListener("message", onBugReport);

    // End of the Episode 1 credits -> offer the Episode 2 notify form.
    //
    // Contract agreed with Arc (game side fires it from Credits.gd via
    // JavaScriptBridge, web-guarded, just before the Credits->Title routing):
    //   { type: "allbyte_ep1_credits_complete", completed, version, replay }
    // Underscore naming because that is the game->page convention here
    // (allbyte_title_ready, allbyte_touch_accept); the colon form is page->game.
    //
    // REGISTERED HERE, ABOVE THE DEV GUARD, ON PURPOSE. The other message
    // listener below sits after `if (!import.meta.env.DEV) return`, so it never
    // runs in production — putting this one there would mean the overlay only
    // ever appeared on a dev server.
    const onCreditsEnd = (ev: MessageEvent) => {
      if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
      const d = ev.data;
      if (!d || d.type !== "allbyte_ep1_credits_complete") return;
      // Only ask someone who actually watched it through. Prompting a player
      // who just skipped the credits is the worst possible moment to ask.
      if (d.completed === false) return;
      if (d.replay === true) return;      // they have finished before; don't re-ask
      if (!SIGNUP_ENABLED || alreadySignedUp()) return;
      creditsSignupOpen = true;
    };
    window.addEventListener("message", onCreditsEnd);
    creditsSignupOff = () => window.removeEventListener("message", onCreditsEnd);

    if (!import.meta.env.DEV) return;

    sseUnsub = subscribeToFile("godot/reload", doReload);

    const onMessage = (ev: MessageEvent) => {
      if (!iframeEl || ev.source !== iframeEl.contentWindow) return;
      if (ev.data?.type === "allbyte:reload-ready" && reloadReadyResolve) {
        reloadReadyResolve();
        reloadReadyResolve = null;
      } else if (ev.data?.type === "allbyte_title_ready") {
        titleReadySignal = true; // title is interactive → OK to hide the loader
      } else if (ev.data?.type === "allbyte_touch_accept") {
        touchAcceptSeen = true; // mobile tap registered as ui_accept → funnel
      }
    };
    window.addEventListener("message", onMessage);
    messageOff = () => window.removeEventListener("message", onMessage);
  });
  onDestroy(() => {
    sseUnsub?.();
    messageOff?.();
    bugReportOff?.();
    rotateOff?.();
    creditsSignupOff?.();
    analyticsOff?.();
    logShipOff?.();
    teardownSaveBridge();
    stopLoadPolling();
    teardownKbNudge();
    stopBetaRefresh();
    if (typeof window !== "undefined") {
      window.removeEventListener("pointerup", tryEnterFullscreen);
      window.removeEventListener("keydown", handleEscape);
    }
    visibilityOff?.();
    fsChangeOff?.();
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

  // --- Dev-session bridge (admin + debug token only) -------------------------
  // Registers this LIVE session with the dev-session API so Arc/Quinn can watch
  // its state and push mutations into the game the owner is actually playing —
  // on prod, on whatever device they're holding. Design:
  // Desktop/GameDev/APP_CLAUDE_DEV_SESSION_BRIDGE.md
  //
  // The gate is `debugParam()`, not a channel id. Since the single gated build
  // (0.8.2440) everyone loads /godot/public/index.html and the ONLY thing that
  // turns on the game's dev surface is whether the ?debug token is forwarded —
  // which happens for admins only, after auth hydrates. Without that token the
  // game emits no allbyte:state and ignores allbyte:command, so gating on
  // anything else would just register sessions that can never say anything.
  //
  // Server-side this is belt-and-braces: every bridge route independently
  // verifies an admin JWT, so a leaked debug token still reaches nobody's
  // session. Two layers, neither trusting the other — same shape as the
  // identity/token split above.
  //
  // The gate is "is the game's dev surface actually on", which is NOT the same
  // as "was a token forwarded". The game authorises its dev surface via
  // GlobalWorld._debug_authorized: auto-true on local/develop/staging builds,
  // ?debug=<token> on public. So dev servers qualify without a token — matching
  // the game rather than demanding a param it does not need there.
  $effect(() => {
    if (!iframeEl || !auth.authReady) return;
    if (!isAdmin(auth.currentUser) || !(debugParam() || import.meta.env.DEV)) return;
    initDevSession(iframeEl, {
      channel: getVersionSelection() || resolveVariant(),
      gameVersion: EXPECTED_BUILD,
      label: "prod /play",
    });
    return () => teardownDevSession();
  });

  // --- Scenario launcher (admin/Legend) — Arc's canonical load sequence -------
  // A "scenario" IS a save file. Load it via the proven test-suite path: mount
  // packs → WAIT until their scene classes register (packsLoaded) → _testImportSave
  // (inline data) → _testLoadGame (the real DAL "Continue" — restores the party
  // AND warps into the saved scene). The save carries its own scene, so there is
  // no warp param. The ~1.7 KB save is fetched SAME-ORIGIN (App mirrors the game
  // repo's fixture library into /scenario-fixtures/), then handed to the game
  // inline — the game never fetches a save by id (that hook is deliberately
  // absent from the hardened build). Optional persona is an AutoPlay overlay
  // after the load. Hooks exist only in debug builds; inert otherwise. See
  // CON_CLAUDE_SCENARIO_SAVE_DELIVERY.md.
  // (Account/cloud-saves status chip removed 2026-08-03 — owner: that status
  // belongs in-game, not as a web overlay. Save-sync itself (initSaveBridge)
  // is unaffected; only the bottom-left indicator is gone.)

  // Scenario/tree jumps import + load through this scratch slot — outside the
  // player range (1..12; AUTO=0, QUICK=13 reserved game-side), excluded from
  // the save-bridge snapshot and therefore from cloud sync.
  const SCENARIO_SLOT = 99;

  // --- Pre-jump slot-1 backup (scenario/save-tree imports overwrite it) ----
  const SLOT1_KEY = "con_nesis_save_1";
  const PREJUMP_BAK_KEY = "ab_prejump_save_1";
  const IMPORT_HASH_KEY = "ab_last_import_hash";
  function slotHash(s: string): string {
    let x = 5381;
    for (let i = 0; i < s.length; i++) x = ((x << 5) + x + s.charCodeAt(i)) | 0;
    return `${x}:${s.length}`;
  }
  function backupSlot1BeforeImport(): void {
    try {
      const cur = localStorage.getItem(SLOT1_KEY);
      if (!cur) return; // nothing to protect
      if (localStorage.getItem(IMPORT_HASH_KEY) === slotHash(cur)) return; // still a fixture
      localStorage.setItem(
        PREJUMP_BAK_KEY,
        JSON.stringify({ savedAt: Date.now(), save: cur }),
      );
      console.info(
        "[scenario] backed up your slot-1 save — window.allbyteRestoreSave() to undo the jump import",
      );
    } catch { /* private mode — proceed */ }
  }
  function stampImportedSlotHash(): void {
    try {
      const now = localStorage.getItem(SLOT1_KEY);
      if (now) localStorage.setItem(IMPORT_HASH_KEY, slotHash(now));
    } catch { /* ignore */ }
  }
  if (typeof window !== "undefined") {
    // Always registered (not just on jump loads) so a clobbered save can be
    // restored from any later /play visit.
    (window as any).allbyteRestoreSave = () => {
      const bak = localStorage.getItem(PREJUMP_BAK_KEY);
      if (!bak) return "no pre-jump backup stored";
      try {
        const { savedAt, save } = JSON.parse(bak);
        localStorage.setItem(SLOT1_KEY, save);
        localStorage.removeItem(IMPORT_HASH_KEY);
        return `slot 1 restored from backup taken ${new Date(savedAt).toLocaleString()} — reload and Continue`;
      } catch {
        return "backup unreadable";
      }
    };
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  async function waitFor(pred: () => boolean, timeoutMs: number, intervalMs = 150) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try { if (pred()) return true; } catch { /* iframe not ready */ }
      await sleep(intervalMs);
    }
    return false;
  }

  async function runScenario() {
    if (typeof window === "undefined") return;
    if (!(isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend"))) return;
    const q = new URLSearchParams(window.location.search);
    const scenario = q.get("scenario");
    if (!scenario || !/^[A-Za-z0-9._-]+$/.test(scenario)) return;
    const packs = (q.get("packs") || "").split(",").map((s) => s.trim()).filter(Boolean);
    const persona = q.get("persona");
    const encounter = q.get("encounter");
    const win = () => iframeEl?.contentWindow as any;

    // 1. engine up (Title reached)
    if (!(await waitFor(() => win()?.gameState?.ready === true, 30000))) {
      console.warn(`[scenario] engine never reported ready — aborting '${scenario}'`);
      loading = false; // reveal the game (Title) so the overlay doesn't stick
      return;
    }
    // 2. fetch the save JSON same-origin (no CORS; the game never fetches it)
    let saveData: unknown;
    try {
      const res = await fetch(`/scenario-fixtures/${scenario}.json`, { cache: "no-store" });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      saveData = await res.json();
    } catch (e) {
      console.warn(`[scenario] could not fetch fixture '${scenario}': ${e}`);
      loading = false;
      return;
    }
    // 3. mount packs, WAIT until their scene classes register (else loadGameSave
    //    warps into a null scene)
    if (packs.length) {
      const w = win();
      if (w) w._testLoadPacks = packs.join(",");
      const ok = await waitFor(() => {
        const loaded = win()?.gameState?.packsLoaded;
        return Array.isArray(loaded) && packs.every((p) => loaded.includes(p));
      }, 30000);
      if (!ok) console.warn(`[scenario] packs ${packs.join(",")} never fully registered — continuing`);
    }
    // 4. import save into the SCENARIO SCRATCH SLOT → 5. load it (real DAL load)
    //
    // Owner ruling 2026-07-16: jump loads must never touch the player's real
    // slots or cloud saves. Slot 99 sits outside the player range (1..12):
    // DAL's web snapshot enumerates only 1..MAX_SAVE_SLOTS, so the scratch
    // slot is structurally invisible to the save bridge → can't cloud-sync.
    // An in-game manual Save from the jumped state still writes a normal
    // slot (and syncs), which is exactly the intended flow. The slot-1
    // backup guard stays as insurance for older deployed builds.
    backupSlot1BeforeImport();
    let w = win();
    if (!w) { loading = false; return; }
    w._testImportSave = JSON.stringify({ slot: SCENARIO_SLOT, data: saveData });
    await sleep(200);
    setTimeout(stampImportedSlotHash, 2500);
    w = win();
    if (!w) { loading = false; return; }
    w._testLoadGame = SCENARIO_SLOT;
    // Hold the overlay until the scenario scene has replaced Title, then reveal —
    // the user sees "loading" → the scenario, never the Title flash.
    await waitFor(() => {
      const s = win()?.gameState?.scene;
      return typeof s === "string" && !!s && s !== TITLE_SCENE;
    }, 25000); // slow saves can take a while to leave Title
    loading = false;
    // 6. optional AutoPlay persona overlay
    if (persona || encounter) {
      await sleep(300);
      const wp = win();
      if (wp) {
        if (persona) wp._testAutoplayJPPolicy = persona;
        wp._testAutoplayEncounterMode = encounter || "default";
      }
    }
    console.log(`[scenario] loaded '${scenario}'${packs.length ? ` (packs ${packs.join(",")})` : ""}${persona ? ` persona ${persona}` : ""}`);
  }

  function onLoad() {
    // A scenario load holds the loading overlay UP through boot → Title →
    // save-load so the Title screen never flashes (owner 2026-07-15: "go
    // straight to load"); runScenario drops it once the scenario scene is in,
    // or on abort. Normal loads dismiss immediately.
    const scenarioLoad =
      new URLSearchParams(window.location.search).has("scenario") &&
      (isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend"));
    // Normal player loads HOLD the splash (studio intro + manual card) until
    // studioDone && sceneReady (maybeReveal); fixture (admin) reveals now,
    // scenario is managed by runScenario.
    if (!isNormalPlayerLoad() && !scenarioLoad) loading = false;
    // Re-assert the parent mobile-context flag in case it was cleared; the
    // engine re-reads it at Title startup on every (re)load.
    pushMobileContext();
    // NOTE: we deliberately do NOT request fullscreen from a tap INSIDE the game
    // iframe — Android rejects a fullscreen request driven by a child-frame
    // gesture (it must originate on the parent page), and firing it there also
    // disrupts the engine's own canvas fullscreen. The parent-page start layer
    // (showStartTap) + the window pointerdown listener own fullscreen instead.
    if (fixture && iframeEl?.contentWindow) {
      // Give the game engine a moment to initialize TestBridge
      setTimeout(() => {
        iframeEl?.contentWindow?.postMessage(
          { type: "load_fixture", path: `test_fixtures/${fixture}.json` },
          "*",
        );
      }, 2000);
    }
    runScenario();
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
  // Boot WATCHDOG state (the backstop scanForEngineCrash can't be): the
  // mismatched-pair trap aborts DURING WASM instantiation — before the boot
  // shell installs its console capture — so the fatal line never reaches
  // window._consoleLogs and scanForEngineCrash never sees it; the page just
  // sits on a dead engine. So don't rely on the log: if the engine never
  // reaches a scene and NOTHING progresses (no new download bytes, no scene)
  // for a long grace window, treat it as a fatal boot and self-heal. Download
  // progress and a slow WASM compile both keep this timer alive (any progress
  // resets it), so only a genuinely stuck boot trips it. Same once-per-session
  // guard (ab_stale_reload) + same isNonDefaultBuild gate as the other heals.
  const BOOT_STALL_MS = 45000;
  // Absolute ceiling (generous — a slow mobile download + WASM compile still
  // fits): a hard backstop for wedges the stall check can't see, e.g. the iframe
  // going unreadable (contentWindow null → the stall check's early-return skips
  // it) or something incidental keeping the stall timer alive. Checked BEFORE
  // the contentWindow guard so it fires regardless of iframe state.
  const BOOT_ABSOLUTE_MS = 120000;
  let lastProgressAt = Date.now();
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
  // (byte-based progress bar removed 2026-08-03 — it read choppy because
  // transfer-size samples arrive in big lumps. Progress is now conveyed by the
  // rotating cards + a steady 3-dot "still working" indicator. bytesDownloaded
  // is still tracked for the game's own boot shell postMessage + ?debug panel.)

  // --- Two-phase loading splash (owner spec 2026-08-03) --------------------
  // Phase 1 "studio": the AllByte Studios animation, full-screen, for ~STUDIO_MS
  // (it plays its animation then holds on the logo the last ~0.5s).
  // Phase 2 "manual": a Chronicles-themed full-screen manual card (Elias, damage
  // types, statuses…) + spinner + real progress bar, until the game is ready.
  // The game is revealed only once the studio intro has played AND a scene has
  // appeared — so the studio always plays and the manual card fills the rest.
  // Normal PLAYER loads only; scenario/fixture (admin) reveal as before.
  let loadPhase = $state<"studio" | "manual">("studio");
  let studioDone = $state(false);
  let sceneReady = $state(false);
  let studioTimerStarted = false;
  // Set by the game's `allbyte_title_ready` postMessage — the title is fully
  // INTERACTIVE, not merely "its scene node exists". We hold the loader up until
  // this so the title-music (Arc gates Anthem4 on our loader_reveal) starts in
  // sync with a usable title, fixing "music starts before the title is shown".
  // Old builds never send it → a fallback reveals shortly after the scene shows.
  let titleReadySignal = false;
  let sceneFirstSeenAt = 0;
  const TITLE_READY_FALLBACK_MS = 5000;
  // Set by the game's `allbyte_touch_accept` postMessage (mobile tap = ui_accept,
  // from the touch fix). Feeds the funnel so we can measure taps vs New Game.
  let touchAcceptSeen = false;
  // Studio scene ~1s (owner: don't let it sit long). Timeline: bits flip fast →
  // slow exponentially → STOP on random values (STUDIO_SETTLE_MS) → hold briefly
  // → the whole scene fades away (STUDIO_FADE_MS) → the first manual card.
  const STUDIO_MS = 2000; // studio scene 2s (owner: 1s felt too short)
  const STUDIO_SETTLE_MS = 850; // bits blur fast then stop early (~0.85s), then hold...
  const STUDIO_FADE_MS = 220; // ...then the scene fades away over this
  const CARD_MS = 3000; // each card gets a full 3s before it rotates
  const CARD_MIN_MS = 1000; // a card still shows ≥1s if the game is already ready
  let studioFading = $state(false);
  let manualCardShownAt = 0;

  // The Play entrance (pixel dissolve) runs entirely on the homepage and ends on
  // an AllByte frame that matches this studio screen, so /play just loads its
  // normal studio → cards → game flow; no /play-side transition is needed. The
  // one-shot sessionStorage flag HeroPlay sets is cleared here to keep it tidy.
  if (typeof window !== "undefined") {
    try {
      sessionStorage.removeItem("ab_play_transition");
      sessionStorage.removeItem("ab_play_seed");
    } catch {
      /* private mode */
    }
  }

  // "All Byte" = 8 characters (the space included makes a Byte), one binary bit
  // over each. The bits flip 0/1 fast, slow exponentially, then STOP on random
  // values and hold before the scene fades. Mirrors the real in-game
  // AllByteGames splash; all glyphs are ModernGoth.
  let studioBits = $state<number[]>([1, 1, 1, 0, 1, 1, 0, 0]);
  function startStudioScramble() {
    const randomBits = () => studioBits.map(() => (Math.random() < 0.5 ? 0 : 1));
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    if (reduce) {
      studioBits = randomBits();
      return;
    }
    const start = performance.now();
    let interval = 40; // fast initial flip
    const growth = 1.36; // exponential slowdown
    const tick = () => {
      studioBits = randomBits();
      if (performance.now() - start >= STUDIO_SETTLE_MS) return; // stop on final
      interval *= growth;
      setTimeout(tick, interval);
    };
    setTimeout(tick, interval);
  }

  // All text is drawn from the in-game manual (public/manual/index.html) —
  // damage/status/terrain tables, raw vs battle stats, relics & the Anam,
  // skill types, consumables. Kept short enough to fit one screen cleanly.
  // MANUAL_CARDS + the sprite constants live in ../lib/manualCards.ts (shared with
  // the /test/cards/ review tab so the console can't drift from what ships).
  let loadCard = $state(0);

  // --- "Living manual" sprite card ----------------------------------------
  // One of the manual cards is a random non-boss sprite that turns in place
  // then swings an attack, then moves on to another character — built from the
  // handcrafted sprite GIFs already in the webapp (owner idea 2026-08-03).
  // EPISODE_1_SPRITES / SPRITE_DISPLAY / SPRITE_LORE come from ../lib/manualCards.ts.
  // Clockwise turn order; we keep only the directions a character actually has.
  const DIR_ORDER = [
    "Down",
    "DownRight",
    "Right",
    "UpRight",
    "Up",
    "UpLeft",
    "Left",
    "DownLeft",
  ];
  type CastMember = { display: string; idles: string[]; attack: string | null };
  function buildSpriteCast(): CastMember[] {
    const byChar: Record<string, { animation: string; file: string }[]> = {};
    for (const e of spriteGifs as { character: string; animation: string; file: string }[]) {
      // Episode-1 cast only — Episode 2 characters would spoil players who
      // haven't met them (owner 2026-08-07).
      if (!EPISODE_1_SPRITES.has(e.character)) continue;
      (byChar[e.character] ??= []).push(e);
    }
    const cast: CastMember[] = [];
    for (const [char, entries] of Object.entries(byChar)) {
      const idleByDir: Record<string, string> = {};
      for (const e of entries) {
        const m = e.animation.match(/^Idle(.+)$/);
        if (m) idleByDir[m[1]] = e.file;
      }
      const idles = DIR_ORDER.map((d) => idleByDir[d]).filter(Boolean);
      // An "attack": prefer a plain Attack*, else a Slap/Acid strike, else Feeding.
      // Skip gated flourish anims (Sweep/Casting) — keep it a clean swing.
      const atk =
        entries.find((e) => /^Attack/.test(e.animation)) ??
        entries.find((e) => /Slap|AcidAttack/.test(e.animation)) ??
        entries.find((e) => /Feeding/.test(e.animation));
      cast.push({
        display: SPRITE_DISPLAY[char] ?? char,
        idles: idles.length ? idles : [entries[0].file],
        attack: atk?.file ?? null,
      });
    }
    return cast;
  }
  const SPRITE_CAST = buildSpriteCast();
  const HAS_SPRITE_CARD = SPRITE_CAST.length > 0;
  // The sprite card is one option alongside the text cards.
  const TOTAL_CARDS = MANUAL_CARDS.length + (HAS_SPRITE_CARD ? 1 : 0);
  let loadCardIsSprite = $state(false);
  let spriteSrc = $state(SPRITE_CAST[0]?.idles[0] ?? "");
  let spriteName = $state(SPRITE_CAST[0]?.display ?? "");
  let spriteRole = $state(SPRITE_LORE[SPRITE_CAST[0]?.display ?? ""]?.role ?? "");
  let spriteBlurb = $state(SPRITE_LORE[SPRITE_CAST[0]?.display ?? ""]?.blurb ?? "");

  // Reveal the game only once the studio has played AND a scene exists AND the
  // current card has been up ≥CARD_MIN_MS — so a fast load still shows ~1s
  // studio + ~1s card rather than flashing straight through.
  // Immediate-reveal check (a backstop to the manual-phase poll): reveal only
  // once the studio played, a scene exists, and THIS card has had ≥CARD_MIN_MS.
  function maybeReveal() {
    // On the worker path the WORKER owns the reveal — it cuts over only at a card
    // boundary after Elias' victory (AllByte + ≥1 full card). Deferring to it here
    // prevents this DOM-path timer from revealing early mid-card. The boot
    // watchdog (BOOT_ABSOLUTE_MS) remains the backstop for both paths.
    if (useWorkerLoader && !workerFailed) return;
    if (!(studioDone && sceneReady && loadPhase === "manual")) return;
    if (performance.now() - manualCardShownAt >= CARD_MIN_MS) loading = false;
  }
  function enterManual() {
    loadPhase = "manual";
    manualCardShownAt = performance.now();
    maybeReveal();
  }
  function advanceCard() {
    const prev = loadCardIsSprite ? MANUAL_CARDS.length : loadCard;
    let next = prev;
    if (TOTAL_CARDS > 1) {
      next = (prev + 1 + Math.floor(Math.random() * (TOTAL_CARDS - 1))) % TOTAL_CARDS;
    }
    loadCardIsSprite = HAS_SPRITE_CARD && next === MANUAL_CARDS.length;
    loadCard = loadCardIsSprite ? 0 : next;
    manualCardShownAt = performance.now();
  }
  function isNormalPlayerLoad(): boolean {
    if (typeof window === "undefined") return false;
    if (fixture) return false;
    return !new URLSearchParams(window.location.search).has("scenario");
  }
  // Debug readout (log tail, phase heuristics, MB/file counts) — ?debug ONLY.
  // Off by default even for admins (owner 2026-08-03: the raw panel read as
  // stray dev info on the loading screen); add ?debug to a /play URL to see it.
  const showLoadDebug = $derived(
    typeof window !== "undefined" &&
      new URLSearchParams(window.location.search).has("debug"),
  );

  // --- Worker-rendered load screen (the freeze-proof path) -----------------
  // The whole load sequence is drawn by a Web Worker onto an OffscreenCanvas, so
  // it keeps animating at 60fps even while the main thread is blocked by the
  // WASM compile + Godot boot (which freezes any main-thread/DOM animation).
  // Falls back to the DOM loader below if the browser lacks OffscreenCanvas/
  // Worker (e.g. Safari < 16.4) or if worker setup throws.
  const workerLoaderSupported =
    typeof window !== "undefined" &&
    typeof Worker !== "undefined" &&
    typeof (globalThis as any).OffscreenCanvas !== "undefined" &&
    typeof HTMLCanvasElement !== "undefined" &&
    "transferControlToOffscreen" in HTMLCanvasElement.prototype;
  const useWorkerLoader = $derived(workerLoaderSupported && isNormalPlayerLoad());
  let loadCanvasEl = $state<HTMLCanvasElement | undefined>();
  let loadWorker: Worker | null = null;
  let workerFailed = $state(false);

  function buildWorkerCards() {
    const text = MANUAL_CARDS.map((c) => ({
      kind: "text" as const,
      title: c.title,
      rows: c.rows,
      lines: c.lines,
      quote: c.quote,
    }));
    const sprite: any[] = [];
    if (HAS_SPRITE_CARD) {
      const c = SPRITE_CAST[Math.floor(Math.random() * SPRITE_CAST.length)];
      const lore = SPRITE_LORE[c.display] ?? { role: "", blurb: "" };
      sprite.push({
        kind: "sprite" as const,
        name: c.display,
        role: lore.role,
        blurb: lore.blurb,
        idleUrl: c.idles[0] ?? null,
        attackUrl: c.attack ?? null,
      });
    }
    return [...text, ...sprite];
  }

  $effect(() => {
    if (!(allowed && loading && useWorkerLoader && loadCanvasEl && !loadWorker && !workerFailed)) return;
    try {
      const worker = new LoadScreenWorker();
      worker.onmessage = (ev) => {
        if (ev.data?.type === "reveal") loading = false;
      };
      worker.onerror = () => { workerFailed = true; };
      const off = loadCanvasEl.transferControlToOffscreen();
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      const builtCards = buildWorkerCards();
      worker.postMessage(
        {
          type: "init",
          canvas: off,
          dpr,
          cssW: loadCanvasEl.clientWidth || window.innerWidth,
          cssH: loadCanvasEl.clientHeight || window.innerHeight,
          cards: builtCards,
          isMobile: isMobileViewport(),
          cfg: {
            studioMs: STUDIO_MS,
            studioSettleMs: STUDIO_SETTLE_MS,
            studioFadeMs: STUDIO_FADE_MS,
            cardMs: CARD_MS,
            cardMinMs: CARD_MIN_MS,
          },
        },
        [off],
      );
      loadWorker = worker;

      // The blob worker can't fetch its assets by URL under cross-origin
      // isolation (no-CORP same-origin subresources NetworkError inside it), so
      // fetch them here on the main thread and transfer the bytes/bitmap over.
      // The worker renders immediately with fallbacks and upgrades in place.
      fetch("/fonts/ModernGoth.otf")
        .then((r) => r.arrayBuffer())
        .then((buf) => worker.postMessage({ type: "font", buf }, [buf]))
        .catch(() => {});
      fetch("/loading-icon.png")
        .then((r) => r.blob())
        .then((b) => createImageBitmap(b))
        .then((bmp) => worker.postMessage({ type: "spinner", bmp }, [bmp]))
        .catch(() => {});
      const spriteCard = builtCards.find((c: any) => c.kind === "sprite") as any;
      if (spriteCard) {
        const grab = (u: string | null) =>
          u ? fetch(u).then((r) => r.arrayBuffer()).catch(() => null) : Promise.resolve(null);
        Promise.all([grab(spriteCard.idleUrl), grab(spriteCard.attackUrl)])
          .then(([idle, attack]) => {
            const transfer = [idle, attack].filter(Boolean) as ArrayBuffer[];
            worker.postMessage({ type: "sprite", idle, attack }, transfer);
          })
          .catch(() => {});
      }

      // Poison-trail card-transition assets (fetched here on the main thread —
      // the blob worker can't fetch same-origin subresources under COI).
      Promise.all([
        fetch("/assets/sprites/poison_tile.png").then((r) => r.blob()).then(createImageBitmap),
        fetch("/assets/sprites/poison_tile_empty.png").then((r) => r.blob()).then(createImageBitmap),
      ])
        .then(([poison, empty]) => worker.postMessage({ type: "poisonTiles", poison, empty }, [poison, empty]))
        .catch(() => {});
      fetch("/assets/sprites/slime_IdleDown.gif")
        .then((r) => r.arrayBuffer())
        .then((buf) => worker.postMessage({ type: "poisonSlime", buf }, [buf]))
        .catch(() => {});
      const grabBuf = (u: string) => fetch(u).then((r) => r.arrayBuffer()).catch(() => null);
      Promise.all([
        grabBuf("/assets/sprites/Elias_BattleIdleDownRight.gif"),
        grabBuf("/assets/sprites/Elias_AttackDownRight.gif"),
        grabBuf("/assets/sprites/Elias_Victory.gif"),
      ])
        .then(([idle, attack, victory]) => {
          const transfer = [idle, attack, victory].filter(Boolean) as ArrayBuffer[];
          worker.postMessage({ type: "poisonElias", idle, attack, victory }, transfer);
        })
        .catch(() => {});

      // Feed orientation/size changes to the worker. Without this the
      // OffscreenCanvas keeps its init-time (portrait) backing store on a
      // rotation → a stretched "half screen", and the banner layout never
      // recomputes for landscape. Coalesced to one post per frame.
      let rzPending = false;
      const onLoadResize = () => {
        if (rzPending) return;
        rzPending = true;
        requestAnimationFrame(() => {
          rzPending = false;
          if (!loadWorker || !loadCanvasEl) return;
          loadWorker.postMessage({
            type: "resize",
            dpr: Math.min(2, window.devicePixelRatio || 1),
            cssW: loadCanvasEl.clientWidth || window.innerWidth,
            cssH: loadCanvasEl.clientHeight || window.innerHeight,
            isMobile: isMobileViewport(),
          });
        });
      };
      window.addEventListener("orientationchange", onLoadResize);
      window.addEventListener("resize", onLoadResize);
      return () => {
        window.removeEventListener("orientationchange", onLoadResize);
        window.removeEventListener("resize", onLoadResize);
      };
    } catch {
      workerFailed = true; // fall back to the DOM loader
    }
  });

  // The instant the load screen hides, tell the game so it can start the title
  // music IN SYNC with the visible title (Arc: Title defers Anthem4 until this,
  // with a ~5s fallback). Fires once, on the loading→false transition.
  let loaderRevealSent = false;
  $effect(() => {
    if (!loading && !loaderRevealSent && iframeEl?.contentWindow) {
      loaderRevealSent = true;
      try {
        iframeEl.contentWindow.postMessage({ type: "allbyte_loader_reveal" }, "*");
      } catch {
        /* iframe not ready / cross-origin — the game's fallback covers it */
      }
    }
  });

  // Kick the studio intro the moment a normal player load begins.
  $effect(() => {
    if (allowed && loading && !studioTimerStarted && isNormalPlayerLoad()) {
      studioTimerStarted = true;
      // Pick the first manual card to show after the studio scene.
      const pick = Math.floor(Math.random() * TOTAL_CARDS);
      loadCardIsSprite = HAS_SPRITE_CARD && pick === MANUAL_CARDS.length;
      loadCard = loadCardIsSprite ? 0 : pick;
      startStudioScramble();
      setTimeout(() => (studioFading = true), STUDIO_MS - STUDIO_FADE_MS);
      setTimeout(() => {
        studioDone = true;
        enterManual(); // ALWAYS land on a card ≥1s, even if the game is ready
      }, STUDIO_MS);
    }
  });

  // Drive the living-sprite card: turn in place, swing an attack, then move to
  // another character — looping until the game is revealed. Cleans itself up
  // when `loading` flips false. Honors prefers-reduced-motion (holds one idle).
  $effect(() => {
    if (!(loading && loadCardIsSprite && HAS_SPRITE_CARD)) return;
    const reduce =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

    // Preload every frame so src swaps don't flash.
    for (const c of SPRITE_CAST) {
      for (const f of [...c.idles, c.attack]) {
        if (f) {
          const im = new Image();
          im.src = f;
        }
      }
    }

    let cancelled = false;
    let ci = Math.floor(Math.random() * SPRITE_CAST.length);
    const timers: ReturnType<typeof setTimeout>[] = [];

    function framesFor(c: CastMember): { file: string; ms: number }[] {
      const seq: { file: string; ms: number }[] = [];
      const multi = c.idles.length > 1;
      const hold = multi ? 430 : 1100; // single-idle chars: the GIF itself bobs
      for (const s of c.idles) seq.push({ file: s, ms: hold });
      if (c.attack) seq.push({ file: c.attack, ms: 950 });
      if (multi) {
        for (const s of [...c.idles].reverse().slice(1)) seq.push({ file: s, ms: hold });
      }
      return seq;
    }

    function playCharacter() {
      if (cancelled) return;
      const c = SPRITE_CAST[ci];
      spriteName = c.display;
      spriteRole = SPRITE_LORE[c.display]?.role ?? "";
      spriteBlurb = SPRITE_LORE[c.display]?.blurb ?? "";
      if (reduce) {
        spriteSrc = c.idles[0];
        return; // no looping under reduced motion
      }
      const seq = framesFor(c);
      let fi = 0;
      const step = () => {
        if (cancelled) return;
        if (fi >= seq.length) {
          // Move to a different character.
          ci = (ci + 1 + Math.floor(Math.random() * (SPRITE_CAST.length - 1))) % SPRITE_CAST.length;
          playCharacter();
          return;
        }
        spriteSrc = seq[fi].file;
        const ms = seq[fi].ms;
        fi++;
        timers.push(setTimeout(step, ms));
      };
      step();
    }

    playCharacter();
    return () => {
      cancelled = true;
      timers.forEach(clearTimeout);
    };
  });

  // Manual phase — card rotation + reveal, FREEZE-AWARE. The WASM compile blocks
  // the main thread for a beat or two, freezing JS timers; when it unblocks a
  // naive timer would "catch up" and flip several cards at once. So on any poll
  // where the gap is much larger than the interval (a stall happened), we DON'T
  // count that frozen time — we restart the current card's dwell. Result: every
  // card gets a clean CARD_MS on screen, no post-stall burst. (The gilt dots are
  // a pure-CSS compositor animation and keep moving through the stall — that's
  // the "still working" signal while content is frozen.)
  $effect(() => {
    if (!(loading && loadPhase === "manual" && isNormalPlayerLoad())) return;
    // On the worker path the WORKER owns card rotation AND the reveal (cut over
    // only at a card boundary after Elias' victory) — this DOM poll would reveal
    // early mid-card, so skip it entirely. Boot watchdog stays the backstop.
    if (useWorkerLoader && !workerFailed) return;
    let lastTick = performance.now();
    const id = setInterval(() => {
      const now = performance.now();
      const gap = now - lastTick;
      lastTick = now;
      if (gap > 700) {
        // Main thread was blocked (WASM compile) — give this card a fresh dwell
        // instead of letting frozen time rotate or reveal early.
        manualCardShownAt = now;
        return;
      }
      const onCard = now - manualCardShownAt;
      if (studioDone && sceneReady && onCard >= CARD_MIN_MS) {
        loading = false; // game ready + this card has had ≥1s → show the title
        return;
      }
      if (onCard >= CARD_MS) advanceCard(); // a full 3s on this card → rotate
    }, 200);
    return () => clearInterval(id);
  });

  function pollLoadStatus() {
    loadElapsed = Math.floor((Date.now() - loadStart) / 1000);

    // Absolute boot backstop. This poller stops the instant a scene appears, so
    // reaching here always means "no scene yet" — if we're past the hard ceiling
    // the engine is wedged. Checked before the contentWindow guard so a hard
    // crash (unreadable iframe) still heals. Default build + once-per-session.
    if (
      !recoveryTriggered &&
      !isNonDefaultBuild() &&
      Date.now() - loadStart > BOOT_ABSOLUTE_MS
    ) {
      hardResetAndReload("boot watchdog: no scene within the hard ceiling (stale cached assets?)");
      return;
    }

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
          lastProgressAt = Date.now(); // fresh bytes → boot is still progressing
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

    // Game has reported a scene. The scene NODE existing isn't the same as the
    // title being interactive — the fixed build sends `allbyte_title_ready` when
    // it truly is, and we hold the loader up until then so the title-music
    // (Arc gates it on our loader_reveal) starts in sync with a usable title.
    // Old builds never send it, so a fallback reveals shortly after the scene
    // appears, preserving the previous behavior for cached returning users.
    if (scene) {
      if (sceneFirstSeenAt === 0) {
        sceneFirstSeenAt = Date.now();
        // Verify the SW served the CURRENT build, not a stale cached one.
        checkBuildFreshness((iframeEl?.contentWindow as any)?.gameState?.version);
      }
      const titleInteractive =
        titleReadySignal || Date.now() - sceneFirstSeenAt >= TITLE_READY_FALLBACK_MS;
      if (!titleInteractive) {
        loadStatus = `Loading ${scene}…`;
        return; // engine up but title not interactive yet — keep the loader up
      }
      loadStatus = `Ready: ${scene}`;
      loadPanelVisible = false;
      sceneReady = true;
      loadWorker?.postMessage({ type: "scene" }); // worker decides when to reveal
      maybeReveal(); // DOM-loader fallback path
      startKbNudge(scene);
      stopLoadPolling();
      return;
    }

    // Still no scene. If nothing has progressed for the whole grace window, the
    // engine is wedged — a mismatched cached wasm/pck pair that trapped during
    // instantiation, which scanForEngineCrash can't see. Self-heal once. Gated
    // to the DEFAULT build; self-versioned channels (develop/beta/scenario)
    // legitimately differ in version and must never trigger this.
    if (
      !recoveryTriggered &&
      !isNonDefaultBuild() &&
      Date.now() - lastProgressAt > BOOT_STALL_MS
    ) {
      hardResetAndReload("boot watchdog: engine never reached a scene (stale cached assets?)");
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

<div class="godot-container" bind:this={containerEl} style:cursor={letterboxCursor}>
  {#if mobileFs && allowed && !isFullscreen}
    <!-- Mobile fullscreen is parent-owned (the touch gamepad lives out here, not
         in the iframe). Default is auto-on; this button re-enters after the user
         has left it (a real parent-gesture tap — Android rejects in-iframe ones). -->
    <button class="fs-reenter" onclick={reenterFullscreen} aria-label="Enter fullscreen" title="Fullscreen">⛶</button>
  {/if}
  {#if fsDebug}
    <div
      style="position:fixed;top:0;left:0;right:0;z-index:99999;background:#7f1d1d;color:#fff;font:12px/1.4 monospace;padding:6px 8px;word-break:break-word;"
    >
      {fsDebug}
    </div>
  {/if}
  {#if brOpen}
    <BugReportOverlay
      context={brCtx}
      status={brStatus}
      error={brError}
      onSend={brSubmit}
      onCancel={brClose}
    />
  {/if}
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
  {:else if !allowed}
    <!-- INSTANT BOOT SHELL. `allowed` only flips inside onMount, and the
         download gate was retired 2026-08-03, so without this branch the
         component rendered NOTHING between navigation and hydration — the
         "unexplained black interval before the AllByte mark" in the recorded
         launch. Black reads as failed navigation, not as a cinematic beat.

         This paints the ground and the identity on the very first frame, from
         the thin browser shell, with no dependency on Godot, the worker, or
         any async work. It is the SAME markup the studio phase uses, so when
         `allowed` flips the bits simply start scrambling in place — no remount,
         no flash, no second transition. -->
    <div class="loading-screen studio-screen">
      <div class="studio-mark">
        <div class="studio-bits" aria-hidden="true">
          {#each studioBits as b}<span class="studio-bit">{b}</span>{/each}
        </div>
        <div class="studio-word">All&nbsp;Byte</div>
      </div>
    </div>
  {:else}
    {#if loading && useWorkerLoader && !workerFailed}
      <!-- Freeze-proof load screen: the whole sequence is drawn by a Web Worker
           on this OffscreenCanvas, so it never stalls during the WASM boot. -->
      <canvas class="worker-load" bind:this={loadCanvasEl}></canvas>
    {:else if loading}
      {#if loadPhase === "studio"}
        <!-- Phase 1: AllByte studio intro, full-screen ~STUDIO_MS. Eight bits
             (one per char of "All Byte", the space included = a Byte) flip 0/1,
             slow, stop, then fade — all ModernGoth. -->
        <div class="loading-screen studio-screen">
          <div class="studio-mark" class:fading={studioFading}>
            <div class="studio-bits" aria-hidden="true">
              {#each studioBits as b}<span class="studio-bit">{b}</span>{/each}
            </div>
            <div class="studio-word">All&nbsp;Byte</div>
          </div>
        </div>
      {:else}
        <!-- Phase 2: Chronicles-themed manual card + accurate progress tracker -->
        <div class="loading-screen manual-screen">
          {#if loadCardIsSprite}
            <!-- Living-manual card: a handcrafted sprite turns + attacks -->
            <div class="manual-card sprite-card">
              <div class="manual-kicker">From the world of Nesis</div>
              <div class="sprite-stage">
                <img class="sprite-actor" src={spriteSrc} alt={spriteName} />
              </div>
              <h2 class="sprite-name">{spriteName}</h2>
              {#if spriteRole}
                <div class="sprite-role">{spriteRole}</div>
              {/if}
              {#if spriteBlurb}
                <p class="sprite-blurb">{spriteBlurb}</p>
              {/if}
            </div>
          {:else}
            {@const card = MANUAL_CARDS[loadCard]}
            <div class="manual-card">
              <div class="manual-kicker">From the Manual</div>
              <h2 class="manual-card-title">{card.title}</h2>
              {#if card.lines}
                <div class="manual-lines">
                  {#each card.lines as line}
                    <p class="manual-line">{line}</p>
                  {/each}
                </div>
              {/if}
              {#if card.rows}
                <dl class="manual-rows">
                  {#each card.rows as [term, desc]}
                    <div class="manual-row">
                      <dt>{term}</dt>
                      <dd>{desc}</dd>
                    </div>
                  {/each}
                </dl>
              {/if}
              {#if card.quote}
                <p class="manual-quote">&ldquo;{card.quote}&rdquo;</p>
              {/if}
            </div>
          {/if}
          <div class="load-dots" role="status" aria-label="Loading">
            <span class="load-dot"></span>
            <span class="load-dot"></span>
            <span class="load-dot"></span>
          </div>
        </div>
      {/if}
    {/if}
    {#if showStartTap}
      <!-- Transparent, full-area tap catcher: the loading screen (studio +
           manual cards) shows through, with a hovering prompt over it. The tap
           enters fullscreen (iOS requires a gesture) and unlocks audio. -->
      <button class="start-tap" onclick={startTapPlay} aria-label="Tap for fullscreen">
        <span class="start-tap-pill">
          <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
            <path
              d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
              fill="none"
              stroke="currentColor"
              stroke-width="2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
          Tap for fullscreen
        </span>
      </button>
    {/if}
    <!-- Held back until a tier-gated deep-link knows which build it wants. An
         iframe with no src loads about:blank, which would fire onLoad (and so
         runScenario) against a document that will be replaced. -->
    {#if gameUrl}
      <iframe
        bind:this={iframeEl}
        src={gameSrc(gameUrl)}
        title="The Chronicles of Nesis"
        class="game-frame"
        onload={onLoad}
        onerror={onError}
        allow="cross-origin-isolated; fullscreen"
      ></iframe>
    {/if}
    <VirtualGamepad iframe={iframeEl} />
    {#if manualPanelEnabled}
      <ManualLetterboxPanel />
    {/if}
    {#if showKbHint}
      <div class="kb-hint-layer kb-hint-{kbHintPos}">
        <div
          class="kb-hint"
          role="status"
          aria-live="polite"
          aria-label="Suggested: W A S D plus mouse left and right click, or W A S D plus K O L semicolon"
        >
          <div class="kb-hint-row">
            <span class="kb-hint-text">Suggested:&nbsp;</span>
            <span class="kb-keys">
              <img src="/keys/keyboard_w.png" alt="" />
              <img src="/keys/keyboard_a.png" alt="" />
              <img src="/keys/keyboard_s.png" alt="" />
              <img src="/keys/keyboard_d.png" alt="" />
              <span class="kb-hint-text">+</span>
              <img src="/keys/mouse_left.png" alt="" />
              <img src="/keys/mouse_right.png" alt="" />
            </span>
          </div>
          <div class="kb-hint-row">
            <span class="kb-hint-text">or</span>
          </div>
          <div class="kb-hint-row">
            <span class="kb-keys">
              <img src="/keys/keyboard_w.png" alt="" />
              <img src="/keys/keyboard_a.png" alt="" />
              <img src="/keys/keyboard_s.png" alt="" />
              <img src="/keys/keyboard_d.png" alt="" />
              <span class="kb-hint-text">+</span>
              <img src="/keys/keyboard_k.png" alt="" />
              <img src="/keys/keyboard_o.png" alt="" />
              <img src="/keys/keyboard_l.png" alt="" />
              <img src="/keys/keyboard_semicolon.png" alt="" />
            </span>
          </div>
        </div>
      </div>
    {/if}
    {#if loadPanelVisible && showLoadDebug}
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

  <!-- End of the Episode 1 credits: the one moment someone has actually
       finished the game and is most likely to want to hear about the next one.
       Overlays the game; the game keeps routing to Title underneath, so
       dismissing this drops them exactly where they would have been. -->
  {#if creditsSignupOpen}
    <div class="credits-signup" role="dialog" aria-modal="false" aria-label="Get notified about Episode 2">
      <div class="credits-signup-card">
        <button class="credits-signup-close" onclick={() => (creditsSignupOpen = false)}
                aria-label="Dismiss">×</button>
        <EmailSignup
          source="ep1_credits"
          variant="overlay"
          heading="That was Episode 1"
          blurb="Episode 2 is being built now. Leave your email and I will write once, on the day it is playable."
          cta="Tell me"
          ondone={() => setTimeout(() => (creditsSignupOpen = false), 2200)}
        />
      </div>
    </div>
  {/if}
</div>

<style>
  /* Bug-report overlay styles (markup in BugReportOverlay.svelte). They live HERE
     because that child component's own scoped <style> was being dropped from the
     client:load island bundle (scope class shipped, rules didn't → unstyled,
     black-on-dark, pushed the page down). GodotEmbed's own <style> reliably ships,
     so we style the overlay by class via :global. Element selectors are qualified
     under .br-modal so they can't leak to other inputs on the page. */
  :global {
    .br-backdrop {
      position: fixed; inset: 0; z-index: 100000;
      background: rgba(3, 6, 12, 0.72);
      display: flex; justify-content: center; align-items: flex-start;
      padding: 8vh 1rem 1rem; overflow-y: auto;
    }
    .br-modal {
      width: 100%; max-width: 460px; background: #131a26; color: #e7ecf5;
      border: 1px solid rgba(167, 243, 208, 0.25); border-radius: 10px;
      padding: 1rem 1.1rem 1.15rem; box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
      font-family: system-ui, -apple-system, sans-serif;
    }
    .br-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
    .br-head h2 { margin: 0; font-size: 1.15rem; color: #a7f3d0; }
    .br-x { background: none; border: none; color: rgba(231, 236, 245, 0.6); font-size: 1.6rem; line-height: 1; cursor: pointer; padding: 0 0.2rem; }
    .br-x:hover { color: #e7ecf5; }
    .br-lbl { display: block; font-size: 0.82rem; color: rgba(231, 236, 245, 0.7); margin: 0.4rem 0 0.25rem; }
    .br-modal textarea, .br-modal select {
      width: 100%; font-size: 16px; font-family: inherit; color: #e7ecf5;
      background: #0a0e17; border: 1px solid rgba(167, 243, 208, 0.25);
      border-radius: 6px; padding: 0.55rem 0.6rem; box-sizing: border-box;
    }
    .br-modal textarea { resize: vertical; min-height: 5.5rem; line-height: 1.45; }
    .br-modal textarea:focus, .br-modal select:focus { outline: none; border-color: #a7f3d0; }
    .br-row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
    .br-row .br-lbl { margin: 0; flex-shrink: 0; }
    .br-row select { width: auto; flex: 1; }
    .br-ctx { font-size: 0.74rem; color: rgba(231, 236, 245, 0.5); margin: 0.55rem 0 0; }
    .br-ctx b { color: #a7f3d0; }
    .br-err { font-size: 0.82rem; color: #fca5a5; margin: 0.55rem 0 0; }
    .br-ok { font-size: 1rem; color: #a7f3d0; text-align: center; padding: 1.2rem 0; margin: 0; }
    .br-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 0.9rem; }
    .br-btn { font-family: inherit; font-size: 0.9rem; padding: 0.5rem 1rem; border-radius: 6px; cursor: pointer; border: 1px solid transparent; }
    .br-btn:disabled { opacity: 0.5; cursor: default; }
    .br-btn.ghost { background: transparent; color: rgba(231, 236, 245, 0.75); border-color: rgba(231, 236, 245, 0.25); }
    .br-btn.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); }
    .br-btn.primary { background: #a7f3d0; color: #0a0e17; font-weight: 700; }
    .br-btn.primary:hover:not(:disabled) { background: #bef7de; }

    /* Landscape fallback — the overlay tries to rotate the device to portrait, but
       iOS Safari has no screen.orientation.lock (and there's a beat before Android
       rotates). Tighten the modal so it still fits a short landscape height. */
    @media (orientation: landscape) and (max-height: 520px) {
      .br-backdrop { padding: 2vh 1rem 1rem; }
      .br-modal { max-width: 640px; }
      .br-modal textarea { min-height: 3rem; }
    }
  }

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
  .fs-reenter {
    position: absolute;
    top: max(8px, env(safe-area-inset-top));
    right: max(8px, env(safe-area-inset-right));
    z-index: 40;
    width: 40px;
    height: 40px;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: 1.25rem;
    line-height: 1;
    color: #e5e7eb;
    background: rgba(15, 23, 42, 0.62);
    border: 1px solid rgba(148, 163, 184, 0.35);
    border-radius: 8px;
    cursor: pointer;
    -webkit-tap-highlight-color: transparent;
  }
  .fs-reenter:active { background: rgba(15, 23, 42, 0.9); }

  .worker-load {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    display: block;
    z-index: 2;
    background: #050608;
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

  /* Mobile start layer — a guaranteed parent-page tap so fullscreen can enter
     (Android rejects fullscreen driven from inside the game iframe). Sits above
     the iframe + VirtualGamepad (z-index 5) while the game preloads behind it. */
  /* Transparent tap catcher — the loading art shows through; only the pill
     is visible. The whole area is tappable. */
  .start-tap {
    position: absolute;
    inset: 0;
    z-index: 50;
    width: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-start;
    border: none;
    background: transparent;
    color: #f6eccf;
    cursor: pointer;
    padding: 0;
    -webkit-tap-highlight-color: transparent;
  }
  .start-tap-pill {
    margin-top: clamp(14px, 5vh, 40px);
    display: inline-flex;
    align-items: center;
    gap: 0.55em;
    padding: 0.5rem 1.05rem;
    border-radius: 999px;
    background: rgba(10, 14, 23, 0.82);
    border: 1px solid rgba(231, 184, 102, 0.5);
    color: #f6eccf;
    font-family: "Courier New", monospace;
    font-size: 0.76rem;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.5);
    animation: startPulse 1.9s ease-in-out infinite;
  }
  .start-tap-pill svg {
    flex: 0 0 auto;
    color: #e7b866;
  }
  @keyframes startPulse {
    0%, 100% { opacity: 0.62; }
    50% { opacity: 1; }
  }

  .loading-title {
    font-size: 1.5rem;
    font-weight: 700;
    margin-bottom: 0.5rem;
  }

  .loading-note {
    margin-top: 2rem;
    font-size: 0.85rem;
    opacity: 0.6;
    color: #f87171;
  }

  /* ---- Phase 1: AllByte studio intro — 8 bits over "All Byte" ------------ */
  .studio-screen {
    background: #050608;
  }
  .studio-mark {
    display: inline-flex;
    flex-direction: column;
    align-items: stretch; /* bits row + word share the same (word) width */
    /* NO fade-in. The identity must be legible on the first painted frame —
       a 0.35s ramp from opacity:0 delays acknowledgement of the click, which
       is the one thing this screen exists to provide. The scale settle is
       kept because it starts fully opaque and reads as arrival rather than
       as waiting. */
    animation: studioIn 0.28s ease-out both;
    transition: opacity 0.2s ease-in;
  }
  .studio-mark.fading {
    opacity: 0;
  }
  /* 8 bits (a Byte) spread equidistantly across the exact width of "All Byte" */
  .studio-bits {
    display: flex;
    justify-content: space-between;
    margin-bottom: clamp(0.3rem, 1.4vw, 0.6rem);
    padding: 0 0.08em;
  }
  .studio-bit {
    font-family: "AllByteCustom", Georgia, serif;
    font-size: clamp(0.95rem, 3vw, 1.7rem);
    line-height: 1;
    color: #f4ecd6;
  }
  .studio-word {
    font-family: "AllByteCustom", Georgia, serif;
    font-size: clamp(2.6rem, 9vw, 5rem);
    line-height: 1;
    color: #f4ecd6;
    text-align: center;
    white-space: nowrap;
    text-shadow: 0 2px 28px rgba(212, 175, 96, 0.28);
  }
  @keyframes studioIn {
    0% {
      opacity: 1;
      transform: scale(0.985);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .studio-mark {
      animation: none;
    }
  }

  /* ---- Phase 2: Chronicles-themed manual card + tracker ------------------ */
  .manual-screen {
    background:
      radial-gradient(
        130% 120% at 50% 0%,
        #201812 0%,
        #17110c 55%,
        #0e0a07 100%
      );
    color: #ece0c4;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    justify-content: space-between;
    padding: clamp(1.5rem, 5vh, 3.5rem) 1.25rem clamp(1.1rem, 3vh, 2rem);
    gap: 1.5rem;
    /* soft appearance as the studio scene fades out */
    animation: screenFade 0.3s ease both;
  }
  @keyframes screenFade {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .manual-screen {
      animation: none;
    }
  }
  .manual-card {
    flex: 1;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    text-align: center;
    max-width: 44rem;
    width: 100%;
    margin: 0 auto;
  }
  .manual-kicker {
    font-family: "Courier New", monospace;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.34em;
    text-indent: 0.34em;
    color: #c69a4c;
    opacity: 0.85;
    margin-bottom: 0.85rem;
  }
  .manual-card-title {
    font-size: clamp(1.8rem, 5.5vw, 3rem);
    line-height: 1.05;
    margin: 0 0 1.15rem;
    color: #f6eccf;
    text-shadow: 0 2px 20px rgba(0, 0, 0, 0.45);
  }
  .manual-lines {
    display: flex;
    flex-direction: column;
    gap: 0.7rem;
    max-width: 38rem;
  }
  .manual-line {
    margin: 0;
    font-size: clamp(1rem, 2.4vw, 1.2rem);
    line-height: 1.5;
    color: #d9cba9;
  }
  .manual-rows {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
    margin: 0;
    width: 100%;
    max-width: 34rem;
  }
  .manual-row {
    display: grid;
    grid-template-columns: minmax(6.5rem, 34%) 1fr;
    gap: 0.9rem;
    align-items: baseline;
    text-align: left;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(198, 154, 76, 0.16);
  }
  .manual-row dt {
    font-weight: 700;
    color: #e7b866;
    font-size: clamp(0.95rem, 2.2vw, 1.12rem);
  }
  .manual-row dd {
    margin: 0;
    color: #cdbf9e;
    font-size: clamp(0.9rem, 2.1vw, 1.05rem);
    line-height: 1.35;
  }
  .manual-quote {
    margin: 1.3rem 0 0;
    font-style: italic;
    font-size: clamp(1.05rem, 2.6vw, 1.3rem);
    color: #e7b866;
    max-width: 34rem;
  }

  /* Living-manual sprite card */
  .sprite-card {
    gap: 0.4rem;
  }
  .sprite-stage {
    display: flex;
    align-items: flex-end;
    justify-content: center;
    height: clamp(190px, 34vh, 300px);
    margin: 0.6rem 0 0.9rem;
  }
  .sprite-actor {
    height: 100%;
    width: auto;
    max-width: 100%;
    object-fit: contain;
    image-rendering: pixelated;
    /* Grounding shadow so the sprite reads as standing in the card. */
    filter: drop-shadow(0 10px 10px rgba(0, 0, 0, 0.45));
  }
  .sprite-name {
    font-size: clamp(1.6rem, 4.5vw, 2.4rem);
    line-height: 1;
    margin: 0;
    color: #f6eccf;
    text-shadow: 0 2px 20px rgba(0, 0, 0, 0.45);
  }
  .sprite-role {
    font-family: "Courier New", monospace;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.24em;
    text-indent: 0.24em;
    color: #c69a4c;
    margin-top: 0.5rem;
  }
  .sprite-blurb {
    max-width: 30rem;
    margin: 0.7rem auto 0;
    /* Reserve ~2 lines so the card doesn't jump when the character changes. */
    min-height: 2.9em;
    font-size: clamp(0.95rem, 2.2vw, 1.1rem);
    line-height: 1.45;
    color: #d9cba9;
  }
  .manual-card {
    min-height: 0; /* let the card shrink inside the flex column, never push the tracker off */
  }

  /* Short viewports (landscape phones): a 6-row card + big title won't fit
     390px tall, so compress everything and shrink the sprite so the card
     never collides with the bottom tracker. Keyed on height so it also
     covers a mid-load rotation into landscape. */
  @media (max-height: 540px) {
    .manual-screen {
      padding: 0.9rem 1rem 0.8rem;
      gap: 0.7rem;
    }
    .manual-kicker {
      margin-bottom: 0.4rem;
      font-size: 0.62rem;
    }
    .manual-card-title {
      font-size: clamp(1.15rem, 3.4vw, 1.7rem);
      margin-bottom: 0.55rem;
    }
    .manual-lines {
      gap: 0.4rem;
    }
    .manual-line {
      font-size: clamp(0.82rem, 1.9vw, 0.98rem);
      line-height: 1.35;
    }
    .manual-rows {
      gap: 0.28rem;
    }
    .manual-row {
      padding-bottom: 0.28rem;
    }
    .manual-row dt {
      font-size: clamp(0.8rem, 1.9vw, 0.95rem);
    }
    .manual-row dd {
      font-size: clamp(0.78rem, 1.8vw, 0.92rem);
      line-height: 1.25;
    }
    .manual-quote {
      margin-top: 0.7rem;
      font-size: clamp(0.92rem, 2vw, 1.05rem);
    }
    .sprite-stage {
      height: clamp(96px, 24vh, 150px);
      margin: 0.2rem 0 0.4rem;
    }
    .sprite-name {
      font-size: clamp(1.2rem, 3.6vw, 1.7rem);
    }
    .sprite-role {
      margin-top: 0.3rem;
    }
    .sprite-blurb {
      margin-top: 0.4rem;
      min-height: 0;
      font-size: clamp(0.82rem, 1.9vw, 0.98rem);
      line-height: 1.35;
    }
  }

  /* 3-dot "still working" pulse — three gilt dots brighten in sequence. It uses
     ONLY opacity + transform (+ will-change) so it runs on the COMPOSITOR thread
     and keeps animating even while the WASM compile blocks the main thread — the
     one moving thing when the cards themselves are frozen. */
  .load-dots {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.7rem;
    margin: 0 auto;
  }
  .load-dot {
    width: 9px;
    height: 9px;
    border-radius: 50%;
    background: #e7b866;
    opacity: 0.25;
    will-change: opacity, transform;
    animation: loadDot 1.5s ease-in-out infinite;
  }
  .load-dot:nth-child(2) {
    animation-delay: 0.25s;
  }
  .load-dot:nth-child(3) {
    animation-delay: 0.5s;
  }
  @keyframes loadDot {
    0%, 60%, 100% {
      opacity: 0.25;
      transform: scale(0.82);
    }
    30% {
      opacity: 1;
      transform: scale(1.15);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .load-dot {
      animation: none;
      opacity: 0.55;
    }
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
    /* Three stacked rows (combo / "or" / combo) — a single-line pill grew
       wide enough to cover the Title menu's Quit button. */
    display: inline-flex;
    flex-direction: column;
    align-items: center;
    gap: 0.15rem;
    padding: 0.45rem 0.95rem;
    background: rgba(10, 14, 23, 0.92);
    border: 1.5px solid #a7f3d0;
    border-radius: 14px;
    box-shadow: 0 0 18px rgba(167, 243, 208, 0.4);
    white-space: nowrap;
    animation: kbHintBounceY 1.15s ease-in-out infinite,
      kbHintFadeIn 0.3s ease-out;
  }
  .kb-hint-row {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
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

  /* Episode 2 notify overlay, shown at the end of the Ep1 credits. Sits over
     the game rather than replacing it: the game routes on to Title underneath,
     so dismissing leaves the player exactly where they would have been. */
  .credits-signup {
    position: absolute; inset: 0; z-index: 40;
    display: flex; align-items: center; justify-content: center;
    padding: 1.2rem;
    background: rgba(8, 6, 3, 0.78);
    backdrop-filter: blur(2px);
  }
  .credits-signup-card {
    position: relative;
    max-width: 33rem; width: 100%;
    padding: 1.5rem 1.6rem 1.3rem;
    background: rgba(20, 15, 8, 0.96);
    border: 1px solid rgba(230, 200, 119, 0.35);
    border-radius: 3px;
    box-shadow: 0 18px 50px rgba(0, 0, 0, 0.6);
    font-family: Georgia, "Times New Roman", serif;
  }
  .credits-signup-close {
    position: absolute; top: 0.35rem; right: 0.5rem;
    background: none; border: 0; cursor: pointer;
    font-size: 1.5rem; line-height: 1;
    color: rgba(232, 226, 212, 0.55);
    padding: 0.2rem 0.4rem;
  }
  .credits-signup-close:hover { color: #e6c877; }
  @media (max-width: 520px) {
    .credits-signup { padding: 0.7rem; }
    .credits-signup-card { padding: 1.2rem 1rem 1rem; }
  }
</style>
