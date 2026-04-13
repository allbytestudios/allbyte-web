<script lang="ts">
  import type { DashboardFile, AgentsFile, AgentWorkerHistory, TicketsFile, AgentActivity, Comment } from "../lib/ticketTypes";
  import { EXPERT_META, COMMENT_TYPE_META } from "../lib/ticketTypes";
  import { fetchDashboard, fetchAgents, fetchTickets, fetchAgentActivity } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));
  let viewerIsLegend = $derived(isTierAtLeast(auth.currentUser, "legend"));

  let dashboard = $state<DashboardFile | null>(null);
  let agents = $state<AgentsFile | null>(null);
  let ticketsData = $state<TicketsFile | null>(null);
  let activity = $state<AgentActivity | null>(null);
  let loadError = $state<string | null>(null);
  let nowTs = $state<number>(Date.now());
  let selectedAgent = $state<string | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const [d, a, t, act] = await Promise.all([fetchDashboard(), fetchAgents(), fetchTickets(), fetchAgentActivity()]);
      dashboard = d;
      agents = a;
      ticketsData = t;
      activity = act;
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  onMount(() => {
    load();
    pollTimer = setInterval(load, 5000);
    tickTimer = setInterval(() => (nowTs = Date.now()), 1000);
    // Check hash for deep link
    const hash = window.location.hash;
    if (hash.startsWith("#agent-")) {
      selectedAgent = hash.slice(7);
    }
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    if (tickTimer) clearInterval(tickTimer);
  });

  function expertStatus(id: string) {
    return dashboard?.experts?.[id] ?? null;
  }

  // Live status from agent_activity.json (more current than dashboard.json)
  function liveAgentStatus(agentName: string): { status: string; task: string | null; tickets: string[]; subagents?: any } | null {
    if (!activity) return null;
    const entry = activity.activeAgents.find(
      (a) => a.agent.toLowerCase() === agentName.toLowerCase()
    );
    if (!entry) return null;
    return { status: entry.status, task: entry.task, tickets: entry.tickets, subagents: (entry as any).subagents };
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

  function relativeDate(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }

  function statusDot(s: string): string {
    if (s === "active" || s === "investigating" || s === "working") return "dot-active";
    if (s.startsWith("waiting")) return "dot-waiting";
    return "dot-idle";
  }

  // Count active agents from activity.json
  let activeAgentCount = $derived(
    activity?.activeAgents.filter((a) => a.status === "active" || a.status === "working").length ?? 0
  );

  // Agent comment feed: all comments by selected agent across all tickets
  interface AgentComment { ticketId: string; ticketTitle: string; comment: Comment; }
  let agentComments = $derived.by<AgentComment[]>(() => {
    if (!selectedAgent || !ticketsData) return [];
    const result: AgentComment[] = [];
    const agentLabel = EXPERT_META[selectedAgent]?.label ?? selectedAgent;
    for (const t of ticketsData.tickets) {
      for (const c of t.comments ?? []) {
        const authorLabel = EXPERT_META[c.author.toLowerCase()]?.label ?? c.author;
        if (c.author.toLowerCase() === selectedAgent || authorLabel === agentLabel) {
          result.push({ ticketId: t.id, ticketTitle: t.title, comment: c });
        }
      }
    }
    result.sort((a, b) => Date.parse(b.comment.timestamp) - Date.parse(a.comment.timestamp));
    return result;
  });

  let recentWorkers = $derived<AgentWorkerHistory[]>(
    agents?.workerHistory?.slice().sort((a, b) =>
      Date.parse(b.completed) - Date.parse(a.completed)
    ).slice(0, 20) ?? []
  );

  function selectAgent(id: string) {
    selectedAgent = selectedAgent === id ? null : id;
    if (selectedAgent) {
      history.replaceState(null, "", `#agent-${selectedAgent}`);
    } else {
      history.replaceState(null, "", window.location.pathname);
    }
  }
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

  {#if dashboard || activity}
    {@const lastUpdate = activity?.lastUpdated ?? dashboard?.lastUpdated}
    <div class="session-bar">
      {#if dashboard}<span class="session-label">Session {dashboard.session}</span>{/if}
      {#if dashboard}<span class="version">{dashboard.deployedVersion}</span>{/if}
      {#if lastUpdate}<span class="updated">last updated {relativeDate(lastUpdate)}</span>{/if}
    </div>

    <h2 class="section-title">Expert Agents</h2>
    <div class="experts-grid">
      {#each agents?.experts ?? [] as expert (expert.id)}
        {@const agentKey = expert.id.replace("-expert", "")}
        {@const dashLive = expertStatus(agentKey)}
        {@const actLive = liveAgentStatus(EXPERT_META[agentKey]?.label ?? agentKey)}
        {@const status = actLive?.status ?? dashLive?.status ?? "idle"}
        {@const task = actLive?.task ?? dashLive?.doing ?? null}
        {@const meta = EXPERT_META[agentKey] ?? { label: expert.role, color: "#9ca3af" }}
        <button
          class="expert-card"
          class:expert-selected={selectedAgent === agentKey}
          style="--expert-color: {meta.color}"
          onclick={() => selectAgent(agentKey)}
        >
          <div class="expert-header">
            <span class="expert-dot {statusDot(status)}"></span>
            <span class="expert-name">{meta.label}</span>
            <span class="expert-status">{status}</span>
          </div>
          <p class="expert-desc">{expert.description}</p>
          {#if task}
            <p class="expert-doing">{task}</p>
          {/if}
          <div class="expert-meta">
            {#if actLive?.tickets?.length}
              <span class="meta-chip">{actLive.tickets.length} tickets</span>
            {:else if dashLive?.ticketCount}
              <span class="meta-chip">{dashLive.ticketCount} tickets</span>
            {/if}
            {#if actLive?.subagents?.active}
              <span class="meta-chip subagent">{actLive.subagents.active} subagents</span>
            {/if}
            {#if actLive?.subagents?.total_spawned && !actLive?.subagents?.active}
              <span class="meta-chip doc">{actLive.subagents.total_spawned} spawned</span>
            {/if}
            {#each expert.ownedDocs as doc}
              <span class="meta-chip doc">{doc.split("/").pop()}</span>
            {/each}
          </div>
        </button>
      {/each}
    </div>

    <!-- Agent profile / comment feed -->
    {#if selectedAgent}
      {@const meta = EXPERT_META[selectedAgent] ?? { label: selectedAgent, color: "#9ca3af" }}
      <div class="agent-profile" style="--profile-color: {meta.color}">
        <div class="profile-header">
          <h2 class="profile-name" style="color: {meta.color}">{meta.label}</h2>
          <span class="profile-comments">{agentComments.length} comments across {new Set(agentComments.map(c => c.ticketId)).size} tickets</span>
        </div>
        {#if agentComments.length === 0}
          <p class="empty">No comments from {meta.label} yet.</p>
        {:else}
          <div class="profile-feed">
            {#each agentComments as ac (ac.comment.timestamp + ac.ticketId)}
              {@const typeMeta = COMMENT_TYPE_META[ac.comment.type as keyof typeof COMMENT_TYPE_META]}
              <div class="profile-comment" style="--author-color: {meta.color}">
                <div class="pc-header">
                  <a href="/test/tickets/#ticket-{ac.ticketId}" class="pc-ticket" title={ac.ticketTitle}>{ac.ticketId}</a>
                  <span class="pc-type" style="color: {typeMeta?.color ?? '#9ca3af'}">{typeMeta?.label ?? ac.comment.type}</span>
                  <span class="pc-time">{relativeDate(ac.comment.timestamp)}</span>
                </div>
                <p class="pc-body">{ac.comment.content}</p>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

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
      {#if activity?.recentActivity?.length}
        {#each activity.recentActivity.slice(0, 15) as entry}
          {@const agentMeta = EXPERT_META[entry.agent.toLowerCase()]}
          <div class="activity-row">
            <span class="activity-agent" style="color: {agentMeta?.color ?? '#9ca3af'}">{agentMeta?.label ?? entry.agent}</span>
            <span class="activity-text">{entry.task}</span>
            <span class="activity-result">{entry.result}</span>
            <span class="activity-time">{formatTime(entry.completed)}</span>
          </div>
        {/each}
      {:else}
        {#each dashboard.recentActivity.slice(0, 15) as entry}
          <div class="activity-row">
            <span class="activity-time">{formatTime(entry.time)}</span>
            <span class="activity-text">{entry.action}</span>
          </div>
        {/each}
      {/if}
    </div>

    {#if recentWorkers.length > 0}
      {#if viewerIsLegend}
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
      {:else}
        <div class="legend-gate">
          <span>Worker history is a <strong>Legend</strong> tier perk.</span>
          <a href="/subscribe/">Upgrade →</a>
        </div>
      {/if}
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
  .legend-gate {
    margin: 1rem 0;
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
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    text-align: left;
    transition: border-color 0.15s, background 0.15s;
    width: 100%;
  }
  .expert-card:hover { border-color: var(--expert-color); background: #161c24; }
  .expert-card.expert-selected {
    border-color: var(--expert-color);
    background: rgba(167, 243, 208, 0.04);
    box-shadow: 0 0 8px rgba(167, 243, 208, 0.1);
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
  .dot-waiting { background: #fbbf24; box-shadow: 0 0 6px rgba(251, 191, 36, 0.6); animation: pulse 0.8s ease-in-out infinite; }
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
  .meta-chip.subagent { color: #fbbf24; border-color: rgba(251, 191, 36, 0.3); background: rgba(251, 191, 36, 0.08); }

  /* Agent profile */
  .agent-profile {
    margin: 1rem 0;
    padding: 1rem;
    background: #12161e;
    border: 1px solid var(--profile-color);
    border-radius: 6px;
  }
  .profile-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    margin-bottom: 0.75rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    padding-bottom: 0.5rem;
  }
  .profile-name { font-size: 1.1rem; margin: 0; }
  .profile-comments { font-size: 0.78rem; color: #6b7280; }
  .profile-feed {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
    max-height: 400px;
    overflow-y: auto;
  }
  .profile-comment {
    padding: 0.4rem 0.6rem;
    border-left: 2px solid var(--author-color);
    background: rgba(255, 255, 255, 0.02);
    border-radius: 0 3px 3px 0;
  }
  .pc-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.15rem;
  }
  .pc-ticket {
    font-size: 0.75rem;
    font-weight: 700;
    color: #a7f3d0;
    text-decoration: none;
    padding: 0.05rem 0.3rem;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 2px;
  }
  .pc-ticket:hover { text-decoration: underline; background: rgba(167, 243, 208, 0.15); }
  .pc-type {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .pc-time { margin-left: auto; font-size: 0.68rem; color: #4b5563; }
  .pc-body {
    font-size: 0.8rem;
    color: #d1d5db;
    margin: 0;
    line-height: 1.45;
    white-space: pre-wrap;
  }

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
  .worker-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
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
  .activity-agent { font-weight: 700; font-size: 0.78rem; flex-shrink: 0; min-width: 3rem; }
  .activity-time { color: #6b7280; flex-shrink: 0; }
  .activity-text { color: #d1d5db; flex: 1; }
  .activity-result { color: #9ca3af; font-size: 0.75rem; flex: 1; }

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
    .agents-page { padding: 0.5rem 0.5rem 2rem; }
    .experts-grid { grid-template-columns: 1fr; }
    .history-row { grid-template-columns: 1fr; gap: 0.2rem; }
    .worker-row { flex-wrap: wrap; }
    .activity-row { flex-wrap: wrap; }
    .session-bar { flex-wrap: wrap; }
    .profile-feed { max-height: 300px; }
  }
</style>
