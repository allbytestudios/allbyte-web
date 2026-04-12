<script lang="ts">
  import EnginePanel from "./EnginePanel.svelte";
  import HeartPanel from "./HeartPanel.svelte";
  import PlayOverlay from "./PlayOverlay.svelte";
  import MilestoneBadge from "./MilestoneBadge.svelte";
  import gameVersion from "../data/game-version.json";
  import { auth, initAuth, login, signup, logout, oauthLogin, saveNotificationPrefs } from "../lib/auth.svelte.ts";
  import { initSaveBridge, teardownSaveBridge } from "../lib/saves.svelte.ts";
  import { isAdmin } from "../lib/tier";

  const buildDateLabel = (() => {
    const raw = (gameVersion as { buildDate?: string | null }).buildDate;
    if (!raw) return null;
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) return null;
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    const hh = String(d.getHours()).padStart(2, "0");
    const mm = String(d.getMinutes()).padStart(2, "0");
    return `${y}-${m}-${day} ${hh}:${mm}`;
  })();

  let isMobile = $state(false);
  let showLoginModal = $state(false);
  let loginMode = $state("signin");
  let loginError = $state("");
  let loginLoading = $state(false);
  let pendingAction = $state<string | null>(null);
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

  function launchGame() {
    gameUrl = "/godot/index.html";
    playMode = true;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", handlePlayKey);
  }

  function exitGame() {
    playMode = false;
    gameUrl = "";
    document.body.style.overflow = "";
    window.removeEventListener("keydown", handlePlayKey);
    teardownSaveBridge();
    gameIframe = null;
  }

  // Wire up the save bridge once the iframe is mounted
  $effect(() => {
    if (playMode && gameIframe) {
      initSaveBridge(gameIframe);
    }
  });

  function handlePlayKey(e: KeyboardEvent) {
    if (e.key === "Escape") exitGame();
  }
  let artworkHovered = $state(false);
  let musicHovered = $state(false);
  let fontHovered = $state(false);

  let notifyMode = $state(false);
  let notifyPrefs = $state<Record<string, boolean>>({
    devlog: true, testsuite: true, music: true, artwork: true,
  });
  let notifySaving = $state(false);

  function enterNotifyMode() {
    const existing = auth.currentUser?.notificationPreferences;
    notifyPrefs = existing
      ? { devlog: true, testsuite: true, music: true, artwork: true, ...existing }
      : { devlog: true, testsuite: true, music: true, artwork: true };
    notifyMode = true;
  }

  function cancelNotifyMode() {
    notifyMode = false;
  }

  async function saveNotifications() {
    notifySaving = true;
    const err = await saveNotificationPrefs(notifyPrefs);
    notifySaving = false;
    if (!err) notifyMode = false;
  }

  async function stopAllNotifications() {
    notifySaving = true;
    const err = await saveNotificationPrefs(null);
    notifySaving = false;
    if (!err) notifyMode = false;
  }

  function togglePref(key: string) {
    if (notifyMode) notifyPrefs[key] = !notifyPrefs[key];
  }

  let { devlogTotal = 0, artCounts = { music: 0, artwork: 0 } } = $props();

  let tierCounts = $state({ initiate: 0, hero: 0, legend: 0 });

  let anthemAudio;
  let cursorAudio;
  let audioReady = false;

  function checkMobile() {
    isMobile = window.innerWidth < 768;
  }

  function initAudio() {
    if (audioReady) return;
    audioReady = true;
    anthemAudio = new Audio("/Anthem2.mp3");
    anthemAudio.loop = true;
    anthemAudio.volume = 0.7;
    cursorAudio = new Audio("/cursor-move.wav");
    cursorAudio.volume = 0.21;
    // Play and immediately pause to unlock both
    anthemAudio.play().then(() => anthemAudio.pause()).catch(() => {});
    cursorAudio.play().then(() => { cursorAudio.pause(); cursorAudio.currentTime = 0; }).catch(() => {});
  }

  $effect(() => {
    checkMobile();
    initAuth();
    window.addEventListener("resize", checkMobile);
    window.addEventListener("click", initAudio, { once: true });
    window.addEventListener("touchstart", initAudio, { once: true });

    fetch("https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com/counts")
      .then(r => r.json())
      .then(data => tierCounts = data)
      .catch(() => {});

    return () => {
      window.removeEventListener("resize", checkMobile);
      if (anthemAudio) { anthemAudio.pause(); }
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

  async function handleLogin(e: SubmitEvent) {
    e.preventDefault();
    loginError = "";
    loginLoading = true;
    const form = e.target as HTMLFormElement;
    const email = (form.email as HTMLInputElement).value;
    const password = (form.password as HTMLInputElement).value;
    const err = await login(email, password);
    loginLoading = false;
    if (err) {
      loginError = err;
    } else {
      showLoginModal = false;
      if (pendingAction === "subscribe") {
        pendingAction = null;
        window.location.href = "/subscribe/";
      }
    }
  }

  async function handleSignup(e: SubmitEvent) {
    e.preventDefault();
    loginError = "";
    loginLoading = true;
    const form = e.target as HTMLFormElement;
    const email = (form.email as HTMLInputElement).value;
    const username = (form.username as HTMLInputElement).value;
    const password = (form.password as HTMLInputElement).value;
    const confirm = (form.confirm as HTMLInputElement).value;
    if (password !== confirm) {
      loginError = "Passwords do not match";
      loginLoading = false;
      return;
    }
    const err = await signup(email, username, password);
    loginLoading = false;
    if (err) {
      loginError = err;
    } else {
      showLoginModal = false;
      if (pendingAction === "subscribe") {
        pendingAction = null;
        window.location.href = "/subscribe/";
      }
    }
  }

  function onDemoEnter() {
    demoHovered = true;
    if (anthemAudio && audioReady && !window.__musicPlayerPlaying) {
      anthemAudio.currentTime = 0;
      anthemAudio.play().catch(() => {});
    }
  }

  function onDemoLeave() {
    demoHovered = false;
    if (anthemAudio) {
      anthemAudio.pause();
      anthemAudio.currentTime = 0;
    }
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
        <div class="tier-counts">
        <span class="tier-label">Subscribers</span>
        <div class="tier-pips">
          <span class="tier-pip" style="--tier-color: #a7f3d0;"><img src="/tier-initiate.png" alt="" class="tier-icon" /><span class="pip-name">Initiate</span><span class="pip-count">{tierCounts.initiate}</span></span>
          <span class="tier-pip" style="--tier-color: #fbbf24;"><img src="/tier-hero.png" alt="" class="tier-icon" /><span class="pip-name">Hero</span><span class="pip-count">{tierCounts.hero}</span></span>
          <span class="tier-pip" style="--tier-color: #f97316;"><img src="/tier-legend.png" alt="" class="tier-icon" /><span class="pip-name">Legend</span><span class="pip-count">{tierCounts.legend}</span></span>
          </div>
        </div>
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
        <h2 id="login-modal-title" class="visually-hidden">{loginMode === "signin" ? "Sign In" : "Create Account"}</h2>
        <button class="modal-close" onclick={closeLoginModal} aria-label="Close login dialog">&times;</button>

        <div class="modal-tabs" role="tablist">
          <button class="modal-tab" class:active={loginMode === "signin"} onclick={() => loginMode = "signin"} role="tab" aria-selected={loginMode === "signin"}>Sign In</button>
          <button class="modal-tab" class:active={loginMode === "signup"} onclick={() => loginMode = "signup"} role="tab" aria-selected={loginMode === "signup"}>Create Account</button>
        </div>

        {#if loginError}
          <p class="login-error" role="alert">{loginError}</p>
        {/if}

        {#if loginMode === "signin"}
          <form class="login-form" onsubmit={handleLogin}>
            <label for="signin-email" class="login-label">Email</label>
            <input id="signin-email" type="email" name="email" placeholder="you@example.com" class="login-input" required autocomplete="email" />
            <label for="signin-password" class="login-label">Password</label>
            <input id="signin-password" type="password" name="password" placeholder="Your password" class="login-input" required autocomplete="current-password" />
            <button type="submit" class="submit-btn" disabled={loginLoading}>{loginLoading ? "Signing in..." : "Sign In"}</button>
          </form>
        {:else}
          <form class="login-form" onsubmit={handleSignup}>
            <label for="signup-email" class="login-label">Email</label>
            <input id="signup-email" type="email" name="email" placeholder="you@example.com" class="login-input" required autocomplete="email" />
            <label for="signup-username" class="login-label">Username</label>
            <input id="signup-username" type="text" name="username" placeholder="Choose a username" class="login-input" required autocomplete="username" />
            <label for="signup-password" class="login-label">Password</label>
            <input id="signup-password" type="password" name="password" placeholder="Min 8 characters" class="login-input" required minlength="8" autocomplete="new-password" />
            <label for="signup-confirm" class="login-label">Confirm Password</label>
            <input id="signup-confirm" type="password" name="confirm" placeholder="Re-enter password" class="login-input" required autocomplete="new-password" />
            <button type="submit" class="submit-btn" disabled={loginLoading}>{loginLoading ? "Creating account..." : "Create Account"}</button>
          </form>
        {/if}

        <div class="divider"><span>or continue with</span></div>

        <div class="oauth-buttons">
          <button class="oauth-btn google-btn" onclick={() => { if (pendingAction) sessionStorage.setItem("allbyte_pending_action", pendingAction); oauthLogin("google"); }}>
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Google
          </button>
          <button class="oauth-btn discord-btn" onclick={() => { if (pendingAction) sessionStorage.setItem("allbyte_pending_action", pendingAction); oauthLogin("discord"); }}>
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#fff" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
            Discord
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="demo-section" class:play-active={playMode}>
  {#if playMode}
    <div class="play-container">
      <PlayOverlay onExit={exitGame} />
      <iframe
        src={gameUrl}
        title="The Chronicles of Nesis"
        class="game-frame"
        allow="cross-origin-isolated"
        bind:this={gameIframe}
      ></iframe>
    </div>
  {:else}
    <div class="demo-row" style="position: relative;" onclick={launchGame}>
      <div class="overlay-badges" onclick={(e) => e.stopPropagation()}>
        <MilestoneBadge />
      </div>
      <div class="demo-overlay"><span>Coming Soon</span></div>
      <div class="demo-link">
        <div class="demo-banner">
          <img src={demoHovered ? "/ChroniclesOfNesisTitle.gif" : "/ChroniclesOfNesisTitle-still.png"} alt="The Chronicles of Nesis Demo" class="demo-gif" />
          <img src="/ChroniclesOfNesisTitleName.png" alt="The Chronicles of Nesis" class="demo-title-overlay" />
        </div>
      </div>
      <div class="demo-actions">
        {#if buildDateLabel}
          <span class="build-date" title={`Built ${buildDateLabel}`}>Built {buildDateLabel}</span>
        {/if}
        <span class="demo-cta">Play Now v{gameVersion.version} (No Download) &#8594;</span>
        <a href="https://store.steampowered.com/app/3900010/The_Chronicles_of_Nesis/" class="steam-btn" target="_blank" rel="noopener noreferrer" onclick={(e) => e.stopPropagation()}>
          <svg class="steam-icon" viewBox="0 0 256 259" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M127.779 0C57.852 0 .469 55.394.013 124.609L68.95 153.16a35.615 35.615 0 0 1 20.15-6.213l30.15-43.635v-.613c0-26.36 21.457-47.817 47.818-47.817 26.36 0 47.818 21.457 47.818 47.817 0 26.361-21.457 47.818-47.818 47.818h-1.105l-42.926 30.658a35.796 35.796 0 0 1-35.638 37.149 35.87 35.87 0 0 1-34.992-28.333L1.592 168.53C17.2 220.124 65.89 258.18 123.578 258.18c70.692 0 128.003-57.31 128.003-128.003C251.581 59.487 198.47 0 127.779 0zM80.36 208.09l-15.082-6.232a26.887 26.887 0 0 0 14.49 14.088 26.941 26.941 0 0 0 35.26-14.468 26.796 26.796 0 0 0 .001-20.624 26.864 26.864 0 0 0-14.467-14.467l15.594 6.446a21.556 21.556 0 0 1-11.392 41.29 21.56 21.56 0 0 1-24.404-6.033zm114.007-57.39c0-17.568-14.29-31.858-31.858-31.858-17.569 0-31.858 14.29-31.858 31.858 0 17.569 14.29 31.858 31.858 31.858 17.569 0 31.858-14.29 31.858-31.858zm-55.737-.098c0-13.19 10.706-23.896 23.897-23.896 13.19 0 23.896 10.706 23.896 23.896 0 13.19-10.706 23.897-23.896 23.897-13.191 0-23.897-10.706-23.897-23.897z"/></svg>
          Wishlist on Steam &#8594;
        </a>
      </div>
    </div>
  {/if}
  </div>

  {#if auth.currentUser}
    <div class="notify-bar">
      {#if !notifyMode}
        <button class="notify-bar-btn" onclick={enterNotifyMode}>&#9993; Email Me Updates{#if auth.currentUser.notificationPreferences} (On){/if}</button>
      {:else}
        <div class="notify-bar-actions">
          <button class="notify-bar-save" onclick={saveNotifications} disabled={notifySaving}>{notifySaving ? "Saving..." : "Save"}</button>
          <button class="notify-bar-cancel" onclick={cancelNotifyMode}>Cancel</button>
          {#if auth.currentUser.notificationPreferences}
            <button class="notify-bar-stop" onclick={stopAllNotifications} disabled={notifySaving}>Stop all</button>
          {/if}
        </div>
        <span class="notify-bar-prompt">&#9993; Which areas do you want to be notified about new content?</span>
        <span class="notify-bar-prompt">(subscriptions help me know what content people are interested in)</span>
      {/if}
    </div>
  {/if}

  {#if isMobile}
    <!-- Mobile: stacked groups (Heart/Assets first) -->
    <div class="mobile-panel heart-bg" style="position: relative;">
      <img src="/Flourish.png" alt="" class="flourish flourish-left" />
      <h2 class="panel-title heart-title">Art<br/><span class="panel-sub">(made without AI)</span></h2>
      <img src="/Flourish.png" alt="" class="flourish flourish-right" />
      <div class="mobile-links">
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("music")}>
          <a href="/music/" class="link-card heart-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={() => { musicHovered = true; playCursor(); }} onmouseleave={() => musicHovered = false}>
            <h3>Music <img src={musicHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Original compositions for The Chronicles of Nesis.</p>
            <span class="entry-count heart-count">({artCounts.music} tracks)</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.music} /></label>{/if}
        </div>
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("artwork")}>
          <a href="/artwork/" class="link-card heart-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
            <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Sprites, pre-rendered backgrounds &amp; the ModernGoth typeface.</p>
            <span class="entry-count heart-count">({artCounts.artwork} spritesheets)</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.artwork} /></label>{/if}
        </div>
      </div>
    </div>
    <div class="mobile-panel engine-bg">
      <h2 class="panel-title engine-title"><span class="terminal-prompt">$</span> Dev<br/><span class="panel-sub">(built with AI)</span></h2>
      <div class="mobile-links">
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("devlog")}>
          <a href="/devlog/" class="link-card engine-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={playCursor}>
            <h3>Devlog <span class="cursor-arrow"></span></h3>
            <p>Engineering, workflow, strategy, narrative &amp; craft posts.</p>
            <span class="entry-count">({devlogTotal} {devlogTotal === 1 ? "entry" : "entries"})</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.devlog} /></label>{/if}
        </div>
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("testsuite")}>
          <a href="/test/" class="link-card engine-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={playCursor}>
            <h3>Test Suite Dashboard <span class="cursor-arrow"></span></h3>
            <p>Live build health across three runner tiers with milestone progress &amp; blockers.</p>
            <span class="entry-count">(public summary · Hero+ for depth)</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.testsuite} /></label>{/if}
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
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("devlog")}>
          <a href="/devlog/" class="link-card engine-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={playCursor}>
            <h3>Devlog <span class="cursor-arrow"></span></h3>
            <p>Engineering, workflow, strategy, narrative &amp; craft posts — all in one feed with tag filters.</p>
            <span class="entry-count">({devlogTotal} {devlogTotal === 1 ? "entry" : "entries"})</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.devlog} /></label>{/if}
        </div>
      </div>
      <div class="cell heart-bg">
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("music")}>
          <a href="/music/" class="link-card heart-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={() => { musicHovered = true; playCursor(); }} onmouseleave={() => musicHovered = false}>
            <h3>Music <img src={musicHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Original compositions for The Chronicles of Nesis.</p>
            <span class="entry-count heart-count">({artCounts.music} tracks)</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.music} /></label>{/if}
        </div>
      </div>

      <div class="cell engine-bg">
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("testsuite")}>
          <a href="/test/" class="link-card engine-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={playCursor}>
            <h3>Test Suite Dashboard <span class="cursor-arrow"></span></h3>
            <p>Live build health across three runner tiers, milestone progress &amp; blockers.</p>
            <span class="entry-count">(public summary · Hero+ for depth)</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.testsuite} /></label>{/if}
        </div>
      </div>
      <div class="cell heart-bg">
        <div class="card-wrapper" class:notify-active={notifyMode} onclick={() => togglePref("artwork")}>
          <a href="/artwork/" class="link-card heart-card" onclick={(e) => { if (notifyMode) e.preventDefault(); }} onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
            <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Sprites, pre-rendered backgrounds &amp; the ModernGoth typeface.</p>
            <span class="entry-count heart-count">({artCounts.artwork} spritesheets)</span>
          </a>
          {#if notifyMode}<label class="notify-checkbox"><input type="checkbox" bind:checked={notifyPrefs.artwork} /></label>{/if}
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

  .tier-counts {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 13.75rem;
  }

  .tier-label {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 0.85rem;
    color: rgba(224, 231, 255, 0.5);
    letter-spacing: 0.05em;
    border-bottom: 1px solid rgba(224, 231, 255, 0.15);
    padding-bottom: 0.25rem;
    margin-bottom: 0.15rem;
  }

  .tier-pips {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  .tier-pip {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .tier-icon {
    width: 1.5rem;
    height: 1.5rem;
    image-rendering: pixelated;
    object-fit: contain;
    flex-shrink: 0;
  }

  .pip-name {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.4rem;
    color: var(--tier-color);
  }

  .pip-count {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.4rem;
    color: rgba(224, 231, 255, 0.7);
    margin-left: auto;
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


  .notify-bar-prompt {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.3rem;
    color: #e0e7ff;
  }

  .notify-bar-actions {
    display: flex;
    gap: 0.5rem;
  }

  .notify-bar-save,
  .notify-bar-cancel,
  .notify-bar-stop {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.1rem;
    padding: 0.15rem 0.75rem;
    border-radius: 3px;
    cursor: pointer;
    border: 1px solid;
  }

  .notify-bar-save {
    background: rgba(167, 243, 208, 0.1);
    color: #a7f3d0;
    border-color: rgba(167, 243, 208, 0.3);
  }

  .notify-bar-cancel {
    background: none;
    color: rgba(224, 231, 255, 0.6);
    border-color: rgba(224, 231, 255, 0.15);
  }

  .notify-bar-stop {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
    border-color: rgba(239, 68, 68, 0.3);
  }

  .notify-bar-save:hover { background: rgba(167, 243, 208, 0.2); }
  .notify-bar-cancel:hover { background: rgba(224, 231, 255, 0.05); }
  .notify-bar-stop:hover { background: rgba(239, 68, 68, 0.2); }

  /* === Card Wrapper & Notify Checkbox === */
  .card-wrapper {
    position: relative;
    width: 100%;
    display: flex;
    justify-content: center;
  }

  .notify-checkbox {
    position: absolute;
    top: 0.5rem;
    right: 1.5rem;
    z-index: 10;
    cursor: pointer;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.25rem;
  }

  .notify-checkbox input[type="checkbox"] {
    width: 1.8rem;
    height: 1.8rem;
    accent-color: #a7f3d0;
    cursor: pointer;
  }

  .card-wrapper.notify-active .link-card {
    opacity: 0.4;
    pointer-events: none;
  }

  .card-wrapper.notify-active {
    cursor: pointer;
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

  .modal-tabs {
    display: flex;
    margin-bottom: 1.5rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.1);
  }

  .modal-tab {
    flex: 1;
    background: none;
    border: none;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.15rem;
    color: rgba(224, 231, 255, 0.65);
    padding: 0.75rem 0;
    cursor: pointer;
    transition: all 0.2s;
    border-bottom: 2px solid transparent;
  }

  .modal-tab:hover {
    color: rgba(224, 231, 255, 0.7);
  }

  .modal-tab.active {
    color: var(--engine-accent);
    border-bottom-color: var(--engine-accent);
  }

  .login-error {
    color: #f97316;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    margin: 0 0 0.75rem;
    text-align: center;
  }

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .login-label {
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    color: rgba(224, 231, 255, 0.85);
    margin-bottom: -0.4rem;
  }

  .login-input {
    font-family: "Courier New", monospace;
    font-size: 0.95rem;
    padding: 0.6rem 0.75rem;
    min-height: 44px;
    background: #0d1117;
    border: 1px solid rgba(167, 243, 208, 0.3);
    color: #e0e7ff;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
  }

  .login-input:focus,
  .login-input:focus-visible {
    border-color: var(--engine-accent);
    box-shadow: 0 0 0 2px rgba(167, 243, 208, 0.3);
  }

  .login-input::placeholder {
    color: rgba(224, 231, 255, 0.45);
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

  .submit-btn {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1rem;
    padding: 0.6rem;
    background: var(--engine-accent);
    color: #0d1117;
    border: none;
    cursor: pointer;
    font-weight: 600;
    transition: opacity 0.2s;
  }

  .submit-btn:hover {
    opacity: 0.9;
  }

  .divider {
    text-align: center;
    margin: 1.25rem 0;
    position: relative;
    color: rgba(224, 231, 255, 0.65);
    font-size: 0.85rem;
  }

  .divider::before,
  .divider::after {
    content: "";
    position: absolute;
    top: 50%;
    width: 40%;
    height: 1px;
    background: rgba(224, 231, 255, 0.1);
  }

  .divider::before { left: 0; }
  .divider::after { right: 0; }

  .oauth-buttons {
    display: flex;
    gap: 0.75rem;
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

  .google-btn {
    background: #fff;
    color: #333;
  }

  .google-btn:hover {
    background: #f0f0f0;
  }

  .discord-btn {
    background: #5865F2;
    color: #fff;
  }

  .discord-btn:hover {
    background: #4752c4;
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
  }

  .game-frame {
    width: 100%;
    flex: 1 1 auto;
    min-height: 0;
    border: none;
    display: block;
  }

  .demo-overlay {
    position: absolute;
    inset: 0;
    background: rgba(20, 27, 36, 0.85);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 10;
    border-radius: 4px;
  }

  .demo-overlay span {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 2.5rem;
    color: rgba(224, 231, 255, 0.4);
    letter-spacing: 0.05em;
  }

  /* Build date label — bottom-left of the demo-actions row, mirrored
     from the Steam wishlist button on the right. Same font + color as
     the Play Now CTA so they read as a matched pair. */
  .build-date {
    position: absolute;
    left: 1rem;
    top: 50%;
    transform: translateY(-50%);
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.1rem;
    color: var(--engine-accent);
    letter-spacing: 0.02em;
    cursor: help;
    white-space: nowrap;
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
     they'd collide with the header (sign-in buttons, etc). The .demo-overlay
     "Coming Soon" still covers the image because it's absolute inset:0,
     but the badges sit above it via z-index. */
  @media (max-width: 900px) {
    .overlay-badges {
      /* position: relative (not static) so the z-index from the desktop
         rule still applies and the badges sit ABOVE the demo-overlay
         "Coming Soon" layer for click events. */
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

  .demo-actions {
    display: flex;
    align-items: center;
    position: relative;
    padding: 0.5rem 1rem;
    justify-content: center;
  }

  .demo-actions .steam-btn {
    position: absolute;
    right: 1rem;
    top: 50%;
    transform: translateY(-50%);
  }

  .demo-cta {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.25rem;
    font-weight: 400;
    color: var(--engine-accent);
    letter-spacing: 0.02em;
    text-decoration: none;
    transition: text-decoration 0.2s;
  }

  .demo-cta:hover {
    text-decoration: underline;
  }

  .steam-btn {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.1rem;
    color: var(--engine-accent);
    text-decoration: none;
    padding: 0.4rem 0.75rem;
    border: 1px solid var(--engine-border);
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    height: fit-content;
  }

  .steam-icon {
    width: 1.1rem;
    height: 1.1rem;
    flex-shrink: 0;
  }

  .steam-btn:hover {
    border-color: var(--engine-accent);
    background: rgba(167, 243, 208, 0.1);
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

    .tier-counts {
      align-items: center;
    }

    .tier-pips {
      flex-direction: row;
      gap: 2.5rem;
      width: 100%;
      justify-content: center;
    }

    .tier-pip {
      flex-wrap: wrap;
      justify-content: center;
      gap: 0.15rem 0.35rem;
    }

    .pip-count {
      width: 100%;
      text-align: center;
      margin-left: 0;
    }

    .demo-actions {
      flex-direction: column;
      align-items: center;
      gap: 0.85rem;
      padding: 0.85rem 1rem;
    }

    .demo-actions .steam-btn,
    .demo-actions .build-date {
      position: static;
      transform: none;
      top: auto;
      left: auto;
    }

    .demo-actions .build-date {
      order: 3;
      font-size: 0.95rem;
      opacity: 0.8;
    }

    .demo-actions .demo-cta {
      order: 1;
    }

    .demo-actions .steam-btn {
      order: 2;
    }
  }
</style>
