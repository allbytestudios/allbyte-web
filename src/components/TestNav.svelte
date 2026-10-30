<script lang="ts">
  import { fetchBugCounts } from "../lib/bugReports";
  import { auth } from "../lib/auth.svelte";
  import { onMount, onDestroy } from "svelte";

  interface Props {
    active: "roadmap" | "saves" | "gametext" | "deploy" | "audience" | "bugs" | "dialogue" | "vignettes" | "cards";
  }
  let { active }: Props = $props();

  // Bugs: yellow=unread (untriaged), grey=total. Needs the auth token, so it only
  // populates for admins; on failure we keep the last value rather than blanking.
  // The other badges (tests, epics, questions) left with their tabs.
  let bugUnread = $state<number | null>(null);
  let bugTotal = $state<number | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    const bugs = await fetchBugCounts(auth.authToken).catch(() => null);
    if (bugs) {
      bugUnread = bugs.unread > 0 ? bugs.unread : null;
      bugTotal = bugs.total;
    }
  }

  onMount(() => {
    refresh();
    pollTimer = setInterval(refresh, 15000);
    // Bug counts need the auth token; re-run once auth is ready so the badge
    // appears promptly instead of waiting for the next 15s poll.
    (async () => {
      let waited = 0;
      while (!auth.authReady && waited < 5000) {
        await new Promise((r) => setTimeout(r, 100));
        waited += 100;
      }
      if (auth.authReady) refresh();
    })();
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });
</script>

<nav class="test-nav">
  <!-- Workshop IA (owner-approved 2026-10-29): Console · Saves · Deploy ·
       Audience · Bugs · Game Text. Dialogue / Vignettes / Cards stay until each
       kind cuts over to Game Text (dialogue first), then they go. Retired tabs redirect
       (astro.config.mjs `redirects`). -->
  <a href="/test/" class="nav-tab" class:active={active === "roadmap"}>
    Console
  </a>
  <a href="/test/saves/" class="nav-tab" class:active={active === "saves"}>
    Saves
  </a>
  <a href="/test/game-text/" class="nav-tab" class:active={active === "gametext"}>
    Game Text
  </a>
  <a href="/test/deploy/" class="nav-tab" class:active={active === "deploy"}>
    Deploy
  </a>
  <a href="/test/audience/" class="nav-tab" class:active={active === "audience"}>
    Audience
  </a>
  <a href="/test/bug-reports/" class="nav-tab" class:active={active === "bugs"}>
    Bugs
    {#if bugUnread}
      <span class="nav-count nav-yellow">{bugUnread}</span>
    {/if}
    <span class="nav-count nav-grey">{bugTotal ?? 0}</span>
  </a>
  <a href="/test/dialogue/" class="nav-tab" class:active={active === "dialogue"}>
    Dialogue
  </a>
  <a href="/test/vignettes/" class="nav-tab" class:active={active === "vignettes"}>
    Vignettes
  </a>
  <a href="/test/cards/" class="nav-tab" class:active={active === "cards"}>
    Cards
  </a>
</nav>

<style>
  .test-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    max-width: 1600px;
    margin: 0 auto;
    padding: 0.5rem 0.5rem 0;
    border-bottom: 1px solid var(--rule);
    position: sticky;
    top: 77px;            /* pin just under the sticky PageHeader (~77px tall on desktop) */
    z-index: 90;          /* below the header (z-index 100) */
    background: var(--panel);  /* opaque + matches the page shell, so any px of gap/overlap is invisible */
  }
  /* Mobile: don't stick — the grid nav is tall and would eat the small screen.
     Scroll it away normally; the sticky pin is a desktop affordance only. */
  @media (max-width: 768px) {
    .test-nav { position: static; }
  }
  .nav-tab {
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    font-size: 0.85rem;
    color: var(--ink-soft);
    text-decoration: none;
    padding: 0.55rem 0.75rem;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .nav-tab:hover {
    color: var(--ink);
  }
  .nav-tab.active {
    color: var(--crimson);
    border-bottom-color: var(--crimson);
  }
  .nav-count {
    font-size: 0.75rem;
    color: var(--ink-soft);
    background: var(--paperblend);
    border: 1px solid var(--rule);
    padding: 0.08rem 0.35rem;
    border-radius: 3px;
  }
  .nav-tab.active .nav-count {
    color: var(--crimson);
    border-color: var(--rule);
  }
  .nav-green {
    color: var(--crimson) !important;
    background: var(--panel) !important;
    border-color: var(--panel) !important;
    font-weight: 700;
  }
  .nav-yellow {
    color: var(--sem-warn) !important;
    background: rgba(251, 191, 36, 0.15) !important;
    border-color: var(--sem-warn) !important;
    font-weight: 700;
  }
  .nav-grey {
    color: var(--ink-soft) !important;
    background: rgba(107, 114, 128, 0.08) !important;
    border-color: rgba(107, 114, 128, 0.2) !important;
  }
  .nav-red {
    color: var(--sem-danger) !important;
    background: rgba(248, 113, 113, 0.15) !important;
    border-color: var(--sem-danger) !important;
    font-weight: 700;
  }

  @media (max-width: 640px) {
    .test-nav {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.25rem;
      padding: 0.5rem;
    }
    .nav-tab {
      padding: 0.5rem 0.35rem;
      font-size: 0.78rem;
      border: 1px solid var(--rule);
      border-radius: 4px;
      min-height: 52px;
      flex-wrap: wrap;
      gap: 0.2rem;
    }
    .nav-tab.active {
      border-color: var(--crimson);
      border-bottom-color: var(--crimson);
      background: var(--paperblend);
    }
    .nav-count {
      font-size: 0.7rem;
      padding: 0.02rem 0.2rem;
    }
  }
</style>
