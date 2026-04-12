<script lang="ts">
  import { auth, devLogin, logout } from "../lib/auth.svelte.ts";
  import { TIER_ORDER, tierLabel, tierColor } from "../lib/tier";

  let open = $state(false);
</script>

{#if import.meta.env.DEV}
  <div class="dev-switcher">
    <button class="dev-toggle" onclick={() => (open = !open)}>
      DEV {auth.currentUser ? auth.currentUser.tier : "signed out"}
    </button>
    {#if open}
      <div class="dev-menu">
        {#each TIER_ORDER as t}
          <button
            class="dev-tier"
            class:active={auth.currentUser?.tier === t}
            style="color: {tierColor(t)}"
            onclick={() => { devLogin(t); open = false; }}
          >
            {tierLabel(t)}
          </button>
        {/each}
        <button class="dev-tier signout" onclick={() => { logout(); open = false; }}>
          Sign out
        </button>
      </div>
    {/if}
  </div>
{/if}

<style>
  .dev-switcher {
    position: fixed;
    bottom: 0.75rem;
    left: 0.75rem;
    z-index: 9999;
    font-family: "Courier New", monospace;
    font-size: 0.75rem;
  }
  .dev-toggle {
    background: #1a1e26;
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.5);
    border-radius: 4px;
    padding: 0.35rem 0.65rem;
    cursor: pointer;
    font-family: inherit;
    font-size: inherit;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .dev-toggle:hover { background: #242a34; }
  .dev-menu {
    position: absolute;
    bottom: 100%;
    left: 0;
    margin-bottom: 0.35rem;
    background: #1a1e26;
    border: 1px solid rgba(251, 191, 36, 0.4);
    border-radius: 4px;
    padding: 0.3rem;
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 100px;
  }
  .dev-tier {
    background: none;
    border: none;
    padding: 0.35rem 0.6rem;
    font-family: inherit;
    font-size: inherit;
    cursor: pointer;
    text-align: left;
    border-radius: 3px;
    color: #d1d5db;
  }
  .dev-tier:hover { background: rgba(255, 255, 255, 0.06); }
  .dev-tier.active { background: rgba(251, 191, 36, 0.15); font-weight: 700; }
  .dev-tier.signout { color: #f87171; }
</style>
