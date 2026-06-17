<script lang="ts">
  import EnginePanel from "./EnginePanel.svelte";
  import HeartPanel from "./HeartPanel.svelte";
  import VirtualGamepad from "./VirtualGamepad.svelte";
  import MilestoneBadge from "./MilestoneBadge.svelte";
  import gameVersion from "../data/game-version.json";
  import { auth, initAuth, logout, oauthLogin, saveNotificationPrefs } from "../lib/auth.svelte.ts";
  import { initSaveBridge, teardownSaveBridge } from "../lib/saves.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import { subscribeToFile } from "../lib/testEvents";
  import { onMount } from "svelte";

  let isMobile = $state(false);
  let showLoginModal = $state(false);
  let loginError = $state("");
  let oauthLoading = $state<"google" | "discord" | "patreon" | null>(null);
  let pendingAction = $state<string | null>(null);

  function startOAuth(provider: "google" | "discord" | "patreon") {
    if (oauthLoading) return;
    if (pendingAction) sessionStorage.setItem("allbyte_pending_action", pendingAction);
    oauthLoading = provider;
    oauthLogin(provider);
  }
  let modalEl = $state<HTMLDivElement | null>(null);
  let lastFocusedTrigger: HTMLElement | null = null;

  function openLoginModal(e?: Event) {
    pendingAction = null;
    lastFocusedTrigger = (e?.currentTarget as HTMLElement) || (document.activeElement as HTMLElement);
    showLoginModal = true;
  }

  function closeLoginModal() {
    showLoginModal = false;
    if (lastFocusedTrigger) {
      setTimeout(() => lastFocusedTrigger?.focus(), 0);
    }
  }

  $effect(() => {
    if (!showLoginModal || !modalEl) return;
    // Move focus to first focusable element in modal
    setTimeout(() => {
      const first = modalEl?.querySelector<HTMLElement>(
        'input, button, [tabindex]:not([tabindex="-1"])'
      );
      first?.focus();
    }, 0);

    function handleKey(e: KeyboardEvent) {
      if (!modalEl) return;
      if (e.key === "Escape") {
        e.preventDefault();
        closeLoginModal();
        return;
      }
      if (e.key !== "Tab") return;
      const focusable = Array.from(
        modalEl.querySelectorAll<HTMLElement>(
          'input:not([disabled]), button:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
        )
      );
      if (focusable.length === 0) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  });
  let demoHovered = $state(false);
  let playMode = $state(false);
  let gameUrl = $state("");
  let gameIframe = $state<HTMLIFrameElement | null>(null);

  // PWA install prompt: Chrome/Edge fires `beforeinstallprompt` on
  // browsers/devices that meet the PWA install criteria (manifest valid,
  // SW active, served over HTTPS, not already installed). We capture and
  // defer the event so the user can trigger it from our own button rather
  // than the browser's subtle URL-bar icon. iOS Safari and Firefox don't
  // fire this event — the button just stays hidden there.
  let installPrompt = $state<any>(null);
  let isInstalled = $state(false);

  onMount(() => {
    function handleBeforeInstall(e: Event) {
      e.preventDefault();
      installPrompt = e;
    }
    function handleAppInstalled() {
      isInstalled = true;
      installPrompt = null;
    }
    // Detect "already running as installed PWA" — don't offer install
    // when the page is launched from the home screen / app launcher.
    if (typeof window !== "undefined") {
      try {
        if (window.matchMedia("(display-mode: standalone)").matches) {
          isInstalled = true;
        }
      } catch {}
    }
    window.addEventListener("beforeinstallprompt", handleBeforeInstall);
    window.addEventListener("appinstalled", handleAppInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstall);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  });

  async function handleInstallClick() {
    if (!installPrompt) return;
    try {
      installPrompt.prompt();
      await installPrompt.userChoice;
    } catch {
      // User dismissed or browser rejected — just clear state.
    }
    // The deferred prompt can only be used once. Either appinstalled fires
    // (-> isInstalled = true, button hides) or it doesn't (user dismissed,
    // but the event is spent — we clear so the button doesn't relinger).
    installPrompt = null;
  }

  function launchGame() {
    gameUrl = "/godot/index.html";
    playMode = true;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handlePlayKey);
    // Request fullscreen + lock landscape. Best-effort:
    //   - Android Chrome: both succeed; user lands in full-screen landscape.
    //   - Desktop: fullscreen requests OK, orientation.lock is a no-op.
    //   - iOS Safari: fullscreen partial (16+) and orientation.lock is
    //     unsupported in a browser tab. Both throws caught silently — iOS
    //     users get a playable game without forced orientation. The PWA
    //     install path (Add to Home Screen) is iOS's escape hatch — the
    //     manifest's "orientation": "landscape" is respected there.
    requestFullscreenLandscape();
  }

  /** True for touch devices on phone/small-tablet screens. Same gate the
   *  VirtualGamepad uses, so fullscreen + virtual controls turn on
   *  together. Owner spec: "Fullscreen should be default on mobile
   *  browser and mobile PWA, but not assumed on desktop browser or
   *  desktop PWA." Desktop users can still F11 if they want it. */
  function isMobileViewport(): boolean {
    if (typeof window === "undefined" || !window.matchMedia) return false;
    return window.matchMedia("(pointer: coarse) and (max-width: 1100px)").matches;
  }

  async function requestFullscreenLandscape() {
    if (!isMobileViewport()) return;
    try {
      const el = document.documentElement;
      if (el.requestFullscreen) {
        await el.requestFullscreen();
      }
    } catch {
      /* user denied or unsupported — game still works windowed */
    }
    try {
      const orientation = (screen as any).orientation;
      if (orientation && typeof orientation.lock === "function") {
        await orientation.lock("landscape");
      }
    } catch {
      /* not supported (iOS Safari) or denied — game still works in current orientation */
    }
  }

  function exitGame() {
    playMode = false;
    gameUrl = "";
    document.body.style.overflow = "";
    window.removeEventListener("keydown", handlePlayKey);
    teardownSaveBridge();
    gameIframe = null;
    // Reverse the fullscreen/orientation lock from launchGame so the rest
    // of the site renders in its normal viewport. Both unlock/exit are
    // no-ops if we never entered the locked/fullscreen state.
    try {
      const orientation = (screen as any).orientation;
      if (orientation && typeof orientation.unlock === "function") {
        orientation.unlock();
      }
    } catch {}
    try {
      if (document.fullscreenElement && document.exitFullscreen) {
        document.exitFullscreen().catch(() => {});
      }
    } catch {}
  }

  // Wire up the save bridge once the iframe is mounted
  $effect(() => {
    if (playMode && gameIframe) {
      initSaveBridge(gameIframe, { onExit: exitGame });
    }
  });

  function handlePlayKey(e: KeyboardEvent) {
    if (e.key === "Escape") exitGame();
  }

  // Dev-only: live-reload the game iframe when Arc redeploys via SSE signal.
  let reloadUnsub: (() => void) | null = null;
  let reloadReadyResolve: (() => void) | null = null;

  function doGameReload() {
    if (!playMode || !gameIframe) return;
    console.log("[godot-reload] SSE event received, reloading game iframe");
    gameIframe.contentWindow?.postMessage({ type: "allbyte:prepare-reload" }, "*");
    const timeout = setTimeout(finishReload, 2000);
    reloadReadyResolve = () => { clearTimeout(timeout); finishReload(); };
  }

  function finishReload() {
    reloadReadyResolve = null;
    if (!gameIframe) return;
    gameUrl = `/godot/index.html?t=${Date.now()}`;
  }

  function onGameMessage(ev: MessageEvent) {
    if (!gameIframe || ev.source !== gameIframe.contentWindow) return;
    if (ev.data?.type === "allbyte:reload-ready" && reloadReadyResolve) {
      reloadReadyResolve();
    }
  }

  onMount(() => {
    if (!import.meta.env.DEV) return;
    reloadUnsub = subscribeToFile("godot/reload", doGameReload);
    window.addEventListener("message", onGameMessage);
    return () => {
      reloadUnsub?.();
      window.removeEventListener("message", onGameMessage);
    };
  });
  let artworkHovered = $state(false);
  let musicHovered = $state(false);
  let fontHovered = $state(false);

  let notifySaving = $state(false);

  // Owner spec (2026-06-01): "let's change the Email Me Updates to just
  // flag people boolean wanting updates.. no need for the checkbox flow."
  // The per-category checkbox UI was overkill; subscribed/unsubscribed
  // is the only signal that actually drives behavior right now. Backend
  // still stores Record<string, boolean>, so we set every known category
  // to true on subscribe and null on unsubscribe — preserves the wire
  // contract without changing Lambdas.
  const ALL_NOTIFY_CATEGORIES = [
    "chronicles", "godot-and-claude", "studio", "music", "artwork", "fonts",
  ];

  async function toggleSubscribed() {
    if (notifySaving) return;
    notifySaving = true;
    const isSubscribed = !!auth.currentUser?.notificationPreferences;
    const newPrefs = isSubscribed
      ? null
      : Object.fromEntries(ALL_NOTIFY_CATEGORIES.map((k) => [k, true]));
    await saveNotificationPrefs(newPrefs);
    notifySaving = false;
  }

  let { devlogTotal = 0, artCounts = { music: 0, artwork: 0 } } = $props();

  let cursorAudio;
  let audioReady = false;

  function checkMobile() {
    isMobile = window.innerWidth < 768;
  }

  function initAudio() {
    if (audioReady) return;
    audioReady = true;
    cursorAudio = new Audio("/cursor-move.wav");
    cursorAudio.volume = 0.21;
    // Play and immediately pause to unlock playback in the same gesture.
    cursorAudio.play().then(() => { cursorAudio.pause(); cursorAudio.currentTime = 0; }).catch(() => {});
  }

  $effect(() => {
    checkMobile();
    initAuth();
    window.addEventListener("resize", checkMobile);
    window.addEventListener("click", initAudio, { once: true });
    window.addEventListener("touchstart", initAudio, { once: true });

    return () => {
      window.removeEventListener("resize", checkMobile);
      if (cursorAudio) { cursorAudio.pause(); }
    };
  });

  function handleSubscribeClick(e: Event) {
    if (!auth.currentUser) {
      e.preventDefault();
      lastFocusedTrigger = e.currentTarget as HTMLElement;
      pendingAction = "subscribe";
      showLoginModal = true;
    }
  }


  function onDemoEnter() {
    demoHovered = true;
  }

  function onDemoLeave() {
    demoHovered = false;
  }

  function playCursor() {
    if (cursorAudio && audioReady) {
      cursorAudio.currentTime = 0;
      cursorAudio.play().catch(() => {});
    }
  }
