<script lang="ts">
  // Homepage hero Play control. One button for normal play — its target is the
  // richest build the visitor's tier unlocks (free → Episode One, patrons → Beta once it
  // ships). Admins additionally get a dropdown caret to reach the debug channels.
  // /play reads the choice from ?v=<id> (GodotEmbed). Auth is initialised globally
  // by <AuthInit>; runtime channel availability comes from /godot/channels.json.
  import { onMount } from "svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier.ts";
  import {
    GAME_VERSIONS,
    defaultVersion,
    isAvailable,
    versionById,
    type RuntimeChannels,
  } from "../lib/gameVersions.ts";
  import PixelTransition from "./PixelTransition.svelte";

  let runtime = $state<RuntimeChannels>(null);
  let open = $state(false);

  onMount(async () => {
    try {
      const r = await fetch("/godot/channels.json", { cache: "no-store" });
      if (r.ok) runtime = await r.json();
    } catch {
      /* dev / not published yet → only the always-on builds are offered */
    }
  });

  // Robustness through Back. play() flips `transitioning` true and hard-navigates
  // to /play. Pressing Back restores this page from bfcache with that state frozen
  // true — so the next Play press hit `if (transitioning) return` and did nothing
  // (and a stale obscure overlay could linger). Reset on every show/restore so
  // Play always works again after Back. pageshow(persisted) = bfcache restore;
  // astro:after-swap = ClientRouter nav back to home.
  onMount(() => {
    const reset = () => {
      transitioning = false;
      open = false;
    };
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) reset();
    };
    window.addEventListener("pageshow", onShow);
    document.addEventListener("astro:after-swap", reset);
    return () => {
      window.removeEventListener("pageshow", onShow);
      document.removeEventListener("astro:after-swap", reset);
    };
  });

  const def = $derived(defaultVersion(auth.currentUser, runtime));
  const admin = $derived(isAdmin(auth.currentUser));
  const primaryLabel = "Play";

  // Glass-shatter entrance. Phase 1 (obscure) plays HERE over the homepage; when
  // it has the page fully hidden we navigate to /play, which plays phase 2
  // (reveal) with the SAME fracture (matched by seed) and drops the shards to
  // reveal the AllByte screen. We prefetch the game on press so the load still
  // starts immediately, behind the glass.
  let transitioning = $state(false);
  let transitionSeed = $state(1);
  let pendingUrl = "";

  function prefetchGame(id: string) {
    try {
      const v = versionById(id);
      const dir = (v?.path ?? "/godot/public/index.html").replace(/index\.html$/, "");
      for (const f of ["index.wasm", "index.pck"]) {
        const l = document.createElement("link");
        l.rel = "prefetch";
        l.href = dir + f;
        document.head.appendChild(l);
      }
    } catch {
      /* best-effort warm-up */
    }
  }

  function play(id: string) {
    pendingUrl = `/play/?v=${encodeURIComponent(id)}`;
    transitionSeed = Math.floor(Math.random() * 2_000_000_000) || 1;
    try {
      sessionStorage.setItem("ab_play_transition", "1");
      sessionStorage.setItem("ab_play_seed", String(transitionSeed));
    } catch {
      /* private mode — /play just skips phase 2 and shows its own intro */
    }
    prefetchGame(id);
    if (transitioning) return;
    transitioning = true; // renders the obscure-phase glass over the homepage
  }
  function onObscureDone() {
    window.location.href = pendingUrl;
  }
  function onDocClick(e: MouseEvent) {
    if (!(e.target as HTMLElement)?.closest(".heroplay")) open = false;
  }
</script>

<svelte:document onclick={onDocClick} />

<span class="heroplay">
  <button class="btn btn-primary btn-lg play-main" class:split={admin} onclick={() => play(def.id)}>
    {primaryLabel}
  </button>

  {#if admin}
    <button
      class="btn btn-primary btn-lg caret"
      aria-label="Choose a build"
      aria-expanded={open}
      onclick={() => (open = !open)}
    >▾</button>

    {#if open}
      <ul class="builds" role="menu">
        {#each GAME_VERSIONS as v (v.id)}
          {@const avail = isAvailable(v, runtime)}
          <li role="none">
            <button
              role="menuitem"
              class:current={v.id === def.id}
              disabled={!avail}
              onclick={() => play(v.id)}
            >
              <span class="lbl">{v.label}</span>
              {#if !avail}<span class="tag">not deployed</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</span>

{#if transitioning}
  <PixelTransition ondone={onObscureDone} />
{/if}

<style>
  .heroplay {
    position: relative;
    display: inline-flex;
    align-items: stretch;
  }
  .heroplay .play-main {
    flex: 1 1 auto;
    justify-content: center;
  }
  /* split-button look only when the admin caret is present (main squares its
     right edge, caret squares its left); otherwise the button keeps full radius */
  .heroplay .play-main.split {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }
  .caret {
    border-top-left-radius: 0;
    border-bottom-left-radius: 0;
    border-left: 1px solid rgba(0, 0, 0, 0.28);
    padding-left: 0.7rem;
    padding-right: 0.7rem;
    font-size: 0.9rem;
  }
  .builds {
    position: absolute;
    top: calc(100% + 6px);
    right: 0;
    z-index: 20;
    min-width: 200px;
    margin: 0;
    padding: 0.3rem;
    list-style: none;
    background: linear-gradient(rgba(245, 236, 210, 0.98), rgba(240, 229, 198, 0.98));
    border: 1px solid var(--gilt-lt, #c8a24e);
    border-radius: 3px;
    box-shadow: 0 12px 28px rgba(0, 0, 0, 0.4);
  }
  .builds button {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.8rem;
    width: 100%;
    padding: 0.5rem 0.7rem;
    background: none;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    text-align: left;
    font-family: "AllByteCustom", Georgia, serif;
    color: var(--ink, #3a2c1b);
    font-size: 0.95rem;
  }
  .builds button:hover:not(:disabled) {
    background: rgba(154, 119, 54, 0.16);
  }
  .builds button.current .lbl {
    color: var(--crimson, #8a2b21);
  }
  .builds button:disabled {
    opacity: 0.5;
    cursor: default;
  }
  .builds .tag {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--ink-soft, #6a5836);
  }
</style>
