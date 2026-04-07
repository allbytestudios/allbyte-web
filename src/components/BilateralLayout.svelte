<script>
  import EnginePanel from "./EnginePanel.svelte";
  import HeartPanel from "./HeartPanel.svelte";
  import gameVersion from "../data/game-version.json";
  let isMobile = $state(false);
  let showLoginModal = $state(false);
  let loginMode = $state("signin");
  let loggedInUser = $state(null);
  let demoHovered = $state(false);
  let artworkHovered = $state(false);
  let musicHovered = $state(false);
  let fontHovered = $state(false);

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
    cursorAudio.volume = 0.35;
    // Play and immediately pause to unlock both
    anthemAudio.play().then(() => anthemAudio.pause()).catch(() => {});
    cursorAudio.play().then(() => { cursorAudio.pause(); cursorAudio.currentTime = 0; }).catch(() => {});
  }

  $effect(() => {
    checkMobile();
    window.addEventListener("resize", checkMobile);
    window.addEventListener("click", initAudio, { once: true });
    window.addEventListener("touchstart", initAudio, { once: true });
    return () => {
      window.removeEventListener("resize", checkMobile);
      if (anthemAudio) { anthemAudio.pause(); anthemAudio = null; }
      if (cursorAudio) { cursorAudio.pause(); cursorAudio = null; }
    };
  });

  function onDemoEnter() {
    demoHovered = true;
    if (anthemAudio && audioReady) {
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
      <h1 class="site-title">
        <img src="/icon.png" alt="" class="site-icon" />
        AllByte Studios
      </h1>
      <div class="login-area">
        {#if loggedInUser}
          <span class="username">{loggedInUser}</span>
          <button class="login-btn" onclick={() => loggedInUser = null}>Log Out</button>
        {:else}
          <button class="login-btn" onclick={() => showLoginModal = true}>Log In</button>
        {/if}
      </div>
    </div>
    <p class="site-tagline">Indie game studio, Devlog, Asset archive</p>
  </header>

  {#if showLoginModal}
    <div class="modal-overlay" onclick={() => showLoginModal = false}>
      <div class="modal" onclick={(e) => e.stopPropagation()}>
        <button class="modal-close" onclick={() => showLoginModal = false}>&times;</button>

        <div class="modal-tabs">
          <button class="modal-tab" class:active={loginMode === "signin"} onclick={() => loginMode = "signin"}>Sign In</button>
          <button class="modal-tab" class:active={loginMode === "signup"} onclick={() => loginMode = "signup"}>Create Account</button>
        </div>

        {#if loginMode === "signin"}
          <form class="login-form" onsubmit={(e) => {
            e.preventDefault();
            const form = e.target;
            const username = form.username.value;
            if (username) {
              loggedInUser = username;
              showLoginModal = false;
            }
          }}>
            <input type="text" name="username" placeholder="Username" class="login-input" required />
            <input type="password" name="password" placeholder="Password" class="login-input" />
            <button type="submit" class="submit-btn">Sign In</button>
          </form>
        {:else}
          <form class="login-form" onsubmit={(e) => {
            e.preventDefault();
            const form = e.target;
            const username = form.username.value;
            if (username) {
              // TODO: Create account backend call
              loggedInUser = username;
              showLoginModal = false;
            }
          }}>
            <input type="text" name="username" placeholder="Username" class="login-input" required />
            <input type="email" name="email" placeholder="Email" class="login-input" required />
            <input type="password" name="password" placeholder="Password" class="login-input" required />
            <input type="password" name="confirm" placeholder="Confirm Password" class="login-input" required />
            <button type="submit" class="submit-btn">Create Account</button>
          </form>
        {/if}

        <div class="divider"><span>or continue with</span></div>

        <div class="oauth-buttons">
          <button class="oauth-btn google-btn" onclick={() => { /* TODO: Google OAuth */ loggedInUser = "Google User"; showLoginModal = false; }}>
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
            Google
          </button>
          <button class="oauth-btn discord-btn" onclick={() => { /* TODO: Discord OAuth */ loggedInUser = "Discord User"; showLoginModal = false; }}>
            <svg viewBox="0 0 24 24" width="18" height="18"><path fill="#fff" d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
            Discord
          </button>
        </div>
      </div>
    </div>
  {/if}

  <div class="demo-section">
  <div class="demo-row" onmouseenter={onDemoEnter} onmouseleave={onDemoLeave} onclick={(e) => { if (!e.target.closest('.steam-btn')) window.location.href = '/play/'; }} style="cursor: pointer;">
    <div class="demo-link">
      <div class="demo-banner">
        <img src={demoHovered ? "/ChroniclesOfNesisTitle.gif" : "/ChroniclesOfNesisTitle-still.png"} alt="The Chronicles of Nesis Demo" class="demo-gif" />
        <img src="/ChroniclesOfNesisTitleName.png" alt="The Chronicles of Nesis" class="demo-title-overlay" />
      </div>
    </div>
    <div class="demo-actions">
      <span class="demo-cta">Play Now v{gameVersion.version} (No Download) &#8594;</span>
      <a href="https://store.steampowered.com/app/3900010/The_Chronicles_of_Nesis/" class="steam-btn" target="_blank" rel="noopener noreferrer">
        <svg class="steam-icon" viewBox="0 0 256 259" xmlns="http://www.w3.org/2000/svg"><path fill="currentColor" d="M127.779 0C57.852 0 .469 55.394.013 124.609L68.95 153.16a35.615 35.615 0 0 1 20.15-6.213l30.15-43.635v-.613c0-26.36 21.457-47.817 47.818-47.817 26.36 0 47.818 21.457 47.818 47.817 0 26.361-21.457 47.818-47.818 47.818h-1.105l-42.926 30.658a35.796 35.796 0 0 1-35.638 37.149 35.87 35.87 0 0 1-34.992-28.333L1.592 168.53C17.2 220.124 65.89 258.18 123.578 258.18c70.692 0 128.003-57.31 128.003-128.003C251.581 59.487 198.47 0 127.779 0zM80.36 208.09l-15.082-6.232a26.887 26.887 0 0 0 14.49 14.088 26.941 26.941 0 0 0 35.26-14.468 26.796 26.796 0 0 0 .001-20.624 26.864 26.864 0 0 0-14.467-14.467l15.594 6.446a21.556 21.556 0 0 1-11.392 41.29 21.56 21.56 0 0 1-24.404-6.033zm114.007-57.39c0-17.568-14.29-31.858-31.858-31.858-17.569 0-31.858 14.29-31.858 31.858 0 17.569 14.29 31.858 31.858 31.858 17.569 0 31.858-14.29 31.858-31.858zm-55.737-.098c0-13.19 10.706-23.896 23.897-23.896 13.19 0 23.896 10.706 23.896 23.896 0 13.19-10.706 23.897-23.896 23.897-13.191 0-23.897-10.706-23.897-23.897z"/></svg>
        Wishlist on Steam &#8594;
      </a>
    </div>
  </div>
  </div>

  {#if isMobile}
    <!-- Mobile: stacked groups -->
    <div class="mobile-panel engine-bg">
      <h2 class="panel-title engine-title"><span class="terminal-prompt">$</span> Game Dev<br/><span class="panel-sub">(built with AI)</span></h2>
      <div class="mobile-links">
        <a href="/devlog/" class="link-card engine-card" onmouseenter={playCursor}>
          <h3>Devlog <span class="cursor-arrow"></span></h3>
          <p>Technical post-mortems and development updates.</p>
        </a>
        <a href="/godot-and-claude/" class="link-card engine-card" onmouseenter={playCursor}>
          <h3>Godot &amp; Claude <span class="cursor-arrow"></span></h3>
          <p>My local setup and how I do gamedev with Godot &amp; Claude.</p>
        </a>
        <a href="/self-hosting-with-claude/" class="link-card engine-card" onmouseenter={playCursor}>
          <h3>Self-Hosting with Claude <span class="cursor-arrow"></span></h3>
          <p>AI-assisted self-hosted game, subscription, and infra.</p>
        </a>
      </div>
    </div>
    <div class="mobile-panel heart-bg" style="position: relative;">
      <img src="/Flourish.png" alt="" class="flourish flourish-left" />
      <h2 class="panel-title heart-title">Game Assets<br/><span class="panel-sub">(made without AI)</span></h2>
      <img src="/Flourish.png" alt="" class="flourish flourish-right" />
      <div class="mobile-links">
        <a href="/music/" class="link-card heart-card" onmouseenter={() => { musicHovered = true; playCursor(); }} onmouseleave={() => musicHovered = false}>
          <h3>Music <img src={musicHovered ? "/leftSword.png" : "/verticalSwordTHIN.png"} alt="" class="sword-icon" /></h3>
          <p>Original compositions for The Chronicles of Nesis.</p>
        </a>
        <a href="/artwork/" class="link-card heart-card" onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
          <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSwordTHIN.png"} alt="" class="sword-icon" /></h3>
          <p>Sprites, pre-rendered backgrounds.</p>
        </a>
        <a href="/fonts/" class="link-card heart-card" onmouseenter={() => { fontHovered = true; playCursor(); }} onmouseleave={() => fontHovered = false}>
          <h3>Font <img src={fontHovered ? "/leftSword.png" : "/verticalSwordTHIN.png"} alt="" class="sword-icon" /></h3>
          <p>A custom typeface designed for The Chronicles of Nesis.</p>
        </a>
      </div>
    </div>
  {:else}
    <!-- Desktop: shared grid -->
    <div class="bilateral-grid">
      <div class="cell engine-bg title-cell">
        <h2 class="panel-title engine-title"><span class="terminal-prompt">$</span> Game Dev<br/><span class="panel-sub">(built with AI)</span></h2>
      </div>
      <div class="cell heart-bg title-cell heart-title-cell">
        <img src="/Flourish.png" alt="" class="flourish flourish-left" />
        <h2 class="panel-title heart-title">Game Assets<br/><span class="panel-sub">(made without AI)</span></h2>
        <img src="/Flourish.png" alt="" class="flourish flourish-right" />
      </div>

      <div class="cell engine-bg">
        <a href="/devlog/" class="link-card engine-card" onmouseenter={playCursor}>
          <h3>Devlog <span class="cursor-arrow"></span></h3>
          <p>Technical post-mortems and development updates.</p>
        </a>
      </div>
      <div class="cell heart-bg">
        <a href="/music/" class="link-card heart-card" onmouseenter={() => { musicHovered = true; playCursor(); }} onmouseleave={() => musicHovered = false}>
          <h3>Music <img src={musicHovered ? "/leftSword.png" : "/verticalSwordTHIN.png"} alt="" class="sword-icon" /></h3>
          <p>Original compositions for The Chronicles of Nesis.</p>
        </a>
      </div>

      <div class="cell engine-bg">
        <a href="/godot-and-claude/" class="link-card engine-card" onmouseenter={playCursor}>
          <h3>Godot &amp; Claude <span class="cursor-arrow"></span></h3>
          <p>My local setup and how I do gamedev with Godot &amp; Claude.</p>
        </a>
      </div>
      <div class="cell heart-bg">
        <a href="/artwork/" class="link-card heart-card" onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
          <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSwordTHIN.png"} alt="" class="sword-icon" /></h3>
          <p>Sprites, pre-rendered backgrounds.</p>
        </a>
      </div>

      <div class="cell engine-bg">
        <a href="/self-hosting-with-claude/" class="link-card engine-card" onmouseenter={playCursor}>
          <h3>Self-Hosting with Claude <span class="cursor-arrow"></span></h3>
          <p>AI-assisted self-hosted game, subscription, and infra.</p>
        </a>
      </div>
      <div class="cell heart-bg">
        <a href="/fonts/" class="link-card heart-card" onmouseenter={() => { fontHovered = true; playCursor(); }} onmouseleave={() => fontHovered = false}>
          <h3>Font <img src={fontHovered ? "/leftSword.png" : "/verticalSwordTHIN.png"} alt="" class="sword-icon" /></h3>
          <p>A custom typeface designed for The Chronicles of Nesis.</p>
        </a>
      </div>
    </div>
  {/if}

  <footer class="site-footer">
    &copy; 2026 AllByte Studios
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
    padding: 2rem 1rem 0.5rem;
    display: flex;
    flex-direction: column;
    align-items: center;
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

  .header-row {
    width: 100%;
    max-width: 1200px;
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
  }

  .login-area {
    position: absolute;
    right: 0;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .username {
    font-family: "Courier New", monospace;
    font-size: 0.9rem;
    color: var(--engine-accent);
  }

  .login-btn {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.3rem;
    color: #e0e7ff;
    background: #141b24;
    border: 1px solid rgba(167, 243, 208, 0.15);
    padding: 0.6rem 1.5rem;
    cursor: pointer;
    transition: all 0.2s;
    font-weight: 600;
    border-radius: 4px;
  }

  .login-btn:hover {
    background: #1a2332;
    border-color: rgba(167, 243, 208, 0.3);
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
    color: rgba(224, 231, 255, 0.4);
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

  .login-form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .login-input {
    font-family: "Courier New", monospace;
    font-size: 0.95rem;
    padding: 0.6rem 0.75rem;
    background: #0d1117;
    border: 1px solid rgba(167, 243, 208, 0.15);
    color: #e0e7ff;
    outline: none;
    transition: border-color 0.2s;
  }

  .login-input:focus {
    border-color: var(--engine-accent);
  }

  .login-input::placeholder {
    color: rgba(224, 231, 255, 0.3);
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
    color: rgba(224, 231, 255, 0.3);
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

  .heart-card p {
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
    color: rgba(224, 231, 255, 0.4);
  }
</style>
