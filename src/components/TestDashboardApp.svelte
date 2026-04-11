<script lang="ts">
  import type { TestIndex, TestRunStatus, RunnerTier } from "../lib/testIndex";
  import type { TestingRoadmap } from "../lib/testingRoadmap";
  import { TIER_META, buildLeafTree } from "../lib/testIndex";
  import { fetchIndex, fetchStatus, fetchRoadmap } from "../lib/testDataSource";
  import TestLeafNode from "./TestLeafNode.svelte";
  import TestStatusCard from "./TestStatusCard.svelte";
  import MilestoneStrip from "./MilestoneStrip.svelte";
  import BlockerPanel from "./BlockerPanel.svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let index = $state<TestIndex | null>(null);
  let status = $state<TestRunStatus | null>(null);
  let roadmap = $state<TestingRoadmap | null>(null);
  let loadError = $state<string | null>(null);
  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));

  // UI state
  let statusFilter = $state<Set<string>>(new Set());
  let search = $state("");
  let activeTab = $state<RunnerTier>(3); // only used in narrow mode

  // Derived: shared tree built from ALL tests + leaves meta. Rendered once per column,
  // each column passes its own `tier` prop to filter the test rows inside.
  let tree = $derived(
    index ? buildLeafTree(index.tests, index.leaves) : []
  );

  let runningIds = $derived.by(() => {
    const s = new Set<string>();
    if (status?.state === "running") {
      for (const w of status.workers) {
        if (w.current_test) s.add(w.current_test);
      }
    }
    return s;
  });

  // Per-tier counts for the column headers
  function tierCount(tier: RunnerTier): number {
    if (!index) return 0;
    return index.tests.filter((t) => t.tier === tier).length;
  }

  // --- fetch loop ---
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let indexTimer: ReturnType<typeof setTimeout> | null = null;
  let abortCtl: AbortController | null = null;

  async function loadIndex() {
    try {
      abortCtl?.abort();
      abortCtl = new AbortController();
      index = await fetchIndex(abortCtl.signal);
      loadError = null;
    } catch (err: any) {
      if (err?.name !== "AbortError") {
        loadError = err?.message ?? String(err);
      }
    }
  }

  async function loadStatus() {
    try {
      status = await fetchStatus();
    } catch {
      // Non-fatal: stale render continues
    }
  }

  async function loadRoadmap() {
    try {
      roadmap = await fetchRoadmap();
    } catch {
      // Non-fatal: milestone strip hides itself
    }
  }

  function scheduleStatus() {
    if (pollTimer) clearTimeout(pollTimer);
    // Tighten to 500ms during an active run; otherwise 2s foreground / 30s background
    const interval =
      status?.state === "running"
        ? 500
        : document.visibilityState === "visible"
          ? 2000
          : 30000;
    pollTimer = setTimeout(async () => {
      await loadStatus();
      scheduleStatus();
    }, interval);
  }

  function scheduleIndex() {
    if (indexTimer) clearTimeout(indexTimer);
    indexTimer = setTimeout(async () => {
      await loadIndex();
      await loadRoadmap();
      scheduleIndex();
    }, 30000);
  }

  onMount(() => {
    loadIndex();
    loadRoadmap();
    loadStatus().then(() => {
      scheduleStatus();
    });
    scheduleIndex();
    const onVis = () => scheduleStatus();
    document.addEventListener("visibilitychange", onVis);
    return () => document.removeEventListener("visibilitychange", onVis);
  });

  onDestroy(() => {
    if (pollTimer) clearTimeout(pollTimer);
    if (indexTimer) clearTimeout(indexTimer);
    abortCtl?.abort();
  });

  // --- filter helpers ---
  const STATUS_CHIPS = [
    { key: "passing", label: "pass", color: "#a7f3d0" },
    { key: "failing", label: "fail", color: "#f87171" },
    { key: "xfail", label: "xfail", color: "#fbbf24" },
    { key: "xpass", label: "xpass", color: "#fbbf24" },
    { key: "skipped", label: "skip", color: "#9ca3af" },
    { key: "unknown", label: "unknown", color: "#6b7280" },
    { key: "running", label: "running", color: "#a7f3d0" },
  ] as const;

  function toggleStatus(key: string) {
    const next = new Set(statusFilter);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    statusFilter = next;
  }

  function clearFilters() {
    statusFilter = new Set();
    search = "";
  }
</script>

