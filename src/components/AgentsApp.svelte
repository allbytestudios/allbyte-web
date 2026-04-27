<script lang="ts">
  import type {
    DashboardFile,
    AgentsFile,
    AgentWorkerHistory,
    TicketsFile,
    AgentActivity,
    Comment,
  } from "../lib/ticketTypes";
  import { EXPERT_META, COMMENT_TYPE_META } from "../lib/ticketTypes";
  import {
    fetchDashboard,
    fetchAgents,
    fetchTickets,
    fetchAgentActivity,
    fetchInFlightSpans,
    attrString,
  } from "../lib/testDataSource";
  import type {
    TempoSearchResponse,
    TempoTrace,
    TempoSpan,
  } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import { subscribeToFile } from "../lib/testEvents";
  import { onMount, onDestroy } from "svelte";

  // Tier model:
  // - Hero+: live agent status, expert grid, active workers, recent activity
  // - Legend: worker history
  // - Admin: Tempo recently-completed (contains prompt content) + Grafana iframe
  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));
  let viewerIsLegend = $derived(isTierAtLeast(auth.currentUser, "legend"));
  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  // Live state from agent_activity.json + dashboard.json + agents.json + tickets.json.
  let dashboard = $state<DashboardFile | null>(null);
  let agents = $state<AgentsFile | null>(null);
  let ticketsData = $state<TicketsFile | null>(null);
  let activity = $state<AgentActivity | null>(null);
  // Tempo (committed claude_code.* traces). Admin-only — payload includes prompt.
  let traces = $state<TempoTrace[]>([]);
  let tempoError = $state<string | null>(null);
  let loadError = $state<string | null>(null);

  let nowTs = $state<number>(Date.now());
  let selectedAgent = $state<string | null>(null);
  let showAllKinds = $state<boolean>(false);

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const promises: Array<Promise<unknown>> = [
        fetchDashboard(),
        fetchAgents(),
        fetchTickets(),
        fetchAgentActivity(),
      ];
      // Tempo is admin-only — no point fetching for non-admin viewers.
      if (viewerIsAdmin) {
        promises.push(fetchInFlightSpans());
      }
      const [d, a, t, act, tempoResp] = await Promise.all(promises);
      dashboard = d as DashboardFile | null;
      agents = a as AgentsFile | null;
      ticketsData = t as TicketsFile | null;
      activity = (act as AgentActivity | null) ?? null;
      if (tempoResp && typeof tempoResp === "object" && "error" in tempoResp) {
        tempoError = (tempoResp as { error: string }).error;
      } else if (tempoResp) {
        traces = (tempoResp as TempoSearchResponse).traces ?? [];
        tempoError = null;
      }
      loadError = null;
    } catch (err: unknown) {
      loadError = err instanceof Error ? err.message : String(err);
    }
  }

  function startTimers() {
    if (!pollTimer) pollTimer = setInterval(load, 2000);
    if (!tickTimer) tickTimer = setInterval(() => (nowTs = Date.now()), 1000);
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function handleVisibility() {
    if (document.hidden) {
      stopTimers();
    } else {
      load();
      nowTs = Date.now();
      startTimers();
    }
  }

  // SSE — push updates from the dev-server file-watcher land in <200ms, vs
  // the 2s pollTimer. Polling stays as fallback for prod (no SSE there) and
  // for SSE-drop recovery.
  let sseUnsubs: Array<() => void> = [];
  const SSE_WATCHED = [
    "tickets/agent_activity.json",
    "tickets/tickets.json",
    "tickets/dashboard.json",
    "tickets/agents.json",
  ];

  onMount(() => {
    load();
    if (!document.hidden) startTimers();
    document.addEventListener("visibilitychange", handleVisibility);
    const hash = window.location.hash;
    if (hash.startsWith("#agent-")) selectedAgent = hash.slice(7);
    sseUnsubs = SSE_WATCHED.map((p) => subscribeToFile(p, load));
  });

  onDestroy(() => {
    stopTimers();
    document.removeEventListener("visibilitychange", handleVisibility);
    for (const u of sseUnsubs) u();
    sseUnsubs = [];
  });

  // ---- helpers (live status / expert cards) ---------------------------------

  function expertStatus(id: string) {
    return dashboard?.experts?.[id] ?? null;
  }

  function liveAgentStatus(agentName: string): {
    status: string;
    task: string | null;
    tickets: string[];
    subagents?: { active: number; completed: number; total_spawned: number; workers: { id: string; task: string; started: string; status: string }[] };
  } | null {
    if (!activity) return null;
    const entry = activity.activeAgents.find(
      (a) => a.agent.toLowerCase() === agentName.toLowerCase()
    );
    if (!entry) return null;
    return {
      status: entry.status,
      task: entry.task,
      tickets: entry.tickets,
      subagents: entry.subagents,
    };
  }

  function statusDot(s: string): string {
    if (s === "active" || s === "investigating" || s === "working") return "dot-active";
    if (s.startsWith("waiting")) return "dot-waiting";
    return "dot-idle";
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

  // ---- agent profile (click-to-show comments) -------------------------------

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

  function selectAgent(id: string) {
    selectedAgent = selectedAgent === id ? null : id;
    if (selectedAgent) {
      history.replaceState(null, "", `#agent-${selectedAgent}`);
    } else {
      history.replaceState(null, "", window.location.pathname);
    }
  }

  let recentWorkers = $derived<AgentWorkerHistory[]>(
    agents?.workerHistory?.slice().sort((a, b) =>
      Date.parse(b.completed) - Date.parse(a.completed)
    ).slice(0, 20) ?? []
  );

  // Per-instance active list: agent_activity.activeAgents can have multiple
  // entries with the same agent name (e.g. two Port leads on different
  // tickets). The Expert grid below collapses those into one role card.
  let activeAgentEntries = $derived(
    (activity?.activeAgents ?? []).filter((a) => a.status === "working")
  );

  function agentColor(name: string): string {
    return EXPERT_META[name.toLowerCase()]?.color ?? "#9ca3af";
  }

  // Resolve epic label for an entry. Per the realtime contract, entries
  // should carry an `epic` field directly. Fall back to deriving from
  // tickets[0].epic for legacy entries during migration.
  function epicLabelForAgentEntry(entry: AgentActivity["activeAgents"][number]): string {
    const direct = (entry as unknown as Record<string, unknown>).epic;
    if (typeof direct === "string" && direct.length > 0) return direct;
    if (!entry.tickets || entry.tickets.length === 0) return "—";
    if (!ticketsData) return "—";
    const t = ticketsData.tickets.find((x) => x.id === entry.tickets[0]);
    return t?.epic ?? "—";
  }

  // OTel-derived liveness: the source of truth for "is this session alive
  // RIGHT NOW". We group all recent spans by session.id, compute the most
  // recent emit time per session, and call any session "live" whose last
  // span ended within the last LIVE_WINDOW_MS. agent_activity.json supplies
  // the rich content (agent name, ticket IDs, task description); OTel
  // tells us whether to trust that entry.
  //
  // Correlation is by session.id. Arc needs to write session.id into each
  // activeAgents[] entry it creates so we can hydrate. Until then we still
  // surface the OTel live set; agent_activity entries with no match show
  // as "doc out of sync — likely stale", and live OTel sessions with no
  // match show as "live process, no metadata".
  const LIVE_WINDOW_MS = 60_000; // a session counts as live if it emitted within the last 60s

  let liveSessions = $derived.by<Map<string, { lastActivityMs: number; agentName?: string }>>(() => {
    const last = new Map<string, { lastActivityMs: number; agentName?: string }>();
    for (const t of traces) {
      const spans = t.spanSet?.spans ?? [];
      for (const s of spans) {
        const sid = attrString(s, "session.id");
        if (!sid) continue;
        const startMs = s.startTimeUnixNano
          ? Number(BigInt(s.startTimeUnixNano) / 1_000_000n)
          : 0;
        const durMs = s.durationNanos
          ? Number(BigInt(s.durationNanos) / 1_000_000n)
          : 0;
        const endMs = startMs + durMs;
        const prev = last.get(sid);
        if (!prev || endMs > prev.lastActivityMs) {
          // We don't have a clean "agent name" attribute on Claude Code
          // spans yet — just session.id and tool/llm-level info. Record
          // sid only; matching to a friendly name happens via the
          // agent_activity correlation below.
          last.set(sid, { lastActivityMs: endMs });
        }
      }
    }
    const cutoff = nowTs - LIVE_WINDOW_MS;
    const live = new Map<string, { lastActivityMs: number; agentName?: string }>();
    for (const [sid, info] of last) {
      if (info.lastActivityMs >= cutoff) live.set(sid, info);
    }
    return live;
  });

  let liveSessionCount = $derived(liveSessions.size);

  // Read session.id off an agent_activity entry. Type-system permissive
  // because the schema hasn't formally added the field yet; Arc may write
  // session_id, sessionId, or session.id depending on cadence.
  function entrySessionId(a: AgentActivity["activeAgents"][number]): string | undefined {
    const x = a as unknown as Record<string, unknown>;
    const v = x.session_id ?? x.sessionId ?? x["session.id"];
    return typeof v === "string" ? v : undefined;
  }

  // Categorize each activeAgents entry against the live session set.
  // - "live"   : entry has session_id matching a live OTel session — trust this
  // - "stale"  : entry says working, has session_id, no matching live OTel
  // - "unknown": entry says working, no session_id at all (legacy data)
  function entryLiveness(
    a: AgentActivity["activeAgents"][number]
  ): "live" | "stale" | "unknown" {
    const sid = entrySessionId(a);
    if (!sid) return "unknown";
    return liveSessions.has(sid) ? "live" : "stale";
  }

  // OTel corroboration of an entry. agent_activity is the truth source for
  // content (per the realtime contract); OTel just validates the entry's
  // session_id is still emitting. Many entries can corroborate against ONE
  // session when subagents bundle in-process — that's expected.
  function entryCorroboration(
    a: AgentActivity["activeAgents"][number]
  ): "corroborated" | "discrepancy" | "unverified" {
    const sid = entrySessionId(a);
    if (!sid) return "unverified";
    return liveSessions.has(sid) ? "corroborated" : "discrepancy";
  }

  let corroborationCounts = $derived.by(() => {
    let ok = 0, bad = 0, unk = 0;
    for (const a of activeAgentEntries) {
      const c = entryCorroboration(a);
      if (c === "corroborated") ok++;
      else if (c === "discrepancy") bad++;
      else unk++;
    }
    return { ok, bad, unk };
  });

  // Live OTel sessions that DON'T have a matching agent_activity entry —
  // typically a Claude Code process that's running outside Arc's tracking.
  let orphanLiveSessions = $derived.by<Array<{ sessionId: string; lastActivityMs: number }>>(() => {
    const matched = new Set<string>();
    for (const a of activeAgentEntries) {
      const sid = entrySessionId(a);
      if (sid && liveSessions.has(sid)) matched.add(sid);
    }
    const orphans: Array<{ sessionId: string; lastActivityMs: number }> = [];
    for (const [sid, info] of liveSessions) {
      if (!matched.has(sid)) orphans.push({ sessionId: sid, lastActivityMs: info.lastActivityMs });
    }
    return orphans;
  });

  // ---- Tempo recently-completed -------------------------------------------

  function startMs(t: TempoTrace): number | null {
    if (!t.startTimeUnixNano) return null;
    return Number(BigInt(t.startTimeUnixNano) / 1_000_000n);
  }

  function elapsedSinceStart(t: TempoTrace): string {
    const s = startMs(t);
    if (s === null) return "?";
    const ms = Math.max(0, nowTs - s);
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  function spanKindLabel(rootName: string | undefined): string {
    if (!rootName) return "Unknown";
    if (rootName === "claude_code.interaction") return "Agent session";
    if (rootName === "claude_code.tool") return "Tool call";
    if (rootName === "claude_code.llm_request") return "LLM call";
    if (rootName === "claude_code.hook") return "Hook";
    return rootName;
  }

  function spanKindColor(rootName: string | undefined): string {
    if (rootName === "claude_code.interaction") return "#f472b6";
    if (rootName === "claude_code.tool") return "#60a5fa";
    if (rootName === "claude_code.llm_request") return "#fbbf24";
    if (rootName === "claude_code.hook") return "#34d399";
    return "#9ca3af";
  }

  function rootSpan(t: TempoTrace): TempoSpan | undefined {
    return t.spanSet?.spans?.[0];
  }

  function describe(t: TempoTrace): string {
    const span = rootSpan(t);
    if (!span) return "";
    if (t.rootTraceName === "claude_code.interaction") {
      const prompt = attrString(span, "user_prompt");
      if (prompt && prompt !== "<REDACTED>") return prompt;
      if (prompt === "<REDACTED>") {
        return "(prompt redacted — set OTEL_LOG_TOOL_CONTENT=1 in tactical-dev to unredact)";
      }
      return "";
    }
    if (t.rootTraceName === "claude_code.tool") {
      const tool = attrString(span, "tool_name");
      const cmd = attrString(span, "full_command");
      if (tool && cmd) return `${tool}: ${cmd}`;
      if (tool) return tool;
      return "";
    }
    if (t.rootTraceName === "claude_code.llm_request") {
      const seq = attrString(span, "interaction.sequence");
      return seq ? `request #${seq}` : "";
    }
    return "";
  }

  function identityLine(t: TempoTrace): string {
    const span = rootSpan(t);
    if (!span) return "";
    if (t.rootTraceName === "claude_code.interaction") {
      const sid = attrString(span, "session.id");
      const seq = attrString(span, "interaction.sequence");
      const sidShort = sid ? sid.slice(0, 8) : "?";
      return seq ? `Session ${sidShort} · msg #${seq}` : `Session ${sidShort}`;
    }
    if (t.rootTraceName === "claude_code.tool") {
      const tool = attrString(span, "tool_name");
      return tool ?? "Tool";
    }
    return "";
  }

  function isMeaningful(t: TempoTrace): boolean {
    if (!t.rootServiceName || !t.rootTraceName) return false;
    if (t.rootTraceName.includes("not yet received")) return false;
    return true;
  }

  let visibleTraces = $derived(
    traces
      .filter(isMeaningful)
      .filter((t) => showAllKinds || t.rootTraceName === "claude_code.interaction")
  );

  let completedTraces = $derived(visibleTraces.slice(0, 15));

  const GRAFANA_DASHBOARD = "http://localhost:3000/d/inflight/claude-in-flight?orgId=1&refresh=5s&kiosk=tv&theme=dark";
</script>

<div class="agents-page">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Hero tier required</h2>
      <p>Live agent status and active-task views are a <strong>Hero</strong> tier perk. Full worker history is <strong>Legend</strong>. Real-time OpenTelemetry traces are <strong>Admin</strong>. The public overview is at <a href="/test/">/test/</a>.</p>
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
        <span class="hint">2s poll · pauses on hidden</span>
      </div>

      <h2 class="section-title">
        Active Sessions
        <span class="active-count" class:active-count-zero={activeAgentEntries.length === 0}>
          <span class="active-dot" class:active-dot-zero={activeAgentEntries.length === 0}></span>
          {activeAgentEntries.length} working
        </span>
        <span class="strip-rollup" title="OTel corroboration via session_id (60s window)">
          OTel:
          {#if corroborationCounts.ok > 0}<span class="rollup-ok">✓ {corroborationCounts.ok}</span>{/if}
          {#if corroborationCounts.bad > 0}<span class="rollup-bad">⚠ {corroborationCounts.bad}</span>{/if}
          {#if corroborationCounts.unk > 0}<span class="rollup-unk">◯ {corroborationCounts.unk}</span>{/if}
        </span>
        <span class="section-source">— content from <code>agent_activity.json</code>; OTel corroborates via <code>session_id</code></span>
      </h2>
      {#if activeAgentEntries.length === 0}
        <p class="empty">No agents are currently working.</p>
      {:else}
        <ul class="instance-list">
          {#each activeAgentEntries as a (a.agent + (a.started ?? '') + ((a as any).session_id ?? ''))}
            {@const epicLabel = epicLabelForAgentEntry(a)}
            {@const corro = entryCorroboration(a)}
            <li
              class="instance-card"
              class:instance-discrepancy={corro === "discrepancy"}
              class:instance-unverified={corro === "unverified"}
              style="--instance-color: {agentColor(a.agent)}"
            >
              <div class="instance-head">
                {#if corro === "corroborated"}
                  <span class="state-badge state-active" title="OTel: session emitted a span in the last 60s">✓ OTel</span>
                {:else if corro === "discrepancy"}
                  <span class="state-badge state-stale" title="OTel: session_id present, but no span in last 60s — possibly stale (or genuinely paused for >60s)">⚠ OTel quiet</span>
                {:else}
                  <span class="state-badge state-dead" title="No session_id on entry — can't cross-check against OTel. Will resolve when Arc's worker boilerplate ships session_id.">◯ no id</span>
                {/if}
                <span class="instance-name" style="color: {agentColor(a.agent)}">{a.agent}</span>
                {#if epicLabel && epicLabel !== "—"}
                  <span class="separator">·</span>
                  <span class="instance-epic" class:instance-epic-multi={epicLabel === "MULTI"}>{epicLabel}</span>
                {/if}
                {#if a.tickets && a.tickets.length > 0}
                  <span class="separator">·</span>
                  <span class="instance-tickets">{a.tickets.join(", ")}</span>
                {/if}
                {#if a.started}
                  <span class="instance-elapsed">{elapsed(a.started)}</span>
                {/if}
              </div>
              {#if a.task}
                <div class="instance-task">{a.task}</div>
              {/if}
              {#if a.subagents}
                <div class="instance-meta">
                  {#if a.subagents.active > 0}
                    <span class="meta-pill subagent-pill">{a.subagents.active} subagent{a.subagents.active === 1 ? "" : "s"} running</span>
                  {/if}
                  {#if a.subagents.completed > 0}
                    <span class="meta-pill">{a.subagents.completed} done</span>
                  {/if}
                  {#if a.subagents.workers && a.subagents.workers.length > 0}
                    {#each a.subagents.workers.filter((w) => w.status === "working").slice(0, 3) as w (w.id)}
                      <span class="worker-pill" title={w.task}>↳ {w.task.length > 80 ? w.task.slice(0, 80) + "…" : w.task}</span>
                    {/each}
                  {/if}
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <h2 class="section-title">Expert Agents <span class="section-source">— role overview (one card per role, even when idle)</span></h2>
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
      {#if (dashboard?.workers.length ?? 0) === 0 && (agents?.workers.length ?? 0) === 0}
        <p class="empty">No workers running.</p>
      {:else}
        <div class="workers-list">
          {#each [...(dashboard?.workers ?? []), ...(agents?.workers ?? [])] as w (w.id)}
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

      <h2 class="section-title">Recent Activity <span class="section-source">— from <code>agent_activity.json</code></span></h2>
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
        {:else if dashboard}
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
          <h2 class="section-title">Worker History <span class="section-source">— last 20 completions</span></h2>
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

      <!-- Admin-only: OpenTelemetry trace history (contains prompt content) -->
      {#if viewerIsAdmin}
        <h2 class="section-title">
          Recently Completed <span class="section-source">— from Tempo (committed traces)</span>
          <label class="toggle">
            <input type="checkbox" bind:checked={showAllKinds} />
            show sub-spans
          </label>
        </h2>
        {#if tempoError}
          <div class="error-banner subtle">Tempo: {tempoError}</div>
        {/if}
        {#if completedTraces.length === 0}
          <p class="empty">No <code>claude_code.interaction</code> traces in the last 15 minutes.</p>
        {:else}
          <ul class="trace-list">
            {#each completedTraces as t (t.traceID)}
              <li class="trace-card completed">
                <div class="trace-head">
                  <span class="state-badge state-completed">DONE</span>
                  <span class="kind-tag" style="color: {spanKindColor(t.rootTraceName)}">{spanKindLabel(t.rootTraceName)}</span>
                  {#if identityLine(t)}
                    <span class="separator">·</span>
                    <span class="identity">{identityLine(t)}</span>
                  {/if}
                  {#if t.durationMs}
                    <span class="elapsed completed-duration">{(t.durationMs / 1000).toFixed(1)}s</span>
                  {/if}
                </div>
                {#if describe(t)}
                  <div class="trace-desc">{describe(t)}</div>
                {/if}
                <div class="trace-meta">
                  <code class="trace-id">{t.traceID.slice(0, 12)}</code>
                  <a class="drilldown" href={`http://localhost:3000/explore?orgId=1&left=%7B%22queries%22%3A%5B%7B%22query%22%3A%22${t.traceID}%22%2C%22queryType%22%3A%22traceql%22%7D%5D%7D`} target="_blank" rel="noopener">drill in ↗</a>
                </div>
              </li>
            {/each}
          </ul>
        {/if}

        <h2 class="section-title">Drill-down (Grafana)</h2>
        <div class="grafana-frame-wrap">
          <iframe
            src={GRAFANA_DASHBOARD}
            title="Claude In-Flight (Grafana)"
            class="grafana-frame"
            loading="lazy"
            credentialless
          ></iframe>
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
  .error-banner.subtle {
    background: rgba(251, 191, 36, 0.08);
    border-color: rgba(251, 191, 36, 0.3);
    color: #fbbf24;
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
  .hint { color: #6b7280; font-size: 0.78rem; margin-left: auto; }
  .section-title {
    font-size: 0.9rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 1.5rem 0 0.75rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .section-source {
    color: #4b5563;
    font-size: 0.8em;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
    margin-left: 0.4rem;
  }
  .section-source code {
    color: #6b7280;
    background: #1f2937;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .toggle {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    color: #9ca3af;
    font-size: 0.78rem;
    cursor: pointer;
    user-select: none;
    text-transform: none;
    letter-spacing: 0;
    font-weight: 400;
  }
  .toggle input { cursor: pointer; }
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

  /* Active Sessions (per-instance from agent_activity.activeAgents) */
  .active-count {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.7rem;
    border-radius: 999px;
    background: rgba(52, 211, 153, 0.15);
    color: #34d399;
    border: 1px solid rgba(52, 211, 153, 0.4);
    font-size: 0.78rem;
    font-weight: 700;
    text-transform: none;
    letter-spacing: 0;
  }
  .active-count.active-count-zero {
    background: rgba(75, 85, 99, 0.2);
    color: #6b7280;
    border-color: #374151;
  }
  .active-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: #34d399;
    box-shadow: 0 0 6px rgba(52, 211, 153, 0.7);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .active-dot.active-dot-zero {
    background: #6b7280;
    box-shadow: none;
    animation: none;
  }
  .instance-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .instance-card {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-left: 3px solid var(--instance-color);
    border-radius: 4px;
    padding: 0.75rem 1rem;
  }
  .instance-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .instance-name {
    font-weight: 700;
    font-size: 0.95rem;
  }
  .instance-tickets {
    color: #d1d5db;
    font-size: 0.85rem;
  }
  .instance-epic {
    background: rgba(167, 243, 208, 0.1);
    color: #a7f3d0;
    border: 1px solid rgba(167, 243, 208, 0.3);
    padding: 0.05rem 0.45rem;
    border-radius: 3px;
    font-size: 0.78rem;
    font-weight: 600;
  }
  .instance-epic-multi {
    color: #6b7280;
    font-style: italic;
    background: rgba(75, 85, 99, 0.15);
    border-color: rgba(75, 85, 99, 0.3);
  }
  .instance-discrepancy {
    border-left-color: #fbbf24;
    background: #14140a;
  }
  .instance-unverified {
    border-left-color: #6b7280;
    opacity: 0.85;
  }
  .strip-rollup {
    color: #9ca3af;
    font-size: 0.75rem;
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    cursor: help;
    margin-left: 0.5rem;
  }
  .strip-rollup .rollup-ok  { color: #34d399; font-weight: 700; }
  .strip-rollup .rollup-bad { color: #fbbf24; font-weight: 700; }
  .strip-rollup .rollup-unk { color: #6b7280; font-weight: 700; }
  .instance-elapsed {
    margin-left: auto;
    color: #34d399;
    font-weight: 600;
    font-size: 0.85rem;
  }
  .instance-task {
    margin-top: 0.4rem;
    color: #d1d5db;
    font-size: 0.85rem;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
  .instance-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-top: 0.5rem;
    flex-wrap: wrap;
  }
  .meta-pill {
    background: #1f2937;
    color: #9ca3af;
    padding: 0.1rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
  }
  .subagent-pill {
    background: rgba(167, 243, 208, 0.1);
    color: #34d399;
    border: 1px solid rgba(52, 211, 153, 0.3);
  }
  .worker-pill {
    color: #9ca3af;
    background: #1f2937;
    padding: 0.1rem 0.5rem;
    border-radius: 3px;
    font-size: 0.72rem;
    max-width: 480px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .state-badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 3px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .state-active {
    background: #34d399;
    color: #052e1a;
  }
  .state-stale {
    background: #fbbf24;
    color: #422006;
  }
  .state-dead {
    background: #6b7280;
    color: #111827;
  }
  .stale-count {
    background: rgba(251, 191, 36, 0.15);
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.4);
  }
  .agent-activity-count {
    background: rgba(96, 165, 250, 0.12);
    color: #60a5fa;
    border-color: rgba(96, 165, 250, 0.4);
  }
  .agent-activity-count code {
    background: rgba(96, 165, 250, 0.12);
    color: #93c5fd;
    padding: 0 0.25rem;
    border-radius: 2px;
  }
  .sync-warning {
    margin-top: 0.4rem;
    padding: 0.35rem 0.6rem;
    background: rgba(251, 191, 36, 0.08);
    border-left: 2px solid rgba(251, 191, 36, 0.5);
    color: #fbbf24;
    font-size: 0.78rem;
    line-height: 1.45;
    border-radius: 0 3px 3px 0;
  }
  .sync-warning.subtle {
    background: rgba(75, 85, 99, 0.15);
    border-left-color: rgba(75, 85, 99, 0.5);
    color: #9ca3af;
  }
  .sync-warning code {
    color: inherit;
    background: rgba(255, 255, 255, 0.04);
    padding: 0 0.25rem;
    border-radius: 2px;
  }
  .instance-orphan {
    border-left-color: #34d399;
    background: rgba(52, 211, 153, 0.04);
  }
  .orphan-name {
    color: #9ca3af !important;
    font-style: italic;
  }
  .instance-stale-warn {
    opacity: 0.75;
    border-left-color: #fbbf24;
  }
  .instance-stale-dead {
    opacity: 0.5;
    border-left-color: #6b7280;
    background: #0e1117;
  }
  .elapsed-stale {
    color: #fbbf24 !important;
  }

  /* Tempo recently-completed (admin) */
  .trace-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .trace-card {
    background: #111827;
    border: 1px solid #1f2937;
    border-radius: 5px;
    padding: 0.75rem 1rem;
  }
  .trace-card.completed {
    border-left: 3px solid #60a5fa;
    opacity: 0.92;
  }
  .trace-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .state-badge {
    display: inline-block;
    padding: 0.15rem 0.55rem;
    border-radius: 3px;
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    flex: 0 0 auto;
  }
  .state-completed {
    background: #1f2937;
    color: #6b7280;
    border: 1px solid #374151;
  }
  .kind-tag {
    font-weight: 600;
    font-size: 0.95rem;
  }
  .separator { color: #4b5563; }
  .identity {
    color: #d1d5db;
    font-size: 0.9rem;
  }
  .elapsed {
    margin-left: auto;
    color: #34d399;
    font-weight: 600;
  }
  .completed-duration { color: #60a5fa; }
  .trace-desc {
    margin-top: 0.4rem;
    color: #9ca3af;
    font-size: 0.88rem;
    line-height: 1.45;
    overflow: hidden;
    text-overflow: ellipsis;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    -webkit-box-orient: vertical;
    word-break: break-word;
  }
  .trace-meta {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    margin-top: 0.45rem;
    font-size: 0.8rem;
  }
  .trace-id {
    color: #6b7280;
    font-size: 0.8em;
  }
  .drilldown {
    color: #60a5fa;
    text-decoration: none;
    margin-left: auto;
    font-size: 0.8rem;
  }
  .drilldown:hover { text-decoration: underline; }

  .grafana-frame-wrap {
    border: 1px solid #1f2937;
    border-radius: 6px;
    overflow: hidden;
    background: #0a0e17;
  }
  .grafana-frame {
    width: 100%;
    height: 720px;
    border: 0;
    display: block;
    background: #181b1f;
  }

  @media (max-width: 768px) {
    .agents-page { padding: 0.5rem 0.5rem 2rem; }
    .experts-grid { grid-template-columns: 1fr; }
    .history-row { grid-template-columns: 1fr; gap: 0.2rem; }
    .worker-row { flex-wrap: wrap; }
    .activity-row { flex-wrap: wrap; }
    .session-bar { flex-wrap: wrap; }
    .profile-feed { max-height: 300px; }
    .grafana-frame { height: 500px; }
  }
</style>
