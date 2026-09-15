<script lang="ts">
  /**
   * Playtime-at-a-glance for the Builder's Workshop landing page.
   *
   * The question this answers: "are people PLAYING, or just serving the game?"
   * A session count can't tell those apart — a bounce that never boots and a
   * 25-minute run both count as one session. So this graphs TIME, not arrivals.
   *
   * Counting rule (server-side, play-analytics.yaml): a day's playtime sums
   * `dur` ONLY over sessions that got PAST Title. A bounce contributes zero
   * rather than dragging the number toward noise — the same reason the API keeps
   * `median_played` separate from `median`.
   *
   * Exclusions come free: the read Lambda already collects datacenter bots and
   * known automation (CI Deploy QA / Playwright) into separate buckets, so they
   * never enter `sessions` and therefore never enter playtime. What it does NOT
   * yet exclude is the owner's own play — see the note rendered below.
   */
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount } from "svelte";

  const READ_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/funnel";

  type Day = {
    date: string;
    sessions: number;
    booted: number;
    past?: number;
    bots?: number;
    played_s?: number;
    played_sessions?: number;
    longest_s?: number;
  };
  type Funnel = {
    daily?: Day[];
    median_played?: number;
    automationSessions?: number;
    botSessions?: number;
  };

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<Funnel | null>(null);

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    if (!isAdmin(auth.currentUser)) {
      loading = false;
      return;
    }
    try {
      const res = await fetch(READ_URL, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${auth.authToken}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      data = (await res.json()) as Funnel;
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  });

  // Older deployments of the read Lambda don't send played_s. Detect that
  // instead of rendering a flat zero line that looks like "nobody played".
  let days = $derived((data?.daily ?? []).slice(-21));
  let hasPlaytime = $derived(days.some((d) => d.played_s != null));
  let totalS = $derived(days.reduce((a, d) => a + (d.played_s ?? 0), 0));
  let totalSessions = $derived(days.reduce((a, d) => a + (d.played_sessions ?? 0), 0));
  let longestS = $derived(days.reduce((a, d) => Math.max(a, d.longest_s ?? 0), 0));
  let peak = $derived(Math.max(1, ...days.map((d) => d.played_s ?? 0)));

  function fmt(s: number): string {
    if (!s) return "0m";
    if (s < 60) return `${s}s`;
    if (s < 3600) return `${Math.round(s / 60)}m`;
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m ? `${h}h ${m}m` : `${h}h`;
  }
  function dayLabel(d: string): string {
    return d.slice(5); // MM-DD
  }
</script>

{#if viewerIsAdmin}
  <section class="pt-card">
    <header>
      <h3>Playtime <span class="sub">are they playing, or just loading?</span></h3>
      {#if data?.median_played}
        <span class="median">median run {fmt(data.median_played)}</span>
      {/if}
    </header>

    {#if loading}
      <p class="muted">Loading…</p>
    {:else if error}
      <p class="err">Couldn’t load playtime: {error}</p>
    {:else if !days.length}
      <p class="muted">No sessions recorded yet.</p>
    {:else if !hasPlaytime}
      <p class="muted">
        This deployment of the funnel API predates per-day playtime. Redeploy
        <code>play-analytics.yaml</code> to populate it.
      </p>
    {:else}
      <div class="totals">
        <div><strong>{fmt(totalS)}</strong><span>played, last {days.length}d</span></div>
        <div><strong>{totalSessions}</strong><span>real play sessions</span></div>
        <div><strong>{fmt(longestS)}</strong><span>longest single run</span></div>
      </div>

      <div class="chart" role="img" aria-label="Daily playtime for the last {days.length} days">
        {#each days as d}
          <div
            class="col"
            title="{d.date}: {fmt(d.played_s ?? 0)} across {d.played_sessions ?? 0} session{(d.played_sessions ?? 0) === 1 ? '' : 's'}{d.bots ? ` (${d.bots} bot/automation excluded)` : ''}"
          >
            <div class="bar" style="height: {Math.round(((d.played_s ?? 0) / peak) * 100)}%"></div>
            <span class="tick">{dayLabel(d.date)}</span>
          </div>
        {/each}
      </div>

      <p class="note">
        Counts only sessions that got <em>past Title</em>, so loading the page
        without playing contributes nothing.
        {#if data?.automationSessions || data?.botSessions}
          Excluded server-side:
          {#if data.automationSessions}{data.automationSessions} automation{/if}{#if data.automationSessions && data.botSessions} · {/if}{#if data.botSessions}{data.botSessions} datacenter bot{/if}.
        {/if}
        <strong>Owner play is NOT excluded yet</strong> — beacons are anonymous, so
        your own sessions look like anyone’s.
      </p>
    {/if}
  </section>
{/if}

<style>
  .pt-card {
    border: 1px solid var(--engine-border, #2a2f3a);
    background: var(--engine-panel, #12151c);
    border-radius: 10px;
    padding: 1rem 1.1rem 0.9rem;
    margin: 1.25rem 0;
  }
  header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  h3 {
    margin: 0 0 0.6rem;
    font-size: 0.95rem;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--engine-accent, #a7f3d0);
  }
  .sub {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.8rem;
    color: var(--engine-muted, #8a93a6);
    margin-left: 0.5rem;
  }
  .median {
    font-size: 0.8rem;
    color: var(--engine-muted, #8a93a6);
    font-variant-numeric: tabular-nums;
  }
  .totals {
    display: flex;
    gap: 1.75rem;
    flex-wrap: wrap;
    margin: 0.35rem 0 0.9rem;
  }
  .totals div {
    display: flex;
    flex-direction: column;
  }
  .totals strong {
    font-size: 1.3rem;
    color: var(--engine-text, #e6eaf2);
    font-variant-numeric: tabular-nums;
  }
  .totals span {
    font-size: 0.72rem;
    color: var(--engine-muted, #8a93a6);
  }
  .chart {
    display: flex;
    align-items: flex-end;
    gap: 3px;
    height: 110px;
    overflow-x: auto;
    padding-bottom: 1.1rem;
    position: relative;
  }
  .col {
    flex: 1 1 0;
    min-width: 14px;
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: flex-end;
    position: relative;
  }
  .bar {
    background: linear-gradient(180deg, var(--engine-accent, #a7f3d0), #3f8f77);
    border-radius: 2px 2px 0 0;
    min-height: 2px;
    transition: height 0.2s ease;
  }
  .tick {
    position: absolute;
    bottom: -1.05rem;
    left: 0;
    right: 0;
    text-align: center;
    font-size: 0.58rem;
    color: var(--engine-muted, #8a93a6);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .note {
    font-size: 0.72rem;
    color: var(--engine-muted, #8a93a6);
    margin: 0.5rem 0 0;
    line-height: 1.5;
  }
  .muted { color: var(--engine-muted, #8a93a6); font-size: 0.85rem; }
  .err { color: #f7a1a1; font-size: 0.85rem; }
  @media (prefers-reduced-motion: reduce) {
    .bar { transition: none; }
  }
</style>