<div class="dashboard">
  {#if !auth.authReady}
    <div class="gate-card">
      <p class="gate-loading">Loading…</p>
    </div>
  {:else if !viewerHasAccess}
    <div class="gate-card">
      <h2>Hero tier required</h2>
      <p>The live test suite dashboard is part of the <strong>Hero</strong> subscription tier and above.</p>
      {#if !auth.currentUser}
        <p>Sign in from the home page, then subscribe to Hero or Legend to unlock it.</p>
      {:else}
        <p>You're signed in as <code>{auth.currentUser.email}</code> with tier <code>{auth.currentUser.tier ?? "default"}</code>. Upgrade to Hero or above to view test results, run history, and live activity.</p>
      {/if}
      <p class="gate-cta">
        <a class="gate-link" href="/subscribe/">View subscription tiers →</a>
      </p>
    </div>
  {:else}
  {#if loadError}
    <div class="error-banner">
      <strong>Test index not available.</strong> {loadError}
    </div>
  {/if}

  {#if index}
    <!-- Summary header -->
    <div class="summary">
      <span class="total"><strong>{index.summary.total_tests}</strong> tests</span>
      <span class="sep">·</span>
      <span><strong>{tierCount(1)}</strong> {TIER_META[1].name}</span>
      <span class="sep">·</span>
      <span><strong>{tierCount(2)}</strong> {TIER_META[2].name}</span>
      <span class="sep">·</span>
      <span><strong>{tierCount(3)}</strong> {TIER_META[3].name}</span>
      <span class="sep">·</span>
      <span class="commit" title={index.repo.commit}>
        @{index.repo.commit.slice(0, 7)} {index.repo.branch}
      </span>
      {#if index.summary.last_full_run_seconds != null}
        <span class="sep">·</span>
        <span>last full run {Math.round(index.summary.last_full_run_seconds)}s</span>
      {/if}
    </div>

    <!-- Live run status card (only renders if status file exists) -->
    <TestStatusCard {status} />

    <!-- Milestone strip (only renders if roadmap file exists) -->
    <MilestoneStrip {roadmap} {index} />

    <!-- Blocker panel (only renders if known_blockers[] is non-empty) -->
    <BlockerPanel {roadmap} />

    <!-- Filter bar -->
    <div class="filters">
      <input
        class="search"
        type="search"
        placeholder="Filter tests by name…"
        bind:value={search}
      />
      <div class="chips">
        {#each STATUS_CHIPS as chip (chip.key)}
          <button
            type="button"
            class="chip"
            class:active={statusFilter.has(chip.key)}
            style="--c: {chip.color}"
            onclick={() => toggleStatus(chip.key)}
          >
            {chip.label}
          </button>
        {/each}
        {#if statusFilter.size > 0 || search}
          <button type="button" class="chip clear" onclick={clearFilters}>clear</button>
        {/if}
      </div>
    </div>

    <!-- Tab bar (only visible on narrow viewports) -->
    <div class="tabs">
      {#each [1, 2, 3] as t}
        <button
          type="button"
          class="tab"
          class:active={activeTab === t}
          onclick={() => (activeTab = t as RunnerTier)}
        >
          {TIER_META[t as RunnerTier].name}
          <span class="tab-count">{tierCount(t as RunnerTier)}</span>
        </button>
      {/each}
    </div>

    <!-- Three-column grid, one per runner tier -->
    <div class="columns">
      {#each [1, 2, 3] as t}
        {@const tier = t as RunnerTier}
        <section class="column" class:hidden={activeTab !== tier} data-tier={tier}>
          <header class="col-header" style="--tier-color: {TIER_META[tier].color}">
            <span class="col-title">{TIER_META[tier].name}</span>
            <span class="col-sub">Tier {tier}</span>
            <span class="col-count">{tierCount(tier)}</span>
          </header>
          {#if tierCount(tier) === 0}
            <div class="empty-column">
              {#if tier === 2}
                <p>Integration tests are planned but not yet implemented.</p>
                <p class="muted">This column will populate when Tier 2 GUT tests land.</p>
              {:else}
                <p>No tests of this tier yet.</p>
              {/if}
            </div>
          {:else}
            <div class="tree">
              {#each tree as domain (domain.path)}
                <TestLeafNode
                  node={domain}
                  {tier}
                  {runningIds}
                  {statusFilter}
                  {search}
                  topLevel={true}
                />
              {/each}
            </div>
          {/if}
        </section>
      {/each}
    </div>
  {:else if !loadError}
    <div class="loading">Loading test index…</div>
  {/if}
  {/if}
</div>

<style>
  .dashboard {
    max-width: 1600px;
    margin: 0 auto;
    padding: 0.75rem 1rem 2rem;
    color: #e5e7eb;
  }
  .error-banner {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.4);
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    color: #fca5a5;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
  }
  .gate-card {
    max-width: 640px;
    margin: 4rem auto;
    padding: 2rem 2.25rem;
    background: #12161e;
    border: 1px solid rgba(251, 191, 36, 0.4);
    border-radius: 6px;
    text-align: center;
    font-family: "Courier New", monospace;
    color: #d1d5db;
  }
  .gate-card h2 {
    color: #fbbf24;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 1.05rem;
    margin: 0 0 0.85rem;
  }
  .gate-card p {
    margin: 0.5rem 0;
    line-height: 1.5;
    font-size: 0.9rem;
  }
  .gate-card code {
    background: rgba(255, 255, 255, 0.05);
    color: #a7f3d0;
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    font-size: 0.85rem;
  }
  .gate-card strong { color: #fbbf24; }
  .gate-loading { color: #9ca3af; font-style: italic; }
  .gate-cta { margin-top: 1.4rem; }
  .gate-link {
    display: inline-block;
    color: #fbbf24;
    text-decoration: none;
    border: 1px solid rgba(251, 191, 36, 0.5);
    padding: 0.55rem 1.1rem;
    border-radius: 4px;
    font-weight: 700;
    letter-spacing: 0.04em;
    transition: background 0.15s, border-color 0.15s;
  }
  .gate-link:hover {
    background: rgba(251, 191, 36, 0.12);
    border-color: rgba(251, 191, 36, 0.85);
  }
  .loading {
    text-align: center;
    color: #9ca3af;
    padding: 3rem;
    font-family: "Courier New", monospace;
  }
  .summary {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    color: #d1d5db;
  }
  .summary strong { color: #a7f3d0; }
  .sep { color: #4b5563; }
  .commit { color: #9ca3af; }
  .filters {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin: 0.5rem 0 0.75rem;
    flex-wrap: wrap;
  }
  .search {
    flex: 1 1 250px;
    max-width: 400px;
    background: #1a1e26;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 4px;
    padding: 0.45rem 0.7rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
  }
  .search:focus {
    outline: none;
    border-color: rgba(167, 243, 208, 0.6);
  }
  .chips {
    display: flex;
    gap: 0.35rem;
    flex-wrap: wrap;
  }
  .chip {
    background: transparent;
    border: 1px solid rgba(156, 163, 175, 0.25);
    color: #9ca3af;
    padding: 0.25rem 0.6rem;
    border-radius: 12px;
    font-family: "Courier New", monospace;
    font-size: 0.72rem;
    cursor: pointer;
    transition: all 0.1s;
  }
  .chip:hover {
    border-color: var(--c, rgba(167, 243, 208, 0.5));
    color: var(--c, #e5e7eb);
  }
  .chip.active {
    background: color-mix(in srgb, var(--c) 15%, transparent);
    border-color: var(--c);
    color: var(--c);
  }
  .chip.clear {
    border-color: rgba(248, 113, 113, 0.35);
    color: #fca5a5;
  }

  /* Tab bar — only visible on narrow viewports */
  .tabs {
    display: none;
    gap: 0.4rem;
    margin-bottom: 0.6rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.15);
  }
  .tab {
    background: transparent;
    border: none;
    color: #9ca3af;
    padding: 0.5rem 0.9rem;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    font-weight: 600;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .tab:hover { color: #e5e7eb; }
  .tab.active {
    color: #a7f3d0;
    border-bottom-color: #a7f3d0;
  }
  .tab-count {
    font-size: 0.7rem;
    background: rgba(255, 255, 255, 0.08);
    padding: 0.05rem 0.35rem;
    border-radius: 8px;
    color: inherit;
  }

  /* Three-column grid */
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr 1fr;
    gap: 1rem;
  }
  .column {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 6px;
    padding: 0.75rem 0.6rem;
    min-width: 0;
  }
  .col-header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    padding-bottom: 0.5rem;
    margin-bottom: 0.5rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.15);
  }
  .col-title {
    color: var(--tier-color, #a7f3d0);
    font-weight: 700;
    font-size: 1rem;
    font-family: "Courier New", monospace;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .col-sub { color: #6b7280; font-size: 0.75rem; font-family: "Courier New", monospace; }
  .col-count {
    margin-left: auto;
    color: #9ca3af;
    font-size: 0.8rem;
    font-family: "Courier New", monospace;
  }
  .empty-column {
    padding: 2rem 1rem;
    text-align: center;
    color: #9ca3af;
    font-size: 0.82rem;
    font-family: "Courier New", monospace;
  }
  .empty-column p { margin: 0.3rem 0; }
  .empty-column .muted { color: #6b7280; font-size: 0.75rem; }
  .tree {
    max-height: calc(100vh - 280px);
    overflow-y: auto;
    padding-right: 0.25rem;
  }

  /* Narrow: collapse to tabs */
  @media (max-width: 1199px) {
    .tabs { display: flex; }
    .columns {
      grid-template-columns: 1fr;
    }
    .column.hidden { display: none; }
  }
  @media (min-width: 1200px) {
    .column.hidden { display: block; }
  }
</style>
