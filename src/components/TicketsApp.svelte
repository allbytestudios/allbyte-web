<script lang="ts">
  import type { BdIssue } from "../lib/beadsTypes";
  import { epicsOnly, isOpen, isClosed, partitionLanes } from "../lib/beadsTypes";
  import { fetchBeadsIssues } from "../lib/beadsSource";
  import { milestonesOrdered, milestoneIdFromLabels, milestoneMeta } from "../lib/milestones";
  import { subscribeToFile } from "../lib/testEvents";
  import { onMount, onDestroy } from "svelte";

  let issues = $state<BdIssue[]>([]);
  let loadError = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let sseUnsub: (() => void) | null = null;

  // Per-epic fold state — open epic shows the description.
  const FOLD_KEY = "epic-folds";
  let openFolds = $state<Set<string>>(new Set());
  function toggleFold(id: string) {
    const next = new Set(openFolds);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    openFolds = next;
    try { sessionStorage.setItem(FOLD_KEY, JSON.stringify([...next])); } catch {}
  }

  async function load() {
    try {
      issues = await fetchBeadsIssues();
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  onMount(() => {
    try {
      const raw = sessionStorage.getItem(FOLD_KEY);
      if (raw) openFolds = new Set(JSON.parse(raw) as string[]);
      const v = sessionStorage.getItem(VIEW_KEY);
      if (v === "epics" || v === "lanes") view = v;
    } catch {}
    load();
    pollTimer = setInterval(load, 30000);
    sseUnsub = subscribeToFile(".beads/issues.jsonl", load);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (sseUnsub) sseUnsub();
  });

  // ---- Derived state ----

  let epics = $derived(epicsOnly(issues));

  // 3-lane owner view (CON_CLAUDE_BEADS_WEBAPP_3LANE.md): Backlog / Needing
  // Verified / Completed, partitioned from the live beads issues.
  let lanes = $derived(partitionLanes(issues));
  const VIEW_KEY = "tickets-view";
  let view = $state<"lanes" | "epics">("lanes");
  function setView(v: "lanes" | "epics") {
    view = v;
    try { sessionStorage.setItem(VIEW_KEY, v); } catch {}
  }
  const LANE_DEFS = [
    { key: "backlog", label: "Backlog", cap: 200 },
    { key: "needs-verify", label: "Needing Verified", cap: 200 },
    { key: "completed", label: "Completed", cap: 60 },
  ] as const;
  function shortId(id: string): string {
    return id.replace(/^ChroniclesOfNesis-/, "");
  }

  // Milestone filter — defaults to "current" milestone.
  const DEFAULT_MS = milestonesOrdered().find((m) => m.status === "current")?.id ?? "all";
  let filterMilestone = $state<string>(DEFAULT_MS);

  function epicMilestoneId(e: BdIssue): string {
    return milestoneIdFromLabels(e.labels) ?? "_unscoped";
  }

  let visibleEpics = $derived(
    filterMilestone === "all"
      ? epics
      : epics.filter((e) => epicMilestoneId(e) === filterMilestone)
  );

  let onDeck = $derived(visibleEpics.filter(isOpen));
  let completed = $derived(visibleEpics.filter(isClosed));

  // Sort: priority ascending (P1=highest), then most-recently-updated.
  function comparePriority(a: BdIssue, b: BdIssue): number {
    if (a.priority !== b.priority) return a.priority - b.priority;
    return b.updated_at.localeCompare(a.updated_at);
  }
  let onDeckSorted = $derived([...onDeck].sort(comparePriority));
  let completedSorted = $derived(
    [...completed].sort((a, b) => (b.closed_at ?? b.updated_at).localeCompare(a.closed_at ?? a.updated_at))
  );

  // Milestone filter buttons — show all milestones plus an "All" option.
  interface MsButton { id: string; label: string; open: number; closed: number; }
  let msButtons = $derived.by<MsButton[]>(() => {
    const buttons: MsButton[] = [{ id: "all", label: "All", open: epics.filter(isOpen).length, closed: epics.filter(isClosed).length }];
    for (const meta of milestonesOrdered()) {
      const inMs = epics.filter((e) => epicMilestoneId(e) === meta.id);
      buttons.push({
        id: meta.id,
        label: meta.label,
        open: inMs.filter(isOpen).length,
        closed: inMs.filter(isClosed).length,
      });
    }
    return buttons;
  });

  function priorityLabel(p: number): string {
    if (p === 0) return "P0";
    if (p === 1) return "P1";
    if (p === 2) return "P2";
    if (p === 3) return "P3";
    return `P${p}`;
  }
  function priorityColor(p: number): string {
    if (p <= 0) return "var(--sem-danger)";    // P0
    if (p === 1) return "var(--sem-warn)";   // P1
    if (p === 2) return "var(--sem-info)";   // P2
    return "var(--ink-soft)";                // P3+
  }

  function fmtDate(iso: string | undefined): string {
    if (!iso) return "";
    const d = new Date(iso);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
  }

  function msLabelForEpic(e: BdIssue): string {
    const id = epicMilestoneId(e);
    if (id === "_unscoped") return "Unscoped";
    return milestoneMeta(id)?.label ?? id;
  }
</script>

<div class="tickets">
  {#if loadError}
    <div class="error-banner">Failed to load: {loadError}</div>
  {/if}

  <div class="view-toggle">
    <button class="vt-btn" class:vt-active={view === "lanes"} onclick={() => setView("lanes")}>Lanes</button>
    <button class="vt-btn" class:vt-active={view === "epics"} onclick={() => setView("epics")}>Epics</button>
  </div>

  {#if view === "lanes"}
    <div class="lanes">
      {#each LANE_DEFS as ld (ld.key)}
        {@const items = lanes[ld.key]}
        <section class="lane lane-{ld.key}">
          <h2 class="lane-title">
            <span class="lane-dot"></span>{ld.label}
            <span class="lane-count">{items.length}</span>
          </h2>
          <div class="lane-scroll">
            {#if items.length === 0}
              <p class="lane-empty">Nothing here.</p>
            {:else}
              {#each items.slice(0, ld.cap) as it (it.id)}
                <div class="bead">
                  <div class="bead-top">
                    <span class="bead-pri" style="color: {priorityColor(it.priority)}">{priorityLabel(it.priority)}</span>
                    <span class="bead-type">{it.issue_type}</span>
                    <span class="bead-meta">{shortId(it.id)} · {fmtDate(it.updated_at)}</span>
                  </div>
                  <div class="bead-title">{it.title}</div>
                </div>
              {/each}
              {#if items.length > ld.cap}
                <p class="lane-more">+ {items.length - ld.cap} more</p>
              {/if}
            {/if}
          </div>
        </section>
      {/each}
    </div>
  {/if}

  {#if view === "epics"}
  <!-- Milestone filter buttons -->
  <div class="ms-filters">
    {#each msButtons as b (b.id)}
      <button
        class="ms-btn"
        class:ms-active={filterMilestone === b.id}
        onclick={() => (filterMilestone = b.id)}
      >
        <span class="ms-btn-label">{b.label}</span>
        <span class="ms-btn-count ms-btn-count-open">{b.open}</span>
        {#if b.closed > 0}<span class="ms-btn-count ms-btn-count-done">{b.closed}</span>{/if}
      </button>
    {/each}
  </div>

  <!-- On Deck -->
  <section class="section">
    <h2 class="section-title">
      <span class="section-marker section-marker-deck"></span>
      On Deck
      <span class="section-count">{onDeckSorted.length}</span>
    </h2>
    {#if onDeckSorted.length === 0}
      <p class="section-empty">No epics on deck for this milestone.</p>
    {:else}
      <ul class="epic-list">
        {#each onDeckSorted as e (e.id)}
          {@const open = openFolds.has(e.id)}
          <li class="epic-card">
            <button class="epic-head" onclick={() => toggleFold(e.id)} aria-expanded={open}>
              <span class="epic-pri" style="color: {priorityColor(e.priority)}">{priorityLabel(e.priority)}</span>
              <span class="epic-id">{e.id}</span>
              <span class="epic-title">{e.title}</span>
              <span class="epic-ms">{msLabelForEpic(e)}</span>
              <span class="epic-fold-arrow" class:open>›</span>
            </button>
            {#if open && e.description}
              <div class="epic-body">
                <p>{e.description}</p>
                <div class="epic-meta">
                  <span>Updated {fmtDate(e.updated_at)}</span>
                </div>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- Completed -->
  <section class="section">
    <h2 class="section-title">
      <span class="section-marker section-marker-done"></span>
      Completed
      <span class="section-count">{completedSorted.length}</span>
    </h2>
    {#if completedSorted.length === 0}
      <p class="section-empty">No epics completed yet for this milestone.</p>
    {:else}
      <ul class="epic-list">
        {#each completedSorted as e (e.id)}
          {@const open = openFolds.has(e.id)}
          <li class="epic-card epic-done">
            <button class="epic-head" onclick={() => toggleFold(e.id)} aria-expanded={open}>
              <span class="epic-pri" style="color: {priorityColor(e.priority)}">{priorityLabel(e.priority)}</span>
              <span class="epic-id">{e.id}</span>
              <span class="epic-title">{e.title}</span>
              <span class="epic-ms">{msLabelForEpic(e)}</span>
              <span class="epic-closed-at">{fmtDate(e.closed_at)}</span>
              <span class="epic-fold-arrow" class:open>›</span>
            </button>
            {#if open}
              <div class="epic-body">
                {#if e.description}<p>{e.description}</p>{/if}
                {#if e.close_reason}<p class="epic-close-reason"><strong>Closed:</strong> {e.close_reason}</p>{/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>
  {/if}
</div>

<style>
  .view-toggle { display: flex; gap: 0.4rem; margin: 0 0 0.9rem; }
  .vt-btn {
    background: rgba(148, 163, 184, 0.08);
    border: 1px solid rgba(148, 163, 184, 0.25);
    color: var(--ink);
    font-family: inherit; font-size: 0.8rem;
    padding: 0.32rem 0.9rem; border-radius: 6px; cursor: pointer;
  }
  .vt-btn:hover { color: #e2e8f0; border-color: rgba(148, 163, 184, 0.45); }
  .vt-active { background: var(--paperblend); border-color: var(--rule); color: var(--crimson); }

  .lanes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.9rem; align-items: start; }
  @media (max-width: 820px) { .lanes { grid-template-columns: 1fr; } }
  .lane {
    background: var(--panel);
    border: 1px solid rgba(148, 163, 184, 0.18);
    border-radius: 8px; padding: 0.6rem 0.6rem 0.4rem;
  }
  .lane-title { display: flex; align-items: center; gap: 0.45rem; font-size: 0.9rem; margin: 0 0 0.55rem; color: var(--ink); }
  .lane-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gilt); }
  .lane-backlog .lane-dot { background: var(--sem-info); }
  .lane-needs-verify .lane-dot { background: var(--sem-warn); }
  .lane-completed .lane-dot { background: var(--crimson); }
  .lane-count {
    margin-left: auto; font-size: 0.75rem; color: var(--ink-soft);
    background: rgba(148, 163, 184, 0.12); padding: 0.05rem 0.45rem; border-radius: 10px;
  }
  .lane-scroll { max-height: 72vh; overflow-y: auto; display: flex; flex-direction: column; gap: 0.4rem; }
  .lane-empty { font-size: 0.78rem; color: var(--ink-soft); padding: 0.3rem; }
  .lane-more { font-size: 0.74rem; color: var(--ink-soft); text-align: center; padding: 0.3rem; }
  .bead {
    background: var(--panel);
    border: 1px solid rgba(148, 163, 184, 0.15);
    border-radius: 6px; padding: 0.4rem 0.5rem;
  }
  .lane-completed .bead { opacity: 0.72; }
  .bead-top { display: flex; align-items: center; gap: 0.4rem; margin-bottom: 0.2rem; }
  .bead-pri { font-size: 0.72rem; font-weight: 700; }
  .bead-type {
    font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.03em;
    color: var(--ink); background: rgba(148, 163, 184, 0.12);
    padding: 0.02rem 0.35rem; border-radius: 3px;
  }
  .bead-meta { margin-left: auto; font-size: 0.68rem; color: var(--ink-soft); }
  .bead-title { font-size: 0.8rem; line-height: 1.35; color: var(--ink); word-break: break-word; }

  .tickets {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0.75rem 1rem 2rem;
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }

  .error-banner {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.4);
    color: var(--sem-danger);
    padding: 0.5rem 0.75rem;
    border-radius: 4px;
    margin-bottom: 0.75rem;
    font-size: 0.85rem;
  }

  /* ---- Milestone filter buttons ---- */
  .ms-filters {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
    margin: 0 0 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid var(--rule);
  }
  .ms-btn {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    background: var(--panel);
    border: 1px solid var(--rule);
    color: var(--ink-soft);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.35rem 0.7rem;
    border-radius: 4px;
    cursor: pointer;
    transition: color 0.15s, border-color 0.15s;
  }
  .ms-btn:hover { color: var(--ink); border-color: var(--rule); }
  .ms-btn.ms-active {
    color: var(--crimson);
    border-color: var(--crimson);
    background: var(--paperblend);
  }
  .ms-btn-label { font-weight: 600; }
  .ms-btn-count {
    font-size: 0.72rem;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    background: rgba(107, 114, 128, 0.15);
    color: var(--ink-soft);
  }
  .ms-btn-count-open { color: var(--sem-info); background: rgba(96, 165, 250, 0.12); }
  .ms-btn-count-done { color: var(--crimson); background: var(--paperblend); }

  /* ---- Sections ---- */
  .section { margin: 1.25rem 0; }
  .section-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    color: var(--ink);
    font-size: 1rem;
    font-weight: 700;
    margin: 0 0 0.6rem;
  }
  .section-marker {
    width: 4px;
    height: 1.1rem;
    border-radius: 2px;
  }
  .section-marker-deck { background: var(--sem-info); }
  .section-marker-done { background: var(--crimson); }
  .section-count {
    background: var(--paperblend);
    color: var(--crimson);
    border: 1px solid var(--rule);
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
  }
  .section-empty {
    color: var(--ink-soft);
    font-style: italic;
    margin: 0.5rem 0 0;
    font-size: 0.88rem;
  }

  /* ---- Epic cards ---- */
  .epic-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .epic-card {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 4px;
    overflow: hidden;
  }
  .epic-card.epic-done { opacity: 0.75; }
  .epic-head {
    width: 100%;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.55rem 0.8rem;
    background: transparent;
    border: none;
    color: inherit;
    font-family: inherit;
    font-size: 0.85rem;
    text-align: left;
    cursor: pointer;
  }
  .epic-head:hover { background: var(--paperblend); }
  .epic-pri {
    font-weight: 700;
    flex-shrink: 0;
    width: 1.8rem;
  }
  .epic-id {
    color: var(--ink-soft);
    font-size: 0.78rem;
    flex-shrink: 0;
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  .epic-title {
    flex: 1 1 auto;
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }
  .epic-ms {
    color: var(--ink-soft);
    font-size: 0.75rem;
    padding: 0.05rem 0.4rem;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 3px;
    flex-shrink: 0;
  }
  .epic-closed-at {
    color: var(--crimson);
    font-size: 0.75rem;
    flex-shrink: 0;
  }
  .epic-fold-arrow {
    color: var(--ink-soft);
    font-size: 1rem;
    transition: transform 0.15s;
    transform: rotate(0deg);
    flex-shrink: 0;
  }
  .epic-fold-arrow.open { transform: rotate(90deg); }
  .epic-body {
    padding: 0.6rem 0.8rem 0.8rem;
    border-top: 1px solid var(--rule);
    font-size: 0.85rem;
    color: var(--ink);
    line-height: 1.5;
  }
  .epic-body p { margin: 0 0 0.4rem; }
  .epic-body p:last-child { margin-bottom: 0; }
  .epic-meta {
    margin-top: 0.5rem;
    color: var(--ink-soft);
    font-size: 0.75rem;
  }
  .epic-close-reason {
    color: var(--ink-soft);
    font-style: italic;
    border-left: 2px solid var(--rule);
    padding-left: 0.5rem;
    margin-top: 0.5rem;
  }

  @media (max-width: 640px) {
    .epic-head { flex-wrap: wrap; }
    .epic-ms, .epic-closed-at { font-size: 0.7rem; }
    .ms-btn { font-size: 0.78rem; padding: 0.3rem 0.5rem; }
  }
</style>
