<script lang="ts">
  import type { TestIndex, TestRunStatus, RunnerTier } from "../lib/testIndex";
  import { TIER_META, buildLeafTree } from "../lib/testIndex";
  import { fetchIndex, fetchStatus } from "../lib/testDataSource";
  import TestLeafNode from "./TestLeafNode.svelte";
  import TestStatusCard from "./TestStatusCard.svelte";
  import { onMount, onDestroy } from "svelte";

  let index = $state<TestIndex | null>(null);
  let status = $state<TestRunStatus | null>(null);
  let loadError = $state<string | null>(null);

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
      scheduleIndex();
    }, 30000);
  }

  onMount(() => {
    loadIndex();
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
