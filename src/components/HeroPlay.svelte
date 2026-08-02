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
    type RuntimeChannels,
  } from "../lib/gameVersions.ts";

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

  const def = $derived(defaultVersion(auth.currentUser, runtime));
  const admin = $derived(isAdmin(auth.currentUser));
  const primaryLabel = "Play";

  function play(id: string) {
    window.location.href = `/play/?v=${encodeURIComponent(id)}`;
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
