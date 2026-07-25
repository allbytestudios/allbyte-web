<script lang="ts">
  import EnginePanel from "./EnginePanel.svelte";
  import HeartPanel from "./HeartPanel.svelte";
  import gameVersion from "../data/game-version.json";
  import { auth, initAuth, logout, oauthLogin, saveNotificationPrefs } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import { pickerVersions, defaultVersion, versionById, isUnlocked } from "../lib/gameVersions";
  import { onMount } from "svelte";

  let isMobile = $state(false);
  let loginError = $state("");
  let oauthLoading = $state<"google" | "discord" | "patreon" | null>(null);
  let pendingAction = $state<string | null>(null);

  function startOAuth(provider: "google" | "discord" | "patreon") {
    if (oauthLoading) return;
    if (pendingAction) sessionStorage.setItem("allbyte_pending_action", pendingAction);
    oauthLoading = provider;
    oauthLogin(provider);
  }
  // Patreon-only auth: the header CTA goes straight to OAuth (startOAuth), so
  // there's no provider-picker modal to focus-trap anymore.
  let demoHovered = $state(false);
  // Tier-gated game-version picker (above the Play-Now gif). pickerList is the
  // deployed builds; locked ones render disabled as an upsell. selectedVersionId
  // is the manual pick, falling back to the richest build the user can play
  // (re-resolves once auth hydrates).
  let pickedVersionId = $state<string | null>(null);
  // Runtime-deployed channels (beta / beta-debug / develop), fetched from
  // /godot/channels.json in onMount. Lets a deploy self-publish its own
  // availability with no source flip / commit / rebuild. null until fetched;
  // alpha/alpha-debug stay available via their static flag regardless.
  let runtimeChannels = $state<Record<string, unknown> | null>(null);
  const pickerList = $derived(pickerVersions(runtimeChannels));
  const selectedVersionId = $derived(pickedVersionId ?? defaultVersion(auth.currentUser, runtimeChannels).id);

  // Show each build's deployed version + freshness in the picker, so it's obvious
  // when develop (or beta-debug) has a NEW build live. Runtime channels come from
  // channels.json (version + deployedAt, epoch seconds); alpha/alpha-debug use the
  // committed site version. Read at render — refreshes on the next channels.json fetch.
  function relTime(sec?: number): string {
    if (!sec || typeof sec !== "number") return "";
    const diff = Date.now() / 1000 - sec;
    if (diff < 90) return "just now";
    if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
    if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
    return `${Math.round(diff / 86400)}d ago`;
  }
  function channelTag(id: string): string {
    const c = runtimeChannels?.[id] as { version?: string; deployedAt?: number } | undefined;
    if (c && typeof c === "object" && c.version) {
      // Version only — the relative-time suffix overflowed the collapsed select.
      return ` · ${c.version}`;
    }
    if (id === "alpha" || id === "alpha-debug") {
      const v = gameVersion.version?.replace(/^v/, "");
      return v ? ` · v${v}` : "";
    }
    return "";
  }

  // PWA install prompt: Chrome/Edge fires `beforeinstallprompt` on
  // browsers/devices that meet the PWA install criteria (manifest valid,
  // SW active, served over HTTPS, not already installed). We capture and
  // defer the event so the user can trigger it from our own button rather
  // than the browser's subtle URL-bar icon. iOS Safari and Firefox don't
  // fire this event — the button just stays hidden there.
  let installPrompt = $state<any>(null);
  let isInstalled = $state(false);

  onMount(() => {
    // Fetch the runtime channel manifest a deploy publishes to S3. Best-effort:
    // on failure (not deployed yet / offline) we fall back to the static flags,
    // so alpha/alpha-debug still work. Cache-busted so a fresh push shows up.
    fetch("/godot/channels.json", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((j) => { if (j && typeof j === "object") runtimeChannels = j; })
      .catch(() => { /* fall back to static availability */ });

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

  // Consolidated: all play happens on /play (a single embed surface). Navigating
  // there is a REAL page load, so the browser Back button returns home as users
  // expect — unlike the old in-place iframe swap, which was a same-page state
  // change with no history entry. The picker's selected build rides along as ?v;
  // /play resolves + tier-gates it, and owns the download gate, fullscreen, save
  // bridge, and analytics.
  function launchGame() {
    window.location.href = `/play/?v=${encodeURIComponent(selectedVersionId)}`;
  }

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
          {#if auth.currentUser}
            <button class="header-btn login-btn" onclick={logout}><span>Sign</span><span>Out</span></button>
          {:else}
            <div class="patreon-cta">
              <button class="patreon-cta-btn" disabled={oauthLoading !== null} onclick={() => startOAuth("patreon")} aria-label={oauthLoading === "patreon" ? "Redirecting to Patreon" : "Continue with Patreon"}>
                {#if oauthLoading === "patreon"}
                  <span class="oauth-spinner oauth-spinner-light" aria-hidden="true"></span>
                  Redirecting…
                {:else}
                  <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path fill="#fff" d="M14.82 2.41c-3.96 0-7.18 3.22-7.18 7.18 0 3.94 3.22 7.15 7.18 7.15 3.95 0 7.16-3.21 7.16-7.15 0-3.96-3.21-7.18-7.16-7.18zM2 21.6h3.5V2.41H2V21.6z"/></svg>
                  Continue with Patreon
                {/if}
              </button>
              <a href="/subscribe/" class="patreon-cta-tiers">See tier benefits ›</a>
            </div>
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


  <div class="demo-section">
    <div class="demo-row" style="position: relative;" onclick={launchGame} onmouseenter={onDemoEnter} onmouseleave={onDemoLeave}>
      <div class="demo-link">
        <div class="demo-banner">
          <img src={demoHovered ? "/ChroniclesOfNesisTitle.gif" : "/ChroniclesOfNesisTitle-still.png"} alt="The Chronicles of Nesis Demo" class="demo-gif" />
          <img src="/ChroniclesOfNesisTitleName.png" alt="The Chronicles of Nesis" class="demo-title-overlay" />
          <div class="demo-version-stack">
            <span class="demo-version-overlay" aria-label={`Build version ${gameVersion.version}`}>
              {gameVersion.version.startsWith("v") ? gameVersion.version : `v${gameVersion.version}`}
            </span>
            <a class="demo-changelog-link" href="/changelog/" onclick={(e) => e.stopPropagation()}>What's new ›</a>
          </div>
        </div>
      </div>
      <div class="demo-actions">
        <div class="demo-cta-group">
          <button class="demo-cta play-cta" type="button" aria-label="Play in browser">
            Play In Browser
          </button>
          <a class="demo-cta manual-cta" href="/manual/" onclick={(e) => e.stopPropagation()} aria-label="Read the game manual">
            Read Game Manual
          </a>
          {#if installPrompt && !isInstalled}
            <button class="demo-cta install-cta" type="button" onclick={(e) => { e.stopPropagation(); handleInstallClick(); }} aria-label="Install Chronicles as an app on this device">
              Install as App
            </button>
          {/if}
        </div>
      </div>
      {#if pickerList.length > 1}
        <div class="version-picker" onclick={(e) => e.stopPropagation()} role="presentation">
          <label class="version-picker-label" for="game-version-select">Version</label>
          <select
            id="game-version-select"
            class="version-select"
            value={selectedVersionId}
            onchange={(e) => (pickedVersionId = (e.currentTarget as HTMLSelectElement).value)}
          >
            {#each pickerList as v (v.id)}
              <option value={v.id} disabled={!isUnlocked(v, auth.currentUser)}>
                {isUnlocked(v, auth.currentUser)
                  ? `${v.label}${channelTag(v.id)}`
                  : `${v.label} — ${v.minTier === "legend" ? "Legend" : "Initiate+"}`}
              </option>
            {/each}
          </select>
        </div>
      {/if}
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
          <a href="/artwork/" class="link-card heart-card" onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
            <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Sprites, screenshots, music &amp; the ModernGoth typeface.</p>
            <span class="entry-count heart-count">Free · Initiate+ unlocks all</span>
          </a>
        </div>
        <div class="card-wrapper">
          {#if isAdmin(auth.currentUser)}
            <a href="/walkthrough/" class="link-card heart-card" onmouseenter={playCursor}>
              <h3>Walkthrough <span class="wt-badge">admin preview</span></h3>
              <p>A scene by scene published guide to Nesis</p>
              <span class="entry-count heart-count">Legend · in progress</span>
            </a>
          {:else}
            <div class="link-card heart-card locked" role="note" aria-label="Walkthrough — coming soon, Legend tier">
              <h3>Walkthrough <span class="lock" aria-hidden="true">🔒</span></h3>
              <p>A scene by scene published guide to Nesis</p>
              <span class="entry-count heart-count">Legend · coming soon</span>
            </div>
          {/if}
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
            <span class="entry-count">Free · drafts for Hero+</span>
          </a>
        </div>
        <div class="card-wrapper">
          <a href="/test/" class="link-card engine-card" onmouseenter={playCursor}>
            <h3>Dev Console <span class="cursor-arrow"></span></h3>
            <p>Live build status, tests, save tree, milestones.</p>
            <span class="entry-count">Free overview · Hero+ for depth</span>
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
            <p>Engineering, workflow, strategy, narrative &amp; craft posts.</p>
            <span class="entry-count">Free · drafts for Hero+</span>
          </a>
        </div>
      </div>
      <div class="cell heart-bg">
        <div class="card-wrapper">
          <a href="/artwork/" class="link-card heart-card" onmouseenter={() => { artworkHovered = true; playCursor(); }} onmouseleave={() => artworkHovered = false}>
            <h3>Artwork <img src={artworkHovered ? "/BattleChargeRight.gif" : "/BattleChargeRight-still.png"} alt="" class="battle-icon" /> <img src={artworkHovered ? "/leftSword.png" : "/verticalSword.png"} alt="" class="sword-icon" /></h3>
            <p>Sprites, screenshots, music &amp; the ModernGoth typeface.</p>
            <span class="entry-count heart-count">Free · Initiate+ unlocks all</span>
          </a>
        </div>
      </div>

      <div class="cell engine-bg">
        <div class="card-wrapper">
          <a href="/test/" class="link-card engine-card" onmouseenter={playCursor}>
            <h3>Dev Console <span class="cursor-arrow"></span></h3>
            <p>Live build status, tests, save tree, milestones.</p>
            <span class="entry-count">Free overview · Hero+ for depth</span>
          </a>
        </div>
      </div>
      <div class="cell heart-bg">
        <div class="card-wrapper">
          {#if isAdmin(auth.currentUser)}
            <a href="/walkthrough/" class="link-card heart-card" onmouseenter={playCursor}>
              <h3>Walkthrough <span class="wt-badge">admin preview</span></h3>
              <p>A scene by scene published guide to Nesis</p>
              <span class="entry-count heart-count">Legend · in progress</span>
            </a>
          {:else}
            <div class="link-card heart-card locked" role="note" aria-label="Walkthrough — coming soon, Legend tier">
              <h3>Walkthrough <span class="lock" aria-hidden="true">🔒</span></h3>
              <p>A scene by scene published guide to Nesis</p>
              <span class="entry-count heart-count">Legend · coming soon</span>
            </div>
          {/if}
        </div>
      </div>
    </div>
  {/if}

  <footer class="site-footer">
    <div class="footer-social">
      {#if auth.currentUser}
        <button
          class="notify-bar-btn footer-social-btn"
          onclick={toggleSubscribed}
          disabled={notifySaving}
          title={auth.currentUser.notificationPreferences ? "Unsubscribe from email updates" : "Subscribe to email updates"}
        >
          &#9993; {auth.currentUser.notificationPreferences ? "Subscribed ✓" : "Email Me Updates"}
        </button>
      {/if}
      <a href="https://discord.gg/WfYC6gFJe" class="notify-bar-btn footer-social-btn discord-notify-btn" target="_blank" rel="noopener noreferrer" title="Join the AllByte Discord server">
        <svg class="discord-inline-icon" viewBox="0 0 127.14 96.36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z"/></svg>
        Discord
      </a>
      <a href="https://www.youtube.com/@AllByteStudios" class="notify-bar-btn footer-social-btn youtube-notify-btn" target="_blank" rel="noopener noreferrer" title="AllByte Studios on YouTube">
        <svg class="youtube-inline-icon" viewBox="0 0 461.001 461.001" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M365.257,67.393H95.744C42.866,67.393,0,110.259,0,163.137v134.728c0,52.878,42.866,95.744,95.744,95.744h269.513c52.878,0,95.744-42.866,95.744-95.744V163.137C461.001,110.259,418.135,67.393,365.257,67.393z M300.506,237.056l-126.06,60.123c-3.359,1.602-7.239-0.847-7.239-4.568V168.607c0-3.774,3.982-6.22,7.348-4.514l126.06,63.881C304.363,229.873,304.298,235.248,300.506,237.056z"/></svg>
        YouTube
      </a>
      <a href="https://store.steampowered.com/app/3900010/The_Chronicles_of_Nesis/" class="notify-bar-btn footer-social-btn steam-notify-btn" target="_blank" rel="noopener noreferrer" title="The Chronicles of Nesis on Steam">
        <svg class="steam-inline-icon" viewBox="0 0 256 259" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M127.779 0C57.852 0 .469 55.394.013 124.609L68.95 153.16a35.615 35.615 0 0 1 20.15-6.213l30.15-43.635v-.613c0-26.36 21.457-47.817 47.818-47.817 26.36 0 47.818 21.457 47.818 47.817 0 26.361-21.457 47.818-47.818 47.818h-1.105l-42.926 30.658a35.796 35.796 0 0 1-35.638 37.149 35.87 35.87 0 0 1-34.992-28.333L1.592 168.53C17.2 220.124 65.89 258.18 123.578 258.18c70.692 0 128.003-57.31 128.003-128.003C251.581 59.487 198.47 0 127.779 0zM80.36 208.09l-15.082-6.232a26.887 26.887 0 0 0 14.49 14.088 26.941 26.941 0 0 0 35.26-14.468 26.796 26.796 0 0 0 .001-20.624 26.864 26.864 0 0 0-14.467-14.467l15.594 6.446a21.556 21.556 0 0 1-11.392 41.29 21.56 21.56 0 0 1-24.404-6.033zm114.007-57.39c0-17.568-14.29-31.858-31.858-31.858-17.569 0-31.858 14.29-31.858 31.858 0 17.569 14.29 31.858 31.858 31.858 17.569 0 31.858-14.29 31.858-31.858zm-55.737-.098c0-13.19 10.706-23.896 23.897-23.896 13.19 0 23.896 10.706 23.896 23.896 0 13.19-10.706 23.897-23.896 23.897-13.191 0-23.897-10.706-23.897-23.897z"/></svg>
        Steam
      </a>
      <a href="https://x.com/AllByteStudios" class="notify-bar-btn footer-social-btn x-notify-btn" target="_blank" rel="noopener noreferrer" title="AllByte Studios on X">
        <svg class="x-inline-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><path fill="currentColor" d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
        X
      </a>
    </div>
    <a href="mailto:allbytestudios@gmail.com" class="footer-contact">allbytestudios@gmail.com</a>
    <nav class="footer-legal">
      <a href="https://www.patreon.com/cw/AllByteStudios" target="_blank" rel="noopener">Patreon</a>
      <span class="footer-legal-sep" aria-hidden="true">·</span>
      <a href="/privacy/">Privacy</a>
      <span class="footer-legal-sep" aria-hidden="true">·</span>
      <a href="/terms/">Terms</a>
    </nav>
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

  /* Patreon-only auth CTA: one Patreon-branded button (straight to OAuth) with
     a small "See tier benefits" link beneath. Replaced the old Join + Login
     buttons + the provider-picker modal. */
  .patreon-cta {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 0.3rem;
  }
  .patreon-cta-btn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    background: #ff424d;
    color: #fff;
    border: none;
    border-radius: 4px;
    padding: 0.55rem 1.1rem;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.05rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.2s ease;
    white-space: nowrap;
  }
  .patreon-cta-btn:hover:not(:disabled) { background: #e63a44; }
  .patreon-cta-btn:disabled { opacity: 0.7; cursor: default; }
  .patreon-cta-tiers {
    text-align: center;
    font-size: 0.78rem;
    color: #a7f3d0;
    text-decoration: none;
    letter-spacing: 0.02em;
  }
  .patreon-cta-tiers:hover { text-decoration: underline; }


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

  .x-notify-btn {
    color: #a7f3d0 !important;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .x-inline-icon {
    width: 0.9em;
    height: 0.9em;
    color: #e7ecff;
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


  .version-picker {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    justify-content: center;
    margin: 0.5rem auto 0;
    max-width: 960px;
    width: 90%;
    font-family: "Courier New", Courier, monospace;
  }

  .version-picker-label {
    font-size: 0.78rem;
    color: rgba(167, 243, 208, 0.7);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .version-select {
    background: #0d1117;
    color: #e0e7ff;
    border: 1px solid rgba(167, 243, 208, 0.3);
    border-radius: 4px;
    padding: 0.3rem 0.6rem;
    font-family: inherit;
    font-size: 0.85rem;
    cursor: pointer;
  }

  .version-select:hover {
    border-color: rgba(167, 243, 208, 0.6);
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
  .demo-version-stack {
    position: absolute;
    bottom: 0.6rem;
    right: 0.8rem;
    display: flex;
    flex-direction: column;
    align-items: flex-end;
    gap: 0.25rem;
    pointer-events: none; /* version passes clicks through to Play; link re-enables below */
  }
  .demo-version-overlay {
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    color: rgba(167, 243, 208, 0.85);
    background: rgba(10, 14, 23, 0.55);
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
    letter-spacing: 0.02em;
    line-height: 1;
  }
  .demo-changelog-link {
    pointer-events: auto;
    font-family: "Courier New", monospace;
    font-size: 0.72rem;
    color: rgba(167, 243, 208, 0.95);
    background: rgba(10, 14, 23, 0.7);
    padding: 0.12rem 0.45rem;
    border-radius: 3px;
    text-decoration: none;
    border: 1px solid rgba(167, 243, 208, 0.3);
    line-height: 1;
    transition: background 0.15s ease, border-color 0.15s ease;
  }
  .demo-changelog-link:hover {
    background: rgba(167, 243, 208, 0.15);
    border-color: rgba(167, 243, 208, 0.6);
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
  .manual-cta {
    /* Same boxed CTA treatment as Play — it's an <a>, so drop the underline. */
    text-decoration: none;
    display: inline-block;
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

  /* Locked (coming-soon) card — non-admins. Not a link, dimmed. */
  .heart-card.locked { opacity: 0.72; cursor: default; }
  .heart-card.locked .lock { font-size: 0.95em; }
  .wt-badge {
    font-family: "Courier New", monospace;
    font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em;
    background: var(--heart-accent); color: var(--heart-card-bg);
    padding: 0.1rem 0.4rem; border-radius: 3px; vertical-align: middle;
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

  .footer-social {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: center;
    gap: 1.25rem;
    margin-bottom: 0.6rem;
  }

  .footer-social-btn {
    font-size: 1.05rem;
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

  .footer-legal {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  .footer-legal a {
    color: rgba(224, 231, 255, 0.6);
    text-decoration: none;
    transition: color 0.2s;
  }

  .footer-legal a:hover {
    color: rgba(224, 231, 255, 0.9);
  }

  .footer-legal-sep {
    opacity: 0.4;
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
