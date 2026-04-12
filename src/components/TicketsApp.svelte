<script lang="ts">
  import type { TicketsFile, Ticket, TicketPriority } from "../lib/ticketTypes";
  import {
    PRIORITY_ORDER, PRIORITY_META, EXPERT_META,
    statusColor, subtaskProgress,
  } from "../lib/ticketTypes";
  import type { TestingRoadmap } from "../lib/testingRoadmap";
  import type { TestIndex } from "../lib/testIndex";
  import { fetchTickets, fetchRoadmap, fetchIndex } from "../lib/testDataSource";
  import MilestoneStrip from "./MilestoneStrip.svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));

  let tickets = $state<TicketsFile | null>(null);
  let roadmap = $state<TestingRoadmap | null>(null);
  let testIndex = $state<TestIndex | null>(null);
  let loadError = $state<string | null>(null);
  let filterPriority = $state<TicketPriority | "all">("all");
  let filterStatus = $state<string>("all");

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const [t, r, idx] = await Promise.all([fetchTickets(), fetchRoadmap(), fetchIndex()]);
      tickets = t;
      roadmap = r;
      testIndex = idx;
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  onMount(() => {
    load();
    pollTimer = setInterval(load, 10000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  let grouped = $derived.by<Record<TicketPriority, Ticket[]>>(() => {
    const g: Record<TicketPriority, Ticket[]> = { P0: [], P1: [], P2: [], P3: [], done: [] };
    if (!tickets) return g;
    for (const t of tickets.tickets) {
      const p = t.priority as TicketPriority;
      if (p in g) g[p].push(t);
      else g.P3.push(t);
    }
    return g;
  });

  let filtered = $derived.by<Ticket[]>(() => {
    if (!tickets) return [];
    let list = tickets.tickets;
    if (filterPriority !== "all") {
      list = list.filter((t) => t.priority === filterPriority);
    }
    if (filterStatus !== "all") {
      list = list.filter((t) => t.status === filterStatus);
    }
    return list;
  });

  let allStatuses = $derived<string[]>(() => {
    if (!tickets) return [];
    return [...new Set(tickets.tickets.map((t) => t.status))].sort();
  });

  function relativeDate(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }
</script>

<div class="tickets-page">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Hero tier required</h2>
      <p>Full ticket board with subtask detail, reproduction steps, and file references is a <strong>Hero</strong> tier perk. The public overview is at <a href="/test/">/test/</a>.</p>
      <p><a href="/subscribe/">View subscription tiers →</a></p>
    </div>
  {:else}
  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  {#if tickets}
    <MilestoneStrip {roadmap} index={testIndex} />

    <div class="summary-bar">
      <span class="total">{tickets.tickets.length} tickets</span>
      {#each PRIORITY_ORDER.filter(p => p !== "done") as p}
        {@const count = grouped[p].length}
        {#if count > 0}
          <span class="priority-chip" style="--p-color: {PRIORITY_META[p].color}">
            {p} {count}
          </span>
        {/if}
      {/each}
      {#if grouped.done.length > 0}
        <span class="priority-chip" style="--p-color: {PRIORITY_META.done.color}">
          done {grouped.done.length}
        </span>
      {/if}
      <span class="updated">updated {relativeDate(tickets.lastUpdated)}</span>
    </div>

    <div class="filters">
      <select bind:value={filterPriority} class="filter-select">
        <option value="all">All priorities</option>
        {#each PRIORITY_ORDER as p}
          <option value={p}>{p} — {PRIORITY_META[p].label}</option>
        {/each}
      </select>
      <select bind:value={filterStatus} class="filter-select">
        <option value="all">All statuses</option>
        {#each allStatuses as s}
          <option value={s}>{s}</option>
        {/each}
      </select>
    </div>

    <div class="ticket-list">
      {#each filtered as t (t.id)}
        {@const prog = subtaskProgress(t)}
        <div class="ticket-card" class:blocker={t.blocksDemo}>
          <div class="ticket-header">
            <span class="ticket-priority" style="color: {PRIORITY_META[t.priority as TicketPriority]?.color ?? '#9ca3af'}">
              {t.priority}
            </span>
            <span class="ticket-id">{t.id}</span>
            <span class="ticket-status" style="color: {statusColor(t.status)}">
              {t.status}
            </span>
            {#if t.blocksDemo}
              <span class="blocker-badge">BLOCKS DEMO</span>
            {/if}
          </div>
          <h3 class="ticket-title">{t.title}</h3>
          <p class="ticket-desc">{t.description}</p>

          <div class="ticket-meta">
            <span class="meta-expert" style="color: {EXPERT_META[t.ownerExpert]?.color ?? '#9ca3af'}">
              {EXPERT_META[t.ownerExpert]?.label ?? t.ownerExpert}
            </span>
            {#if t.currentVersion}
              <span class="meta-version">{t.currentVersion}</span>
            {/if}
            {#if t.tags?.length}
              {#each t.tags.slice(0, 4) as tag}
                <span class="meta-tag">{tag}</span>
              {/each}
            {/if}
            <span class="meta-updated">{relativeDate(t.updated)}</span>
          </div>

          {#if prog.total > 0}
            <div class="subtask-bar">
              <div class="subtask-fill" style="width: {(prog.done / prog.total * 100).toFixed(0)}%"></div>
            </div>
            <span class="subtask-label">{prog.done}/{prog.total} subtasks</span>
          {/if}

          {#if t.subtasks?.length}
            <details class="subtask-details">
              <summary>Subtasks</summary>
              <ul class="subtask-list">
                {#each t.subtasks as sub}
                  <li class="subtask-item subtask-{sub.status}">
                    <span class="sub-check">{sub.status === "done" ? "✓" : sub.status === "pending" ? "○" : "◉"}</span>
                    <span class="sub-text">{sub.task}</span>
                    {#if sub.result}
                      <span class="sub-result">→ {sub.result}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            </details>
          {/if}

          <p class="ticket-update">{t.lastUpdate}</p>
        </div>
      {/each}
    </div>
  {:else if !loadError}
    <div class="loading">Loading tickets…</div>
  {/if}
  {/if}
</div>

<style>
  .tickets-page {
    max-width: 1000px;
    margin: 0 auto;
    padding: 0.75rem 1rem 3rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
  }
  .error-banner {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.4);
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    color: #fca5a5;
    font-size: 0.85rem;
  }
  .loading, .gate { text-align: center; padding: 3rem; color: #9ca3af; }
  .gate h2 { color: #fbbf24; text-transform: uppercase; letter-spacing: 0.08em; font-size: 1.05rem; }
  .gate strong { color: #fbbf24; }
  .gate a { color: #a7f3d0; text-decoration: none; }
  .gate a:hover { text-decoration: underline; }

  .summary-bar {
    display: flex;
    align-items: center;
    gap: 0.55rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
    font-size: 0.82rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.1);
    margin-bottom: 0.75rem;
  }
  .total { color: #d1d5db; font-weight: 700; }
  .priority-chip {
    color: var(--p-color);
    border: 1px solid var(--p-color);
    opacity: 0.85;
    padding: 0.1rem 0.45rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 700;
  }
  .updated { margin-left: auto; color: #6b7280; font-size: 0.75rem; }

  .filters {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
  }
  .filter-select {
    background: #12161e;
    color: #d1d5db;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 3px;
    padding: 0.35rem 0.5rem;
    font-family: inherit;
    font-size: 0.8rem;
    cursor: pointer;
  }

  .ticket-list {
    display: flex;
    flex-direction: column;
    gap: 0.65rem;
  }
  .ticket-card {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 4px;
    padding: 0.85rem 1rem;
  }
  .ticket-card.blocker {
    border-color: rgba(248, 113, 113, 0.45);
    border-left-width: 3px;
  }
  .ticket-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.35rem;
  }
  .ticket-priority { font-weight: 700; font-size: 0.82rem; }
  .ticket-id { color: #6b7280; font-size: 0.78rem; }
  .ticket-status {
    margin-left: auto;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .blocker-badge {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    background: rgba(248, 113, 113, 0.15);
    border: 1px solid rgba(248, 113, 113, 0.5);
    border-radius: 2px;
    color: #f87171;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  .ticket-title {
    font-size: 0.95rem;
    color: #e5e7eb;
    margin: 0 0 0.3rem;
    font-weight: 600;
  }
  .ticket-desc {
    font-size: 0.82rem;
    color: #9ca3af;
    margin: 0 0 0.5rem;
    line-height: 1.45;
  }
  .ticket-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    align-items: center;
    font-size: 0.75rem;
    margin-bottom: 0.4rem;
  }
  .meta-expert { font-weight: 700; }
  .meta-version {
    color: #a7f3d0;
    padding: 0.05rem 0.35rem;
    border: 1px solid rgba(167, 243, 208, 0.3);
    border-radius: 2px;
  }
  .meta-tag {
    color: #6b7280;
    padding: 0.05rem 0.3rem;
    border: 1px solid rgba(156, 163, 175, 0.2);
    border-radius: 2px;
  }
  .meta-updated { margin-left: auto; color: #4b5563; }

  .subtask-bar {
    height: 4px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 2px;
    overflow: hidden;
    margin: 0.4rem 0 0.2rem;
  }
  .subtask-fill {
    height: 100%;
    background: #a7f3d0;
    transition: width 0.3s;
  }
  .subtask-label { font-size: 0.72rem; color: #6b7280; }

  .subtask-details {
    margin-top: 0.4rem;
  }
  .subtask-details summary {
    cursor: pointer;
    font-size: 0.78rem;
    color: #9ca3af;
  }
  .subtask-list {
    list-style: none;
    padding: 0;
    margin: 0.3rem 0 0;
  }
  .subtask-item {
    display: flex;
    align-items: baseline;
    gap: 0.4rem;
    font-size: 0.78rem;
    padding: 0.15rem 0;
    color: #d1d5db;
  }
  .subtask-done { color: #6b7280; text-decoration: line-through; }
  .sub-check { flex-shrink: 0; width: 1rem; }
  .subtask-done .sub-check { color: #a7f3d0; }
  .sub-result { color: #6b7280; font-style: italic; }

  .ticket-update {
    font-size: 0.78rem;
    color: #6b7280;
    margin: 0.5rem 0 0;
    font-style: italic;
    line-height: 1.4;
  }

  @media (max-width: 640px) {
    .ticket-meta { font-size: 0.72rem; }
    .filters { flex-direction: column; }
    .blocker-badge { font-size: 0.65rem; }
  }
</style>
