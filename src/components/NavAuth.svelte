<script lang="ts">
  // Compact Patreon login / account widget for the homepage nav. Mirrors the
  // retired BilateralLayout header: "Continue with Patreon" when logged out,
  // username + tier icon + Sign Out when logged in. Auth is initialised
  // globally by <AuthInit> in BaseLayout, so this only reads the store.
  import { auth, logout, oauthLogin } from "../lib/auth.svelte.ts";

  let loading = $state(false);

  function login() {
    if (loading) return;
    loading = true;
    oauthLogin("patreon");
  }

  function tierIcon(tier: string | undefined) {
    switch (tier) {
      case "admin": return "/tier-admin.png";
      case "legend": return "/tier-legend.png";
      case "hero": return "/tier-hero.png";
      case "initiate": return "/tier-initiate.png";
      default: return "/tier-none.png";
    }
  }
</script>

{#if auth.currentUser}
  <span class="navauth user">
    <img src={tierIcon(auth.currentUser.tier)} alt="" class="tier-ic" />
    <span class="uname">{auth.currentUser.username}</span>
    <button class="signout" onclick={logout}>Sign Out</button>
  </span>
{:else}
  <button
    class="navauth login"
    onclick={login}
    disabled={loading}
    aria-label={loading ? "Redirecting to Patreon" : "Log in with Patreon"}
  >
    {#if loading}
      <span class="spin" aria-hidden="true"></span>Redirecting…
    {:else}
      <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"
        ><path fill="currentColor" d="M14.82 2.41c-3.96 0-7.18 3.22-7.18 7.18 0 3.94 3.22 7.15 7.18 7.15 3.95 0 7.16-3.21 7.16-7.15 0-3.96-3.21-7.18-7.16-7.18zM2 21.6h3.5V2.41H2V21.6z"
      /></svg>
      Log In
    {/if}
  </button>
{/if}

<style>
  .navauth {
    font-family: "AllByteCustom", Georgia, serif;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .login {
    display: inline-flex;
    align-items: center;
    gap: 0.45em;
    font-size: 0.72rem;
    background: var(--crimson, #8a2b21);
    color: #f6eccf;
    padding: 0.42rem 0.9rem;
    border-radius: 2px;
    border: 1px solid var(--gilt-deep, #7a5c22);
    cursor: pointer;
    transition: filter 0.15s;
  }
  .login:hover { filter: brightness(1.08); }
  .login:disabled { opacity: 0.7; cursor: default; }
  .user {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--ink, #3a2c1b);
    font-size: 0.78rem;
    letter-spacing: 0.04em;
  }
  .tier-ic { width: 20px; height: 20px; display: block; }
  .uname { text-transform: none; font-size: 0.92rem; }
  .signout {
    font-family: "AllByteCustom", Georgia, serif;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.62rem;
    background: none;
    border: 1px solid var(--rule, rgba(122, 92, 34, 0.55));
    color: var(--ink-soft, #6a5836);
    padding: 0.22rem 0.55rem;
    border-radius: 2px;
    cursor: pointer;
  }
  .signout:hover { color: var(--crimson, #8a2b21); border-color: var(--gilt, #9a7736); }
  .spin {
    width: 12px; height: 12px; border-radius: 50%;
    border: 2px solid rgba(246, 236, 207, 0.4);
    border-top-color: #f6eccf;
    display: inline-block;
    animation: navauth-spin 0.7s linear infinite;
  }
  @keyframes navauth-spin { to { transform: rotate(360deg); } }
</style>
