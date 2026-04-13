<script lang="ts">
  import type { TestIndex, TestRunStatus } from "../lib/testIndex";
  import type { TestingRoadmap } from "../lib/testingRoadmap";
  import type { DashboardFile, TicketsFile, EpicsFile } from "../lib/ticketTypes";
  import type { SyncHeartbeat } from "../lib/testDataSource";
  import { TIER_META } from "../lib/testIndex";
  import { PRIORITY_META, EXPERT_META, effectivePhase, subtaskProgress } from "../lib/ticketTypes";
  import {
    fetchIndex, fetchStatus, fetchRoadmap, fetchHeartbeat,
    fetchDashboard, fetchTickets, fetchEpics,
  } from "../lib/testDataSource";
  import MilestoneStrip from "./MilestoneStrip.svelte";
  import TestStatusCard from "./TestStatusCard.svelte";
  import FixturePicker from "./FixturePicker.svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerIsLegend = $derived(isTierAtLeast(auth.currentUser, "legend"));

  let index = $state<TestIndex | null>(null);
  let status = $state<TestRunStatus | null>(null);
  let roadmap = $state<TestingRoadmap | null>(null);
  let heartbeat = $state<SyncHeartbeat | null>(null);
  let dashboard = $state<DashboardFile | null>(null);
  let ticketsData = $state<TicketsFile | null>(null);
  let epicsData = $state<EpicsFile | null>(null);
  let nowTs = $state<number>(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function loadAll() {
    const [idx, st, rm, hb, db, tx, ep] = await Promise.all([
      fetchIndex().catch(() => null),
      fetchStatus().catch(() => null),
      fetchRoadmap().catch(() => null),
      fetchHeartbeat().catch(() => null),
      fetchDashboard().catch(() => null),
      fetchTickets().catch(() => null),
      fetchEpics().catch(() => null),
    ]);
    index = idx;
    status = st;
    roadmap = rm;
    heartbeat = hb;
    dashboard = db;
    ticketsData = tx;
    epicsData = ep;
  }

  onMount(() => {
    loadAll();
    pollTimer = setInterval(loadAll, 10_000);
    tickTimer = setInterval(() => (nowTs = Date.now()), 5000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
  });

  function tierCount(tier: number): number {
    if (!index) return 0;
    return index.tests.filter((t) => t.tier === tier).length;
  }

  let openTickets = $derived(
    ticketsData?.tickets.filter((t) => t.status !== "done" && t.status !== "deferred") ?? []
  );
  let blockerCount = $derived(
    ticketsData?.tickets.filter((t) => t.blocksDemo).length ?? 0
  );

  function syncAge(): string {
    if (!heartbeat) return "offline";
    const age = Math.max(0, nowTs - Date.parse(heartbeat.written_at));
    if (age < 60_000) return `${Math.max(1, Math.round(age / 1000))}s ago`;
    if (age < 3_600_000) return `${Math.round(age / 60_000)}m ago`;
    return `${Math.round(age / 3_600_000)}h ago`;
  }

  let syncOk = $derived(
    heartbeat ? (nowTs - Date.parse(heartbeat.written_at) < 180_000) : false
  );

  interface MsEstimate { name: string; epicCount: number; ticketCount: number; doneCount: number; weightedDone: number; totalHours: number; pctDone: number; }
  let milestoneEstimates = $derived.by<MsEstimate[]>(() => {
    if (!epicsData || !ticketsData) return [];
    const ticketById = new Map(ticketsData.tickets.map(t => [t.id, t]));
    const epicById = new Map(epicsData.epics.filter(Boolean).map(e => [e.id, e]));
    // Build epic→ticket sets from both directions
    const epicTickets = new Map<string, Set<string>>();
    for (const e of epicsData.epics) {
      if (!e) continue;
      epicTickets.set(e.id, new Set(e.ticketIds));
    }
    for (const t of ticketsData.tickets) {
      if (t.epic && epicTickets.has(t.epic)) epicTickets.get(t.epic)!.add(t.id);
    }
    const msMap = new Map<string, { epics: number; tickets: number; done: number; weighted: number; hours: number }>();
    const msOrder = ["pre_alpha", "alpha", "beta"];
    for (const epic of epicsData.epics) {
      if (!epic) continue;
      const ms = epic.milestone ?? "_uncategorized";
      if (!msMap.has(ms)) msMap.set(ms, { epics: 0, tickets: 0, done: 0, weighted: 0, hours: 0 });
      const g = msMap.get(ms)!;
      g.epics++;
      g.hours += epic.estimatedHours ?? 0;
      const tids = epicTickets.get(epic.id) ?? new Set();
      for (const tid of tids) {
        const t = ticketById.get(tid);
        if (t) {
          g.tickets++;
          const phase = effectivePhase(t);
          if (phase === "done") { g.done++; g.weighted += 1; }
          else if (phase === "testing") g.weighted += 0.75;
          else if (phase === "in_progress") g.weighted += 0.5;
        }
      }
    }
    return msOrder.filter(ms => msMap.has(ms)).map(ms => {
      const g = msMap.get(ms)!;
      return {
        name: ms.replace(/_/g, " "),
        epicCount: g.epics,
        ticketCount: g.tickets,
        doneCount: g.done,
        weightedDone: g.weighted,
        totalHours: g.hours,
        pctDone: g.tickets > 0 ? Math.round(g.weighted / g.tickets * 100) : 0,
      };
    });
  });
</script>

<div class="console">
  <!-- Sync + version bar -->
  <div class="status-bar">
    <span class="sync-pill" class:sync-ok={syncOk} class:sync-off={!syncOk}>
      <span class="sync-dot"></span>
      {heartbeat ? `synced ${syncAge()}` : "sync offline"}
    </span>
    {#if dashboard}
      <span class="version-pill">{dashboard.deployedVersion}</span>
      <span class="session">session {dashboard.session}</span>
    {/if}
    {#if index}
      <span class="commit" title={index.repo.commit}>@{index.repo.commit.slice(0, 7)}</span>
    {/if}
  </div>

  <!-- Milestone progress -->
  {#if milestoneEstimates.length > 0}
    <div class="ms-progress">
      {#each milestoneEstimates as ms}
        <div class="ms-card">
          <div class="ms-header">
            <span class="ms-name">{ms.name}</span>
            <span class="ms-pct">{ms.pctDone}%</span>
          </div>
          <div class="ms-bar"><div class="ms-bar-fill" style="width: {ms.pctDone}%"></div></div>
          <div class="ms-detail">
            <span>{ms.epicCount} epics</span>
            <span>{ms.doneCount}/{ms.ticketCount} tickets</span>
            {#if ms.totalHours > 0}<span>~{ms.totalHours}h est.</span>{/if}
          </div>
        </div>
      {/each}
    </div>
  {:else}
    <MilestoneStrip {roadmap} {index} />
  {/if}

  <!-- Live run status -->
  <TestStatusCard {status} />

  <!-- Three overview cards -->
  <div class="cards">
    <!-- Tests -->
    <a href="/test/tests/" class="card">
      <h3 class="card-title">Tests</h3>
      {#if index}
        <div class="card-stat">{index.summary.total_tests}</div>
        <div class="card-detail">
          <span style="color: {TIER_META[1].color}">T1 {tierCount(1)}</span>
          <span style="color: {TIER_META[2].color}">T2 {tierCount(2)}</span>
          <span style="color: {TIER_META[3].color}">T3 {tierCount(3)}</span>
        </div>
        {#if index.summary.last_full_run_seconds != null}
          <span class="card-sub">last run {Math.round(index.summary.last_full_run_seconds)}s</span>
        {/if}
      {:else}
        <div class="card-stat">—</div>
      {/if}
    </a>

    <!-- Agents -->
    <a href="/test/agents/" class="card">
      <h3 class="card-title">Agents</h3>
      {#if dashboard}
        <div class="card-detail expert-list">
          {#each Object.entries(dashboard.experts) as [id, ex]}
            {@const meta = EXPERT_META[id]}
            <div class="expert-row">
              <span class="exp-dot" class:exp-active={ex.status === "active" || ex.status === "investigating"}></span>
              <span class="exp-name" style="color: {meta?.color ?? '#9ca3af'}">{meta?.label ?? id}</span>
              <span class="exp-status">{ex.status}</span>
            </div>
          {/each}
        </div>
        {#if dashboard.workers.length > 0}
          <span class="card-sub">{dashboard.workers.length} workers running</span>
        {/if}
      {:else}
        <div class="card-stat">—</div>
      {/if}
    </a>

    <!-- Tickets -->
    <a href="/test/tickets/" class="card">
      <h3 class="card-title">Tickets</h3>
      {#if ticketsData}
        <div class="card-stat">{openTickets.length} <span class="stat-label">open</span></div>
        <div class="card-detail">
          {#each ["P0", "P1", "P2", "P3"] as p}
            {@const count = ticketsData.tickets.filter(t => t.priority === p && t.status !== "done").length}
            {#if count > 0}
              <span style="color: {PRIORITY_META[p as keyof typeof PRIORITY_META]?.color}">{p} {count}</span>
            {/if}
          {/each}
        </div>
        {#if blockerCount > 0}
          <span class="card-sub blocker">{blockerCount} blocking demo</span>
        {/if}
      {:else}
        <div class="card-stat">—</div>
      {/if}
    </a>
  </div>


  <!-- Fixture picker (Legend+ only) -->
  {#if viewerIsLegend}
    <FixturePicker />
  {/if}

  <!-- Recent activity (Legend+ only) -->
  {#if dashboard?.recentActivity?.length}
    {#if viewerIsLegend}
      <h3 class="section-title">Recent Activity</h3>
      <div class="activity">
        {#each dashboard.recentActivity.slice(0, 8) as entry}
          <div class="activity-row">
            <span class="act-time">{new Date(entry.time).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}</span>
            <span class="act-text">{entry.action}</span>
          </div>
        {/each}
      </div>
    {:else}
      <div class="legend-gate">
        <span>Deployment activity feed is a <strong>Legend</strong> tier perk.</span>
        <a href="/subscribe/">Upgrade →</a>
      </div>
    {/if}
  {/if}
</div>

<style>
  .console {
    max-width: 1200px;
    margin: 0 auto;
    padding: 0.75rem 1rem 2rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
  }

  .status-bar {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
    padding: 0.5rem 0;
    font-size: 0.8rem;
    color: #6b7280;
    border-bottom: 1px solid rgba(167, 243, 208, 0.08);
    margin-bottom: 0.75rem;
  }
  .sync-pill {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    padding: 0.15rem 0.5rem;
    border-radius: 3px;
    border: 1px solid;
    font-size: 0.75rem;
  }
  .sync-ok { color: #a7f3d0; border-color: rgba(167, 243, 208, 0.4); }
  .sync-off { color: #f87171; border-color: rgba(248, 113, 113, 0.4); }
  .sync-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: currentColor;
  }
  .sync-ok .sync-dot { animation: pulse 2s ease-in-out infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .version-pill {
    color: #a7f3d0;
    padding: 0.1rem 0.4rem;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 3px;
  }
  .session { color: #6b7280; }
  .commit { color: #4b5563; }

  .cards {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 0.75rem;
    margin: 1rem 0;
  }
  .card {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 6px;
    padding: 1rem 1.15rem;
    text-decoration: none;
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
    transition: border-color 0.15s, background 0.15s;
  }
  .card:hover {
    border-color: rgba(167, 243, 208, 0.35);
    background: #161c24;
  }
  .card-title {
    font-size: 0.82rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0;
  }
  .card-stat {
    font-size: 2rem;
    font-weight: 700;
    color: #e5e7eb;
    line-height: 1;
  }
  .stat-label {
    font-size: 0.85rem;
    font-weight: 400;
    color: #9ca3af;
  }
  .card-detail {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    font-size: 0.82rem;
    font-weight: 700;
  }
  .card-sub {
    font-size: 0.75rem;
    color: #6b7280;
  }
  .card-sub.blocker { color: #f87171; }

  .expert-list {
    flex-direction: column;
    gap: 0.3rem;
  }
  .expert-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.8rem;
  }
  .exp-dot {
    width: 6px; height: 6px; border-radius: 50%;
    background: #4b5563; flex-shrink: 0;
  }
  .exp-dot.exp-active {
    background: #a7f3d0;
    box-shadow: 0 0 4px rgba(167, 243, 208, 0.5);
  }
  .exp-name { font-weight: 700; }
  .exp-status { margin-left: auto; color: #6b7280; font-size: 0.72rem; text-transform: uppercase; }

  .section-title {
    font-size: 0.82rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 1.5rem 0 0.5rem;
  }
  .activity {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
  }
  .activity-row {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8rem;
    padding: 0.25rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }
  .act-time { color: #4b5563; flex-shrink: 0; width: 3.5rem; }
  .act-text { color: #d1d5db; }

  /* Milestone progress */
  .ms-progress {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
    gap: 0.75rem;
    margin: 0.75rem 0;
  }
  .ms-card {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 6px;
    padding: 0.75rem 1rem;
  }
  .ms-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.4rem;
  }
  .ms-name {
    font-size: 0.85rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  .ms-pct {
    font-size: 1.1rem;
    font-weight: 700;
    color: #e5e7eb;
  }
  .ms-bar {
    height: 6px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    overflow: hidden;
    margin-bottom: 0.4rem;
  }
  .ms-bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #34d399, #a7f3d0);
    border-radius: 3px;
    transition: width 0.3s;
  }
  .ms-detail {
    display: flex;
    gap: 0.6rem;
    font-size: 0.75rem;
    color: #6b7280;
  }

  .estimation {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .est-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.82rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }
  .est-ms {
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-weight: 700;
    font-size: 0.78rem;
    min-width: 6rem;
  }
  .est-detail { color: #9ca3af; }
  .est-hours { color: #6b7280; }
  .est-pct { margin-left: auto; color: #d1d5db; font-weight: 700; }

  .legend-gate {
    margin: 1.5rem 0 0;
    padding: 0.75rem 1rem;
    border: 1px dashed rgba(249, 115, 22, 0.4);
    border-radius: 4px;
    font-size: 0.82rem;
    color: #9ca3af;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .legend-gate strong { color: #f97316; }
  .legend-gate a { color: #f97316; text-decoration: none; }
  .legend-gate a:hover { text-decoration: underline; }

  @media (max-width: 768px) {
    .cards { grid-template-columns: 1fr; }
  }
</style>