</script>

<div class="page">
  <header class="site-header">
    <div class="header-row">
      <div class="header-left">
      </div>
      <h1 class="site-title">
        <img src="/icon.png" alt="" class="site-icon" />
        AllByte Studios
      </h1>
      <div class="header-right">
        <div class="header-right-buttons">
          {#if isAdmin(auth.currentUser)}
            <a href="/admin/users/" class="header-btn admin-btn" title="Admin user management"><span>Admin</span><span>Users</span></a>
          {/if}
          <a href="/subscribe/" class="header-btn subscribe-btn" onclick={handleSubscribeClick}><span>Subscribe</span><span>Donate</span></a>
          {#if auth.currentUser}
            <button class="header-btn login-btn" onclick={logout}><span>Sign</span><span>Out</span></button>
          {:else}
            <button class="header-btn login-btn" onclick={openLoginModal}><span>Log In</span><span>Sign Up</span></button>
          {/if}
        </div>
        {#if auth.currentUser}
          <span class="username">
            <img src={auth.currentUser.tier === "admin" ? "/tier-admin.png" : auth.currentUser.tier === "legend" ? "/tier-legend.png" : auth.currentUser.tier === "hero" ? "/tier-hero.png" : auth.currentUser.tier === "initiate" ? "/tier-initiate.png" : "/tier-none.png"} alt="" class="user-tier-icon" />
            {auth.currentUser.username}
          </span>
        {/if}
      </div>
    </div>
    <p class="site-tagline">Indie game studio, Devlog, Asset archive</p>
  </header>

  {#if showLoginModal}
    <div class="modal-overlay" onclick={closeLoginModal} role="presentation">
      <div class="modal" onclick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-labelledby="login-modal-title" bind:this={modalEl}>
        <h2 id="login-modal-title" class="visually-hidden">Sign in with Patreon</h2>
        <button class="modal-close" onclick={closeLoginModal} aria-label="Close login dialog">&times;</button>

        <div class="patreon-login">
          <h3 class="patreon-login-heading">Sign in with Patreon</h3>
          <p class="patreon-login-copy">
            AllByte uses Patreon for accounts and membership tiers. Sign in with
            your Patreon account — free or paid. Your tier unlocks automatically.
          </p>

          {#if loginError}
            <p class="login-error" role="alert">{loginError}</p>
          {/if}

          <button class="oauth-btn patreon-btn" disabled={oauthLoading !== null} onclick={() => startOAuth("patreon")} aria-label={oauthLoading === "patreon" ? "Redirecting to Patreon" : "Continue with Patreon"}>
            {#if oauthLoading === "patreon"}
              <span class="oauth-spinner oauth-spinner-light" aria-hidden="true"></span>
              Redirecting…
            {:else}
              <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#fff" d="M14.82 2.41c-3.96 0-7.18 3.22-7.18 7.18 0 3.94 3.22 7.15 7.18 7.15 3.95 0 7.16-3.21 7.16-7.15 0-3.96-3.21-7.18-7.16-7.18zM2 21.6h3.5V2.41H2V21.6z"/></svg>
              Continue with Patreon
            {/if}
          </button>

          <p class="patreon-login-foot">
            Not a member yet? <a href="/subscribe/">See the tiers</a>.
          </p>
        </div>
      </div>
    </div>
  {/if}

  <!-- Hidden SSR mount of play-mode components so Astro's Vite build extracts
       their scoped CSS into a linked stylesheet. Without this, they're only
       rendered inside {#if playMode} which is false at build time, so their
       CSS never ships — the client-side mount has the hashed class but no
       matching rules. Mount uses display:none to stay invisible at runtime. -->
  <div style="display:none" aria-hidden="true">
    <VirtualGamepad iframe={null} />
  </div>

  <div class="demo-section" class:play-active={playMode}>
  {#if playMode}
    <div class="play-container">
      <iframe
        src={gameUrl}
        title="The Chronicles of Nesis"
        class="game-frame"
        allow="cross-origin-isolated"
        bind:this={gameIframe}
      ></iframe>
      <VirtualGamepad iframe={gameIframe} />
    </div>
  {:else}
    <div class="demo-row" style="position: relative;" onclick={launchGame} onmouseenter={onDemoEnter} onmouseleave={onDemoLeave}>
      <div class="overlay-badges" onclick={(e) => e.stopPropagation()}>
        <MilestoneBadge />
      </div>
      <div class="demo-link">
        <div class="demo-banner">
          <img src={demoHovered ? "/ChroniclesOfNesisTitle.gif" : "/ChroniclesOfNesisTitle-still.png"} alt="The Chronicles of Nesis Demo" class="demo-gif" />
          <img src="/ChroniclesOfNesisTitleName.png" alt="The Chronicles of Nesis" class="demo-title-overlay" />
          <span class="demo-version-overlay" aria-label={`Build version ${gameVersion.version}`}>
            {gameVersion.version.startsWith("v") ? gameVersion.version : `v${gameVersion.version}`}
          </span>
        </div>
      </div>
      <div class="demo-actions">
        <div class="demo-cta-group">
          <button class="demo-cta play-cta" type="button" aria-label="Play in browser">
            Play In Browser
          </button>
          {#if installPrompt && !isInstalled}
            <button class="demo-cta install-cta" type="button" onclick={(e) => { e.stopPropagation(); handleInstallClick(); }} aria-label="Install Chronicles as an app on this device">
              Install as App
            </button>
          {/if}
        </div>
      </div>
    </div>
  {/if}
  </div>

  <div class="notify-bar">
      <div class="notify-bar-row">
        {#if auth.currentUser}
          <button
            class="notify-bar-btn"
            onclick={toggleSubscribed}
            disabled={notifySaving}
            title={auth.currentUser.notificationPreferences ? "Unsubscribe from email updates" : "Subscribe to email updates"}
          >
            &#9993; {auth.currentUser.notificationPreferences ? "Subscribed ✓" : "Email Me Updates"}
          </button>
          <!-- Legend's Square hidden until the feature is complete and in the subscription promise -->
        {/if}
        <a href="https://discord.gg/WfYC6gFJe" class="notify-bar-btn discord-notify-btn" target="_blank" rel="noopener noreferrer" title="Join the AllByte Discord server">
          <svg class="discord-inline-icon" viewBox="0 0 127.14 96.36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
          Discord
        </a>
        <a href="https://www.youtube.com/@AllByteStudios" class="notify-bar-btn youtube-notify-btn" target="_blank" rel="noopener noreferrer" title="AllByte Studios on YouTube">
          <svg class="youtube-inline-icon" viewBox="0 0 461.001 461.001" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M365.257,67.393H95.744C42.866,67.393,0,110.259,0,163.137v134.728c0,52.878,42.866,95.744,95.744,95.744h269.513c52.878,0,95.744-42.866,95.744-95.744V163.137C461.001,110.259,418.135,67.393,365.257,67.393z M300.506,237.056l-126.06,60.123c-3.359,1.602-7.239-0.847-7.239-4.568V168.607c0-3.774,3.982-6.22,7.348-4.514l126.06,63.881C304.363,229.873,304.298,235.248,300.506,237.056z"/></svg>
          YouTube
        </a>
        <a href="https://store.steampowered.com/app/3900010/The_Chronicles_of_Nesis/" class="notify-bar-btn steam-notify-btn" target="_blank" rel="noopener noreferrer" title="The Chronicles of Nesis on Steam">
          <svg class="steam-inline-icon" viewBox="0 0 256 259" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M127.779 0C57.852 0 .469 55.394.013 124.609L68.95 153.16a35.615 35.615 0 0 1 20.15-6.213l30.15-43.635v-.613c0-26.36 21.457-47.817 47.818-47.817 26.36 0 47.818 21.457 47.818 47.817 0 26.361-21.457 47.818-47.818 47.818h-1.105l-42.926 30.658a35.796 35.796 0 0 1-35.638 37.149 35.87 35.87 0 0 1-34.992-28.333L1.592 168.53C17.2 220.124 65.89 258.18 123.578 258.18c70.692 0 128.003-57.31 128.003-128.003C251.581 59.487 198.47 0 127.779 0zM80.36 208.09l-15.082-6.232a26.887 26.887 0 0 0 14.49 14.088 26.941 26.941 0 0 0 35.26-14.468 26.796 26.796 0 0 0 .001-20.624 26.864 26.864 0 0 0-14.467-14.467l15.594 6.446a21.556 21.556 0 0 1-11.392 41.29 21.56 21.56 0 0 1-24.404-6.033zm114.007-57.39c0-17.568-14.29-31.858-31.858-31.858-17.569 0-31.858 14.29-31.858 31.858 0 17.569 14.29 31.858 31.858 31.858 17.569 0 31.858-14.29 31.858-31.858zm-55.737-.098c0-13.19 10.706-23.896 23.897-23.896 13.19 0 23.896 10.706 23.896 23.896 0 13.19-10.706 23.897-23.896 23.897-13.191 0-23.897-10.706-23.897-23.897z"/></svg>
          Steam
        </a>
      </div>
  </div>

  {#if isMobile}
    <!-- Mobile: stacked groups (Heart/Assets first) -->
    <div class="mobile-panel heart-bg" style="position: relative;">
      <img src="/Flourish.png" alt="" class="flourish flourish-left" />
      <h2 class="panel-title heart-title">Art<br/><span class="panel-sub">(made without AI)</span></h2>
      <img src="/Flourish.png" alt="" class="flourish flourish-right" />
      <div class="mobile-links">
        <div class="card-wrapper">
          <a href="/music/" class="link-card heart-card" onmouseenter={() => { musicHovered = true; playCursor(); }} onmouseleave={() => musicHovered = false}>
            <h3>Music <img src={musicHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Original compositions for The Chronicles of Nesis.</p>
            <span class="entry-count heart-count">({artCounts.music} tracks)</span>
          </a>
        </div>
        <div class="card-wrapper">
          <a href="/artwork/" class="link-card heart-card" onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
            <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Sprites, pre-rendered backgrounds &amp; the ModernGoth typeface.</p>
            <span class="entry-count heart-count">({artCounts.artwork} spritesheets)</span>
          </a>
        </div>
      </div>
    </div>
    <div class="mobile-panel engine-bg">
      <h2 class="panel-title engine-title"><span class="terminal-prompt">$</span> Dev<br/><span class="panel-sub">(built with AI)</span></h2>
      <div class="mobile-links">
        <div class="card-wrapper">
          <a href="/devlog/" class="link-card engine-card" onmouseenter={playCursor}>
            <h3>Devlog <span class="cursor-arrow"></span></h3>
            <p>Engineering, workflow, strategy, narrative &amp; craft posts.</p>
            <span class="entry-count">({devlogTotal} {devlogTotal === 1 ? "entry" : "entries"})</span>
          </a>
        </div>
        <div class="card-wrapper">
          <a href="/test/" class="link-card engine-card" onmouseenter={playCursor}>
            <h3>Test Suite Dashboard <span class="cursor-arrow"></span></h3>
            <p>Live build health across three runner tiers with milestone progress &amp; blockers.</p>
            <span class="entry-count">(public summary · Hero+ for depth)</span>
          </a>
        </div>
      </div>
    </div>
  {:else}
    <!-- Desktop: shared grid -->
    <div class="bilateral-grid">
      <div class="cell engine-bg title-cell">
        <h2 class="panel-title engine-title"><span class="terminal-prompt">$</span> Dev<br/><span class="panel-sub">(built with AI)</span></h2>
      </div>
      <div class="cell heart-bg title-cell heart-title-cell">
        <img src="/Flourish.png" alt="" class="flourish flourish-left" />
        <h2 class="panel-title heart-title">Art<br/><span class="panel-sub">(made without AI)</span></h2>
        <img src="/Flourish.png" alt="" class="flourish flourish-right" />
      </div>

      <div class="cell engine-bg">
        <div class="card-wrapper">
          <a href="/devlog/" class="link-card engine-card" onmouseenter={playCursor}>
            <h3>Devlog <span class="cursor-arrow"></span></h3>
            <p>Engineering, workflow, strategy, narrative &amp; craft posts — all in one feed with tag filters.</p>
            <span class="entry-count">({devlogTotal} {devlogTotal === 1 ? "entry" : "entries"})</span>
          </a>
        </div>
      </div>
      <div class="cell heart-bg">
        <div class="card-wrapper">
          <a href="/music/" class="link-card heart-card" onmouseenter={() => { musicHovered = true; playCursor(); }} onmouseleave={() => musicHovered = false}>
            <h3>Music <img src={musicHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Original compositions for The Chronicles of Nesis.</p>
            <span class="entry-count heart-count">({artCounts.music} tracks)</span>
          </a>
        </div>
      </div>

      <div class="cell engine-bg">
        <div class="card-wrapper">
          <a href="/test/" class="link-card engine-card" onmouseenter={playCursor}>
            <h3>Dev Console <span class="cursor-arrow"></span></h3>
            <p>Tests, agents, tickets &amp; milestones — live build status at a glance.</p>
            <span class="entry-count">(public overview · Hero+ for depth)</span>
          </a>
        </div>
      </div>
      <div class="cell heart-bg">
        <div class="card-wrapper">
          <a href="/artwork/" class="link-card heart-card" onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
            <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Sprites, pre-rendered backgrounds &amp; the ModernGoth typeface.</p>
            <span class="entry-count heart-count">({artCounts.artwork} spritesheets)</span>
          </a>
        </div>
      </div>
    </div>
  {/if}

  <footer class="site-footer">
    <a href="mailto:allbytestudios@gmail.com" class="footer-contact">allbytestudios@gmail.com</a>
    <span>&copy; 2026 AllByte Studios</span>
  </footer>
</div>

<style>
  .page {
    min-height: 100dvh;
    display: flex;
    flex-direction: column;
  }

  /* === Header === */
  .site-header {
    background: #1e2a3a;
    text-align: center;
    padding: 2.5rem 1rem 0.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
  }

  .header-row {
    display: flex;
    align-items: center;
    justify-content: center;
    max-width: 1200px;
    margin: 0 auto;
    width: 100%;
    position: relative;
  }

  .header-left {
    position: absolute;
    left: 0;
  }

  .header-right {
    position: absolute;
    right: 0;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.75rem;
  }

  .site-title {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 2.75rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    margin: 0;
    color: #e0e7ff;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .site-icon {
    width: 3rem;
    height: 3rem;
    object-fit: contain;
  }



  .subscribe-btn {
    color: #e0e7ff;
    border: 1px solid rgba(167, 243, 208, 0.15);
  }

  .subscribe-btn:hover {
    background: #1a2332;
    border-color: rgba(167, 243, 208, 0.3);
  }


  .admin-btn {
    color: #f9a8d4;
    border: 1px solid rgba(244, 114, 182, 0.45);
    background: rgba(244, 114, 182, 0.06);
  }

  .admin-btn:hover {
    background: rgba(244, 114, 182, 0.16);
    border-color: rgba(244, 114, 182, 0.75);
  }

  .header-right-buttons {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .username {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.4rem;
    color: #e0e7ff;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    align-self: stretch;
  }

  .user-tier-icon {
    width: 1.5rem;
    height: 1.5rem;
    image-rendering: pixelated;
    object-fit: contain;
  }

  .header-btn {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.2rem;
    background: #141b24;
    padding: 0;
    cursor: pointer;
    transition: all 0.2s;
    font-weight: 600;
    border-radius: 4px;
    text-decoration: none;
    text-align: center;
    display: flex;
    flex-direction: column;
    min-width: 6.5rem;
    -webkit-font-smoothing: none;
    -moz-osx-font-smoothing: unset;
  }

  .header-btn span {
    padding: 0.3rem 1.25rem;
  }

  .header-btn span:first-child::after {
    content: "";
    display: block;
    margin: 0.3rem auto 0;
    width: 50%;
    border-bottom: 1px solid rgba(255, 255, 255, 0.15);
  }

  .login-btn {
    color: #e0e7ff;
    border: 1px solid rgba(167, 243, 208, 0.15);
  }

  .login-btn:hover {
    background: #1a2332;
    border-color: rgba(167, 243, 208, 0.3);
  }

  /* === Notification Bar === */
  .notify-bar {
    background: #12161c;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 0.25rem;
    padding: 0.4rem 1rem;
  }

  .notify-bar-btn {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.3rem;
    color: #a7f3d0;
    background: none;
    border: none;
    cursor: pointer;
    padding: 0;
    transition: opacity 0.2s;
  }

  .notify-bar-btn:hover {
    opacity: 0.7;
  }

  .notify-bar-row {
    display: flex;
    align-items: center;
    gap: 1.5rem;
  }

  .legend-square-btn {
    color: #f97316 !important;
    text-decoration: none;
  }

  .discord-notify-btn {
    color: #a7f3d0 !important;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .discord-inline-icon {
    width: 1em;
    height: 0.75em;
    color: #5865f2;
  }

  .youtube-notify-btn {
    color: #a7f3d0 !important;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .youtube-inline-icon {
    width: 1em;
    height: 0.85em;
    color: #ff0000;
  }

  .steam-notify-btn {
    color: #a7f3d0 !important;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .steam-inline-icon {
    width: 1em;
    height: 1em;
    color: #66c0f4;
  }

  @media (max-width: 640px) {
    .notify-bar-row {
      flex-direction: column;
      gap: 0.4rem;
    }
  }

  /* === Card Wrapper === */
  .card-wrapper {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
  }

  /* === Login Modal === */
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 100;
    backdrop-filter: blur(4px);
  }

  .modal {
    background: #1a2233;
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 6px;
    padding: 2.5rem;
    width: 90%;
    max-width: 380px;
    position: relative;
    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.5);
  }

  .modal-close {
    position: absolute;
    top: 0.75rem;
    right: 1rem;
    background: none;
    border: none;
    color: #e0e7ff;
    font-size: 1.5rem;
    cursor: pointer;
    opacity: 0.5;
    transition: opacity 0.2s;
  }

  .modal-close:hover {
    opacity: 1;
  }

  .login-error {
    color: #f97316;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
    text-align: center;
  }

  .visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .oauth-btn {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    padding: 0.6rem;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 4px;
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    font-size: 0.95rem;
    cursor: pointer;
    transition: all 0.2s;
  }

  /* Patreon-only login */
  .patreon-login {
    text-align: center;
  }

  .patreon-login-heading {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.4rem;
    color: #a7f3d0;
    margin: 0 0 0.5rem;
  }

  .patreon-login-copy {
    font-size: 0.9rem;
    line-height: 1.6;
    color: rgba(224, 231, 255, 0.7);
    margin: 0 auto 1.25rem;
    max-width: 340px;
  }

  .patreon-btn {
    width: 100%;
    background: #ff424d;
    color: #fff;
  }

  .patreon-btn:hover:not(:disabled) {
    background: #e63a44;
  }

  .patreon-btn:disabled:hover { background: #ff424d; }

  .patreon-login-foot {
    font-size: 0.82rem;
    color: rgba(224, 231, 255, 0.5);
    margin: 1rem 0 0;
  }

  .patreon-login-foot a {
    color: #a7f3d0;
  }

  .oauth-btn:disabled {
    cursor: progress;
    opacity: 0.75;
  }

  .oauth-btn:disabled:hover {
    background: inherit;
  }

  .oauth-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(0, 0, 0, 0.15);
    border-top-color: rgba(0, 0, 0, 0.6);
    border-radius: 50%;
    animation: oauth-spin 0.8s linear infinite;
    display: inline-block;
  }

  .oauth-spinner-light {
    border-color: rgba(255, 255, 255, 0.3);
    border-top-color: #fff;
  }

  @keyframes oauth-spin {
    to { transform: rotate(360deg); }
  }

  @media (prefers-reduced-motion: reduce) {
    .oauth-spinner { animation-duration: 2s; }
  }

  .site-tagline {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.125rem;
    color: rgba(224, 231, 255, 0.5);
    margin: 0;
  }

  /* === Demo Row === */
  .demo-section {
    background: #1e2a3a;
    padding: 0 0 0.5rem;
    transition: all 0.4s ease;
  }

  .demo-section.play-active {
    position: fixed;
    inset: 0;
    z-index: 1000;
    background: #0a0e17;
    padding: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    animation: expand-in 0.8s ease;
  }

  @keyframes expand-in {
    from {
      opacity: 0;
      transform: scale(0.7);
    }
    to {
      opacity: 1;
      transform: scale(1);
    }
  }

  .play-container {
    width: 100%;
    height: 100%;
    display: flex;
    flex-direction: column;
    /* Positioning context for VirtualGamepad (absolute, inset:0 overlay). */
    position: relative;
  }

  .game-frame {
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
    border: none;
    display: block;
  }

  /* Thin overlay badges in the top-right of the demo button */
  .overlay-badges {
    position: absolute;
    top: 0.6rem;
    right: 0.6rem;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    align-items: flex-end;
  }

  /* Mobile / narrow: drop the absolute positioning entirely. The badges
     flow naturally at the TOP of .demo-row as a side-by-side row, pushing
     the demo image down inside the row instead of floating above where
     they'd collide with the header (sign-in buttons, etc). */
  @media (max-width: 900px) {
    .overlay-badges {
      position: relative;
      top: auto;
      right: auto;
      left: auto;
      bottom: auto;
      flex-direction: row;
      align-items: stretch;
      justify-content: center;
      gap: 0.5rem;
      padding: 0.55rem 0.55rem 0.25rem;
      width: auto;
    }
    .overlay-badges > :global(*) {
      flex: 1 1 0;
      min-width: 0;
      max-width: 220px;
    }
    :global(.overlay-badges .milestone-badge),
    :global(.overlay-badges .test-suite-pill) {
      width: auto;
    }
    :global(.overlay-badges .milestone-badge) {
      font-size: 0.72rem;
    }
  }

  /* Very narrow mobile: side-by-side pinches the text so hard that labels get
     clipped. Stack the badges so each takes the full container width. */
  @media (max-width: 640px) {
    .overlay-badges {
      flex-direction: column;
      align-items: stretch;
      gap: 0.45rem;
    }
    .overlay-badges > :global(*) {
      max-width: none;
      width: 100%;
    }
  }

  .demo-row {
    background: #141b24;
    position: relative;
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 4px;
    margin: 0.5rem auto;
    max-width: 960px;
    width: 90%;
    transition: background 0.25s;
    box-shadow: 0 4px 12px rgba(0, 0, 0, 0.4), 0 2px 4px rgba(0, 0, 0, 0.3);
    cursor: pointer;
  }

  .demo-row:hover {
    background: #0a0e14;
    border-color: rgba(167, 243, 208, 0.3);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.6), 0 4px 8px rgba(0, 0, 0, 0.4);
  }

  .demo-link {
    display: block;
    text-align: center;
    padding: 0.75rem 0.75rem 0;
  }

  .demo-banner {
    position: relative;
    display: inline-block;
    max-width: 960px;
    width: 100%;
  }

  .demo-gif {
    width: 100%;
    height: auto;
    display: block;
  }

  .demo-title-overlay {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    max-width: 37.5%;
    height: auto;
    pointer-events: none;
  }

  /* Build version overlaid on the GIF (bottom-right corner) so the demo
     actions row can use its full width for the Play/Install links rather
     than sharing space with version text. */
  .demo-version-overlay {
    position: absolute;
    bottom: 0.6rem;
    right: 0.8rem;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    color: rgba(167, 243, 208, 0.85);
    background: rgba(10, 14, 23, 0.55);
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
    letter-spacing: 0.02em;
    pointer-events: none;
    line-height: 1;
  }

  .demo-actions {
    display: flex;
    align-items: center;
    position: relative;
    padding: 0.5rem 1rem;
    justify-content: center;
  }


  /* The two boxed CTAs (Play In Browser, Install as App) are centered
     side-by-side. demo-actions has no other children now (build-date and
     Steam button moved or removed) so the group gets the full width. */
  .demo-cta-group {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 1.5rem;
  }

  .demo-cta {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.25rem;
    font-weight: 400;
    color: var(--engine-accent);
    letter-spacing: 0.02em;
    background: transparent;
    border: 1px solid var(--engine-border);
    padding: 0.5rem 1.1rem;
    cursor: pointer;
    transition: border-color 0.15s, background 0.15s;
  }

  .demo-cta:hover {
    border-color: var(--engine-accent);
    background: rgba(167, 243, 208, 0.1);
  }

  /* Install sits next to Play as a peer. Same boxed treatment as Play —
     they read as two equal choices side-by-side (play now or install for
     later) rather than primary/secondary. */
  .install-cta {
    /* No visual difference from .demo-cta; class kept for future hooks. */
  }


  /* === Mobile Panels === */
  .mobile-panel {
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
  }

  .mobile-links {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 1rem;
    width: 100%;
    max-width: 95%;
  }

  /* === Bilateral Grid === */
  .bilateral-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
  }

.cell {
    display: flex;
    justify-content: center;
    padding: 0.5rem 2rem;
  }

  .title-cell {
    padding-top: 1.5rem;
    padding-bottom: 0.25rem;
  }

  .cell:last-of-type,
  .cell:nth-last-of-type(2) {
    padding-bottom: 2.5rem;
  }

  .engine-bg {
    background: #1a1e26;
    color: var(--engine-text);
    font-family: "Courier New", Courier, monospace;
  }

  .heart-bg {
    background: #ddd5b8 !important;
    color: var(--heart-text);
  }

  .panel-title {
    font-size: 2.25rem;
    font-weight: 600;
    margin: 0;
    text-align: center;
  }

  .engine-title {
    color: var(--engine-accent);
  }

  .heart-title {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 2.25rem;
    color: #2a2218;
  }

  .heart-title-cell {
    position: relative;
  }

  .flourish {
    position: absolute;
    top: 0.5rem;
    width: 10rem;
    height: auto;
    pointer-events: none;
    image-rendering: pixelated;
  }

  .flourish-right {
    right: 1rem;
    transform: scaleX(-1);
  }

  .flourish-left {
    left: 1rem;
  }

  .sword-icon {
    width: 3rem;
    height: 3rem;
    object-fit: contain;
    margin-left: auto;
    flex-shrink: 0;
    opacity: 0.5;
    transition: opacity 0.2s;
    transform: scaleX(-1);
    image-rendering: pixelated;
  }


  .heart-card:hover .sword-icon {
    opacity: 1;
  }

  .panel-sub {
    display: block;
    font-size: 0.6em;
    opacity: 0.6;
    font-weight: 400;
    text-align: center;
  }

  .terminal-prompt {
    opacity: 0.5;
  }

  /* === Link Cards (shared) === */
  .link-card {
    display: block;
    text-decoration: none;
    color: inherit;
    padding: 1rem 1.25rem;
    width: 95%;
    box-sizing: border-box;
    transition: all 0.2s;
  }

  .link-card:hover .arrow {
    opacity: 1;
    transform: translateX(4px);
  }

  .engine-card {
    border: 1px solid var(--engine-border);
    background: #12161c;
  }

  .engine-card:hover {
    background: rgba(167, 243, 208, 0.06);
    border-color: var(--engine-accent);
  }

  .heart-card {
    background: var(--heart-card-bg);
    border: 2px solid var(--heart-card-border);
    border-radius: 4px;
    box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.2), 0 4px 8px rgba(0, 0, 0, 0.3), 0 2px 3px rgba(0, 0, 0, 0.2);
    position: relative;
    overflow: visible;
  }

  .heart-card:hover {
    background: #ccc08c;
    border-color: var(--heart-accent);
  }

  .link-card h3 {
    font-size: 1.25rem;
    font-weight: 600;
    margin: 0 0 0.375rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .engine-card h3 {
    font-size: 1.5rem;
    color: var(--engine-accent);
  }

  .heart-card h3 {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.75rem;
    color: #2a2218;
  }

  .arrow {
    margin-left: auto;
    opacity: 0.4;
    transition: all 0.2s;
  }

  .cursor-arrow {
    margin-left: auto;
    color: var(--engine-accent);
    opacity: 0.4;
  }

  .cursor-arrow::after {
    content: "|";
  }

  .engine-card:hover .cursor-arrow::after {
    content: "_";
    animation: blink-cursor 1s step-end infinite;
  }

  .engine-card:hover .cursor-arrow {
    opacity: 1;
  }

  @keyframes blink-cursor {
    50% { opacity: 0; }
  }

  .link-card p {
    font-size: 1.05rem;
    line-height: 1.5;
    margin: 0;
  }

  .engine-card p {
    color: var(--engine-accent);
    opacity: 0.7;
  }

  .entry-count {
    display: block;
    text-align: right;
    margin-top: 0.5rem;
    font-family: "Courier New", monospace;
    font-size: 1rem;
    color: var(--engine-accent);
    opacity: 0.5;
  }

  .heart-count {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    color: #2a2218;
    opacity: 0.4;
  }

  .heart-card p {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.15rem;
    color: var(--heart-text);
    opacity: 0.9;
  }

  .battle-icon {
    width: 15rem;
    max-width: 40%;
    height: auto;
    margin-left: 4px;
    margin-top: -3rem;
    margin-bottom: -3rem;
    pointer-events: none;
    flex-shrink: 1;
  }

  .site-footer {
    background: #1e2a3a;
    text-align: center;
    padding: 1.5rem 1rem;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 0.9rem;
    color: rgba(224, 231, 255, 0.65);
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    align-items: center;
  }

  .footer-contact {
    font-size: 0.85rem;
    color: rgba(167, 243, 208, 0.5);
    text-decoration: none;
    transition: opacity 0.2s;
  }

  .footer-contact:hover {
    color: rgba(167, 243, 208, 0.8);
  }

  @media (max-width: 768px) {
    .header-row {
      flex-direction: column;
      gap: 0.5rem;
    }

    .header-left,
    .header-right {
      position: static;
    }

    .header-right {
      flex-wrap: wrap;
      justify-content: center;
    }

    .site-title {
      font-size: 2rem;
    }

    .demo-actions {
      flex-direction: column;
      align-items: center;
      gap: 0.85rem;
      padding: 0.85rem 1rem;
    }

    .demo-actions .demo-cta-group {
      order: 1;
      flex-wrap: wrap;
      gap: 0.85rem;
    }
  }
</style>
