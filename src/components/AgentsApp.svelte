<script lang="ts">
  import type { DashboardFile, AgentsFile, AgentWorkerHistory } from "../lib/ticketTypes";
  import { EXPERT_META } from "../lib/ticketTypes";
  import { fetchDashboard, fetchAgents } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));

  let dashboard = $state<DashboardFile | null>(null);
  let agents = $state<AgentsFile | null>(null);
  let loadError = $state<string | null>(null);
  let nowTs = $state<number>(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const [d, a] = await Promise.all([fetchDashboard(), fetchAgents()]);
      dashboard = d;
      agents = a;
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  onMount(() => {
    load();
    pollTimer = setInterval(load, 5000);
    tickTimer = setInterval(() => (nowTs = Date.now()), 1000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
  });

  function expertStatus(id: string) {
    return dashboard?.experts?.[id] ?? null;
  }

  function elapsed(started: string): string {
    const ms = Math.max(0, nowTs - Date.parse(started));
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  function formatTime(iso: string): string {
    const d = new Date(iso);
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }

  function statusDot(s: string): string {
    switch (s) {
      case "active": case "investigating": return "dot-active";
      case "spawning_worker": return "dot-spawning";
      case "idle": return "dot-idle";
      default: return "dot-idle";
    }
  }

  let recentWorkers = $derived<AgentWorkerHistory[]>(
    agents?.workerHistory?.slice().sort((a, b) =>
      Date.parse(b.completed) - Date.parse(a.completed)
    ).slice(0, 20) ?? []
  );
</script>

<div class="agents-page">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Hero tier required</h2>
      <p>Full agent status, worker history, and deployment logs are a <strong>Hero</strong> tier perk. The public overview is at <a href="/test/">/test/</a>.</p>
      <p><a href="/subscribe/">View subscription tiers →</a></p>
    </div>
  {:else}
  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  {#if dashboard}
    <div class="session-bar">
      <span class="session-label">Session {dashboard.session}</span>
      <span class="version">{dashboard.deployedVersion}</span>
      <span class="updated">last updated {formatTime(dashboard.lastUpdated)}</span>
    </div>

    <h2 class="section-title">Expert Agents</h2>
    <div class="experts-grid">
      {#each agents?.experts ?? [] as expert (expert.id)}
        {@const live = expertStatus(expert.id.replace("-expert", ""))}
        {@const meta = EXPERT_META[expert.id.replace("-expert", "")] ?? { label: expert.role, color: "#9ca3af" }}
        <div class="expert-card" style="--expert-color: {meta.color}">
          <div class="expert-header">
            <span class="expert-dot {statusDot(live?.status ?? 'idle')}"></span>
            <span class="expert-name">{meta.label}</span>
            <span class="expert-status">{live?.status ?? "offline"}</span>
          </div>
          <p class="expert-desc">{expert.description}</p>
          {#if live?.doing}
            <p class="expert-doing">{live.doing}</p>
          {/if}
          <div class="expert-meta">
            {#if live?.ticketCount}
              <span class="meta-chip">{live.ticketCount} tickets</span>
            {/if}
            {#each expert.ownedDocs as doc}
              <span class="meta-chip doc">{doc.split("/").pop()}</span>
            {/each}
          </div>
        </div>
      {/each}
    </div>

    <h2 class="section-title">
      Active Workers
      <span class="worker-slots">{agents?.workerSlots.active ?? 0}/{agents?.workerSlots.max ?? 2} slots</span>
    </h2>
    {#if dashboard.workers.length === 0 && (agents?.workers.length ?? 0) === 0}
      <p class="empty">No workers running.</p>
    {:else}
      <div class="workers-list">
        {#each [...(dashboard.workers ?? []), ...(agents?.workers ?? [])] as w (w.id)}
          <div class="worker-row">
            <span class="worker-dot dot-active"></span>
            <span class="worker-id">{w.id}</span>
            <span class="worker-expert">{EXPERT_META[w.expert]?.label ?? w.expert}</span>
            <span class="worker-task">{w.task}</span>
            <span class="worker-elapsed">{elapsed(w.started)}</span>
          </div>
        {/each}
      </div>
    {/if}

    <h2 class="section-title">Recent Activity</h2>
    <div class="activity-list">
      {#each dashboard.recentActivity.slice(0, 15) as entry}
        <div class="activity-row">
          <span class="activity-time">{formatTime(entry.time)}</span>
          <span class="activity-text">{entry.action}</span>
        </div>
      {/each}
    </div>

    {#if recentWorkers.length > 0}
      <h2 class="section-title">Worker History</h2>
      <div class="history-list">
        {#each recentWorkers as w (w.id + w.started)}
          <div class="history-row">
            <span class="history-expert" style="color: {EXPERT_META[w.expert.replace('-expert', '')]?.color ?? '#9ca3af'}">{w.expert.replace('-expert', '')}</span>
            <span class="history-task">{w.task}</span>
            <span class="history-duration">{w.duration_min}m</span>
            <span class="history-result">{w.result}</span>
          </div>
        {/each}
      </div>
    {/if}
  {:else if !loadError}
    <div class="loading">Loading agent status…</div>
  {/if}
  {/if}
</div>

<style>
  .agents-page {
    max-width: 1200px;
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
  .empty { color: #6b7280; font-style: italic; font-size: 0.85rem; }
  .session-bar {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.5rem 0;
    font-size: 0.8rem;
    color: #9ca3af;
    border-bottom: 1px solid rgba(167, 243, 208, 0.1);
    margin-bottom: 1rem;
  }
  .session-label { color: #a7f3d0; font-weight: 700; }
  .version {
    padding: 0.1rem 0.4rem;
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.3);
    border-radius: 3px;
    color: #a7f3d0;
  }
  .section-title {
    font-size: 0.9rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 1.5rem 0 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .worker-slots {
    font-size: 0.75rem;
    color: #6b7280;
    font-weight: 400;
  }
  .experts-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 0.75rem;
  }
  .expert-card {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-left: 3px solid var(--expert-color);
    border-radius: 4px;
    padding: 0.85rem 1rem;
  }
  .expert-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
  }
  .expert-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dot-active { background: #a7f3d0; box-shadow: 0 0 6px rgba(167, 243, 208, 0.6); animation: pulse 1.5s ease-in-out infinite; }
  .dot-spawning { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.6); animation: pulse 0.8s ease-in-out infinite; }
  .dot-idle { background: #4b5563; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }
  .expert-name { color: var(--expert-color); font-weight: 700; font-size: 0.85rem; }
  .expert-status { margin-left: auto; font-size: 0.75rem; color: #6b7280; text-transform: uppercase; }
  .expert-desc { font-size: 0.78rem; color: #9ca3af; margin: 0.3rem 0; line-height: 1.4; }
  .expert-doing { font-size: 0.82rem; color: #d1d5db; margin: 0.4rem 0 0; font-style: italic; }
  .expert-meta { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.5rem; }
  .meta-chip {
    font-size: 0.72rem;
    padding: 0.12rem 0.4rem;
    border-radius: 2px;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.2);
    color: #a7f3d0;
  }
  .meta-chip.doc { color: #9ca3af; border-color: rgba(156, 163, 175, 0.25); background: rgba(156, 163, 175, 0.06); }

  .workers-list, .activity-list, .history-list {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .worker-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.75rem;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 4px;
    font-size: 0.82rem;
  }
  .worker-id { color: #6b7280; font-size: 0.75rem; }
  .worker-expert { color: #a7f3d0; font-size: 0.75rem; }
  .worker-task { flex: 1; color: #d1d5db; }
  .worker-elapsed { color: #fbbf24; font-size: 0.78rem; }

  .activity-row {
    display: flex;
    gap: 0.75rem;
    font-size: 0.8rem;
    padding: 0.3rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }
  .activity-time { color: #6b7280; flex-shrink: 0; width: 3.5rem; }
  .activity-text { color: #d1d5db; }

  .history-row {
    display: grid;
    grid-template-columns: 80px 1fr 50px 1fr;
    gap: 0.5rem;
    font-size: 0.78rem;
    padding: 0.4rem 0.75rem;
    background: #12161e;
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 3px;
    align-items: center;
  }
  .history-expert { font-weight: 700; font-size: 0.75rem; }
  .history-task { color: #d1d5db; }
  .history-duration { color: #fbbf24; text-align: right; }
  .history-result { color: #9ca3af; font-size: 0.75rem; }

  @media (max-width: 640px) {
    .experts-grid { grid-template-columns: 1fr; }
    .history-row { grid-template-columns: 1fr; gap: 0.2rem; }
    .worker-row { flex-wrap: wrap; }
  }
</style>
