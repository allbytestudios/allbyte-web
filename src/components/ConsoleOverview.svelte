<script lang="ts">
  import type { TestIndex, TestRunStatus } from "../lib/testIndex";
  import type { TestingRoadmap } from "../lib/testingRoadmap";
  import type { DashboardFile, TicketsFile, EpicsFile, Epic, AgentActivity } from "../lib/ticketTypes";
  import type { SyncHeartbeat, TempoSearchResponse, TempoTrace } from "../lib/testDataSource";
  import { TIER_META } from "../lib/testIndex";
  import { PRIORITY_META, EXPERT_META, effectivePhase, subtaskProgress } from "../lib/ticketTypes";
  import {
    fetchIndex, fetchStatus, fetchRoadmap, fetchHeartbeat,
    fetchDashboard, fetchTickets, fetchEpics, fetchAgentActivity, fetchInFlightSpans,
    fetchUserAnalytics, fetchBudgetStatus, fetchSiteTraffic, attrString,
  } from "../lib/testDataSource";
  import type { UserAnalytics, BudgetStatus, SiteTraffic } from "../lib/testDataSource";
  import { subscribeToFile } from "../lib/testEvents";
  import usageData from "../data/claude-usage.json";
  import usageHistory from "../data/claude-usage-history.json";
  import MilestoneStrip from "./MilestoneStrip.svelte";
  import TestStatusCard from "./TestStatusCard.svelte";
  import FixturePicker from "./FixturePicker.svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerIsLegend = $derived(isTierAtLeast(auth.currentUser, "legend"));
  let viewerIsAdmin = $derived(auth.currentUser?.tier === "admin");

  // History chart series toggles
  type SeriesKey = "messages" | "outputTokens" | "freshTokens" | "commits" | "churn" | "ticketsDone";
  const SERIES: { key: SeriesKey; label: string; color: string; field: string }[] = [
    { key: "messages",     label: "Messages",      color: "#60a5fa", field: "messages" },
    { key: "outputTokens", label: "Output Tokens", color: "#22d3ee", field: "outputTokens" },
    { key: "freshTokens",  label: "Fresh Tokens",  color: "#f472b6", field: "freshTokens" },
    { key: "commits",      label: "Commits",       color: "#34d399", field: "commits" },
    { key: "churn",        label: "LOC Changed",   color: "#fbbf24", field: "churn" },
    { key: "ticketsDone",  label: "Tickets Done",  color: "#c084fc", field: "ticketsDone" },
  ];
  let activeSeries = $state<Set<SeriesKey>>(new Set(["messages", "outputTokens", "commits", "ticketsDone"]));
  let maWindow = $state<number>(24); // hours in moving-average window
  function toggleSeries(k: SeriesKey) {
    const s = new Set(activeSeries);
    if (s.has(k)) s.delete(k);
    else s.add(k);
    activeSeries = s;
  }

  // Centered moving average with window size n
  function movingAverage(arr: number[], window: number): number[] {
    const out: number[] = [];
    const half = Math.floor(window / 2);
    for (let i = 0; i < arr.length; i++) {
      const lo = Math.max(0, i - half);
      const hi = Math.min(arr.length, i + half + 1);
      let sum = 0;
      for (let j = lo; j < hi; j++) sum += arr[j];
      out.push(sum / (hi - lo));
    }
    return out;
  }

  // Build an SVG polyline points string, y inverted so 0 is at bottom
  function mavgPoints(values: number[], maxVal: number, window: number): string {
    if (!values.length || maxVal <= 0) return "";
    const ma = movingAverage(values, window);
    const n = values.length;
    return ma.map((v, i) => {
      const x = n > 1 ? (i / (n - 1)) * 100 : 50;
      const y = 100 - (v / maxVal) * 100;
      return `${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
  }

  let index = $state<TestIndex | null>(null);
  let status = $state<TestRunStatus | null>(null);
  let roadmap = $state<TestingRoadmap | null>(null);
  let heartbeat = $state<SyncHeartbeat | null>(null);
  let dashboard = $state<DashboardFile | null>(null);
  let ticketsData = $state<TicketsFile | null>(null);
  let epicsData = $state<EpicsFile | null>(null);
  let userAnalytics = $state<UserAnalytics | null>(null);
  let budgetStatus = $state<BudgetStatus | null>(null);
  let siteTraffic = $state<SiteTraffic | null>(null);
  let activity = $state<AgentActivity | null>(null);
  let traces = $state<TempoTrace[]>([]);
  let nowTs = $state<number>(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function loadAll() {
    const promises: Array<Promise<unknown>> = [
      fetchIndex().catch(() => null),
      fetchStatus().catch(() => null),
      fetchRoadmap().catch(() => null),
      fetchHeartbeat().catch(() => null),
      fetchDashboard().catch(() => null),
      fetchTickets().catch(() => null),
      fetchEpics().catch(() => null),
      fetchAgentActivity().catch(() => null),
    ];
    // Tempo only useful for admin (contains prompt content) and only
    // reachable on local dev. Skip for non-admins or when proxy 404s.
    if (viewerIsAdmin) {
      promises.push(fetchInFlightSpans().catch(() => null));
    }
    const [idx, st, rm, hb, db, tx, ep, act, tempoResp] = await Promise.all(promises);
    index = idx as TestIndex | null;
    status = st as TestRunStatus | null;
    roadmap = rm as TestingRoadmap | null;
    heartbeat = hb as SyncHeartbeat | null;
    dashboard = db as DashboardFile | null;
    ticketsData = tx as TicketsFile | null;
    epicsData = ep as EpicsFile | null;
    activity = (act as AgentActivity | null) ?? null;
    if (tempoResp && typeof tempoResp === "object" && "traces" in (tempoResp as object)) {
      traces = (tempoResp as TempoSearchResponse).traces ?? [];
    }
  }

  async function loadAnalytics() {
    const [ua, bs, st] = await Promise.all([
      fetchUserAnalytics().catch(() => null),
      fetchBudgetStatus().catch(() => null),
      fetchSiteTraffic().catch(() => null),
    ]);
    userAnalytics = ua;
    budgetStatus = bs;
    siteTraffic = st;
  }

  let analyticsTimer: ReturnType<typeof setInterval> | null = null;

  // Polling pauses when the tab is hidden. The dashboard fetches 7
  // /test-snapshot/* files every 10s (loadAll) which is ~2,500 req/hr per
  // open tab; a backgrounded tab needs none of that until the user comes
  // back. Resumes with an immediate fetch on visibilitychange so the user
  // doesn't see stale data on tab refocus.
  function startTimers() {
    if (!pollTimer) pollTimer = setInterval(loadAll, 10_000);
    if (!analyticsTimer) analyticsTimer = setInterval(loadAnalytics, 300_000);
    if (!tickTimer) tickTimer = setInterval(() => (nowTs = Date.now()), 5000);
  }

  function stopTimers() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
    if (analyticsTimer) { clearInterval(analyticsTimer); analyticsTimer = null; }
    if (tickTimer) { clearInterval(tickTimer); tickTimer = null; }
  }

  function handleVisibility() {
    if (document.hidden) {
      stopTimers();
    } else {
      loadAll();
      loadAnalytics();
      nowTs = Date.now();
      startTimers();
    }
  }

  // SSE — push updates from the dev-server file-watcher land in <200ms, vs
  // the 10s pollTimer. Polling stays as fallback for prod (no SSE there) and
  // for SSE-drop recovery. Subscribing the high-churn files (agent_activity,
  // tickets, dashboard, epics) covers everything the headline sections render.
  let sseUnsubs: Array<() => void> = [];
  const SSE_WATCHED = [
    "tickets/agent_activity.json",
    "tickets/tickets.json",
    "tickets/dashboard.json",
    "tickets/epics.json",
  ];

  onMount(() => {
    loadAll();
    loadAnalytics();
    if (!document.hidden) startTimers();
    document.addEventListener("visibilitychange", handleVisibility);
    sseUnsubs = SSE_WATCHED.map((p) => subscribeToFile(p, loadAll));
  });

  onDestroy(() => {
    stopTimers();
    document.removeEventListener("visibilitychange", handleVisibility);
    for (const u of sseUnsubs) u();
    sseUnsubs = [];
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

  // ---- Three-section overview (Epics in progress / Agents / Epics on deck) ----
  // Until Arc's tools/aggregate_dashboard.py ships, derive epic-level state
  // client-side from epics.json + tickets.json. Each epic's "activeStatus" is:
  //   - "active":   any owned ticket has phase/status === in_progress
  //   - "review":   no in_progress, but at least one in testing/pending_review
  //   - "queued":   no work yet, only planning/tech_review/ready
  //   - "complete": all tickets done (or none)
  type EpicActiveStatus = "active" | "review" | "queued" | "complete";

  interface EpicSummary {
    epic: Epic;
    activeStatus: EpicActiveStatus;
    inProgress: number;
    review: number;
    queued: number;
    done: number;
    total: number;
    pctDone: number;
    leads: string[]; // unique lead names across in-progress tickets
  }

  function ticketPhase(t: { phase?: string; status?: string }): string {
    return (t.phase ?? t.status ?? "").toLowerCase();
  }

  let epicSummaries = $derived.by<EpicSummary[]>(() => {
    if (!epicsData || !ticketsData) return [];
    const ticketById = new Map(ticketsData.tickets.map((t) => [t.id, t]));
    const summaries: EpicSummary[] = [];
    for (const e of epicsData.epics) {
      if (!e) continue;
      // Resolve tickets via both directions: epic.ticketIds AND ticket.epic backref.
      const ids = new Set<string>(e.ticketIds ?? []);
      for (const t of ticketsData.tickets) {
        if (t.epic === e.id) ids.add(t.id);
      }
      let inProgress = 0, review = 0, queued = 0, done = 0;
      const leads = new Set<string>();
      for (const id of ids) {
        const t = ticketById.get(id);
        if (!t) continue;
        const phase = ticketPhase(t);
        if (phase === "in_progress") {
          inProgress++;
          for (const lead of t.leads ?? []) leads.add(lead);
        } else if (phase === "testing" || phase === "pending_review") {
          review++;
        } else if (phase === "done") {
          done++;
        } else {
          // planning, tech_review, ready, bundling, blocked, …
          queued++;
        }
      }
      const total = inProgress + review + queued + done;
      let activeStatus: EpicActiveStatus;
      if (inProgress > 0) activeStatus = "active";
      else if (review > 0) activeStatus = "review";
      else if (queued > 0) activeStatus = "queued";
      else activeStatus = "complete";
      summaries.push({
        epic: e,
        activeStatus,
        inProgress, review, queued, done, total,
        pctDone: total > 0 ? Math.round((done / total) * 100) : 0,
        leads: [...leads],
      });
    }
    return summaries;
  });

  // Sorting: priority asc (P0 first), then queueOrder if Arc has populated it,
  // then total tickets desc as a tiebreak so big epics float up.
  function compareEpicSummary(a: EpicSummary, b: EpicSummary): number {
    const pri = (e: EpicSummary): number => {
      const p = (e.epic as unknown as Record<string, string>).priority;
      if (p === "P0") return 0;
      if (p === "P1") return 1;
      if (p === "P2") return 2;
      if (p === "P3") return 3;
      return 9;
    };
    const qo = (e: EpicSummary): number => {
      const q = (e.epic as unknown as Record<string, number | undefined>).queueOrder;
      return typeof q === "number" ? q : 999;
    };
    return pri(a) - pri(b) || qo(a) - qo(b) || b.total - a.total;
  }

  let epicsActive = $derived(
    epicSummaries.filter((s) => s.activeStatus === "active").sort(compareEpicSummary)
  );
  let epicsOnDeck = $derived(
    epicSummaries.filter((s) => s.activeStatus === "queued").sort(compareEpicSummary)
  );

  // ---- Agents in progress (per-instance, OTel-correlated) ----
  // Same data shape as the /test/agents/ page. Console shows the headline
  // count + a compact list (top 5) with a click-through to the full view.

  // OTel corroboration windows (owner-set):
  //   age ≤ 10s : corroborated — definitively live
  //   age ≤ 60s : quiet — paused or mid-long-op, possibly OK
  //   age > 60s : stale — definitely out of bounds (treat as suspicious)
  const FRESH_WINDOW_MS = 10_000;
  const STALE_WINDOW_MS = 60_000;

  // Map of every observed session.id → last span end time. No cutoff filter
  // here; entryCorroboration() classifies into tiers using the windows above.
  let sessionLastActivity = $derived.by<Map<string, number>>(() => {
    const last = new Map<string, number>();
    for (const t of traces) {
      const spans = t.spanSet?.spans ?? [];
      for (const s of spans) {
        const sid = attrString(s, "session.id");
        if (!sid) continue;
        const startMs = s.startTimeUnixNano
          ? Number(BigInt(s.startTimeUnixNano) / 1_000_000n) : 0;
        const durMs = s.durationNanos
          ? Number(BigInt(s.durationNanos) / 1_000_000n) : 0;
        const endMs = startMs + durMs;
        const prev = last.get(sid) ?? 0;
        if (endMs > prev) last.set(sid, endMs);
      }
    }
    return last;
  });

  // Backward-compat: many call sites still reference `liveSessions` for the
  // count of "definitely-fresh" sessions. Keep that as a derived view.
  let liveSessions = $derived.by<Map<string, number>>(() => {
    const cutoff = nowTs - FRESH_WINDOW_MS;
    const live = new Map<string, number>();
    for (const [sid, lastMs] of sessionLastActivity) {
      if (lastMs >= cutoff) live.set(sid, lastMs);
    }
    return live;
  });

  function entrySessionId(a: AgentActivity["activeAgents"][number]): string | undefined {
    const x = a as unknown as Record<string, unknown>;
    const v = x.session_id ?? x.sessionId ?? x["session.id"];
    return typeof v === "string" ? v : undefined;
  }

  // OTel corroboration of an entry. Three tiers based on age of last span:
  //   "corroborated" : ≤10s — definitively live
  //   "quiet"        : 10–60s — paused or mid-long-op (not alarming)
  //   "stale"        : >60s — definitely out of bounds (file likely wrong)
  //   "unverified"   : no session_id on the entry (can't cross-check)
  // Caveat (the upstream gap surfaced by inventorying claude_code span attrs):
  // OTel reflects PROCESS reality, not PERSONA reality. When subagents are
  // bundled in-process under one Claude Code session.id, every entry sharing
  // that session_id corroborates together — one signal, many cards. We can't
  // disentangle Nix-vs-Vera-vs-Arc within a single session today.
  // See ANTHROPIC_FEATURE_REQUEST_OTEL_SUBAGENT_ATTRIBUTION.md.
  function entryCorroboration(
    a: AgentActivity["activeAgents"][number]
  ): "corroborated" | "quiet" | "stale" | "unverified" {
    const sid = entrySessionId(a);
    if (!sid) return "unverified";
    const lastMs = sessionLastActivity.get(sid);
    if (lastMs == null) return "stale";
    const age = nowTs - lastMs;
    if (age <= FRESH_WINDOW_MS) return "corroborated";
    if (age <= STALE_WINDOW_MS) return "quiet";
    return "stale";
  }

  let corroborationCounts = $derived.by(() => {
    let ok = 0, quiet = 0, bad = 0, unk = 0;
    for (const a of activeAgentEntries) {
      const c = entryCorroboration(a);
      if (c === "corroborated") ok++;
      else if (c === "quiet") quiet++;
      else if (c === "stale") bad++;
      else unk++;
    }
    return { ok, quiet, bad, unk };
  });

  let activeAgentEntries = $derived(
    (activity?.activeAgents ?? []).filter((a) => a.status === "working")
  );

  // OTel is the truth source. For each live session, try to look up the
  // matching agent_activity entry by session_id and hydrate. If no entry,
  // we still show the session — just with "no details" instead of fabricating.
  interface LiveSessionRow {
    sessionId: string;
    lastActivityMs: number;
    entry: AgentActivity["activeAgents"][number] | undefined;
  }

  let liveSessionRows = $derived.by<LiveSessionRow[]>(() => {
    const rows: LiveSessionRow[] = [];
    for (const [sid, lastActivityMs] of liveSessions) {
      const entry = activeAgentEntries.find((a) => entrySessionId(a) === sid);
      rows.push({ sessionId: sid, lastActivityMs, entry });
    }
    rows.sort((a, b) => b.lastActivityMs - a.lastActivityMs);
    return rows;
  });

  function elapsedSinceIso(iso: string): string {
    const ms = Math.max(0, nowTs - Date.parse(iso));
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
  }

  function agentColor(name: string): string {
    return EXPERT_META[name.toLowerCase()]?.color ?? "#9ca3af";
  }

  function epicPriority(e: Epic): string {
    return (e as unknown as Record<string, string>).priority ?? "—";
  }

  function epicPriorityColor(e: Epic): string {
    const p = epicPriority(e);
    return PRIORITY_META[p as keyof typeof PRIORITY_META]?.color ?? "#9ca3af";
  }

  // Resolve the epic for an agent_activity entry. Per the realtime contract,
  // entries should carry an `epic` field directly (Arc derives it at write
  // time). Until that ships, fall back to the entry's first ticket → ticket.epic.
  function epicLabelForEntry(entry: AgentActivity["activeAgents"][number] | undefined): string {
    if (!entry) return "—";
    const direct = (entry as unknown as Record<string, unknown>).epic;
    if (typeof direct === "string" && direct.length > 0) {
      // Try to resolve the epic id to a title for nicer display, fall back to id.
      const ep = epicsData?.epics.find((e) => e?.id === direct);
      return ep?.title ?? direct;
    }
    // Fallback: derive from first ticket
    if (!entry.tickets || entry.tickets.length === 0) return "—";
    if (!ticketsData || !epicsData) return "—";
    const firstTicketId = entry.tickets[0];
    const ticket = ticketsData.tickets.find((t) => t.id === firstTicketId);
    if (!ticket || !ticket.epic) return "—";
    const ep = epicsData.epics.find((e) => e?.id === ticket.epic);
    return ep?.title ?? ticket.epic;
  }

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
    // Always render all 3 milestones (pre_alpha / alpha / beta) so the
    // progression is visible even before later milestones are scoped.
    // Only pre_alpha is scoped — alpha + beta are marked "not scoped yet"
    // so their partial epics don't read as meaningful estimation.
    const SCOPED = new Set(["pre_alpha"]);
    return msOrder.map(ms => {
      const g = msMap.get(ms) ?? { epics: 0, tickets: 0, done: 0, weighted: 0, hours: 0 };
      return {
        key: ms,
        name: ms.replace(/_/g, " "),
        scoped: SCOPED.has(ms),
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

  <!-- ============================================================
       LIVE AGENTS STRIP — one card per active agent.
       Content from agent_activity.activeAgents (truth-source per
       Arc's realtime contract). OTel corroborates via session_id —
       small corner indicator per card + rollup pill in the header.
       ============================================================ -->
  {#if activeAgentEntries.length > 0}
    <div class="agent-strip-header">
      <span class="strip-rollup" title="OTel corroboration: ✓ ≤10s (live), ⚠ 10–60s (quiet/paused), 🚨 >60s (definitely out of bounds), ◯ no session_id (can't validate). Note: OTel is process-level, not per-subagent — see ANTHROPIC_FEATURE_REQUEST_OTEL_SUBAGENT_ATTRIBUTION.md.">
        OTel:
        {#if corroborationCounts.ok > 0}<span class="rollup-ok">✓ {corroborationCounts.ok}</span>{/if}
        {#if corroborationCounts.quiet > 0}<span class="rollup-quiet">⚠ {corroborationCounts.quiet}</span>{/if}
        {#if corroborationCounts.bad > 0}<span class="rollup-bad">🚨 {corroborationCounts.bad}</span>{/if}
        {#if corroborationCounts.unk > 0}<span class="rollup-unk">◯ {corroborationCounts.unk}</span>{/if}
      </span>
    </div>
  {/if}
  <div class="agent-strip">
    {#each activeAgentEntries as a (a.agent + (a.started ?? '') + ((a as any).session_id ?? ''))}
      {@const epicLabel = epicLabelForEntry(a)}
      {@const corro = entryCorroboration(a)}
      <div
        class="agent-card-mini"
        class:agent-card-quiet={corro === "quiet"}
        class:agent-card-stale={corro === "stale"}
        class:agent-card-unverified={corro === "unverified"}
        style="--agent-color: {agentColor(a.agent)}"
        title={
          corro === 'corroborated' ? `OTel: session emitted in last 10s · ${a.task ?? ''}` :
          corro === 'quiet' ? `OTel: session quiet 10–60s — paused or mid-long-op · ${a.task ?? ''}` :
          corro === 'stale'  ? `OTel: session quiet >60s — definitely out of bounds · ${a.task ?? ''}` :
          `OTel: no session_id, can't validate · ${a.task ?? ''}`
        }
      >
        <span class="agent-card-corro agent-card-corro-{corro}" aria-label="OTel corroboration">
          {corro === "corroborated" ? "✓" : corro === "quiet" ? "⚠" : corro === "stale" ? "🚨" : "◯"}
        </span>
        <div class="agent-card-name" style="color: {agentColor(a.agent)}">{a.agent}</div>
        <div class="agent-card-epic" class:agent-card-epic-multi={epicLabel === 'MULTI'}>{epicLabel}</div>
      </div>
    {/each}
    {#if activeAgentEntries.length === 0}
      <div class="agent-strip-empty">No agents are currently working.</div>
    {/if}
  </div>

  <!-- ============================================================
       EPIC ROW: in progress | on deck (50/50 side-by-side)
       Layout: Epics in Progress | Epics on Deck (50/50 row)
               Agents in Progress (full width below)
       Stacks vertically on narrow screens (<900px).
       ============================================================ -->
  <div class="overview-epics-row">
  <section class="overview-section overview-half">
    <h2 class="overview-title">
      <span class="overview-marker overview-marker-active"></span>
      Epics in Progress
      <span class="overview-count" class:overview-count-zero={epicsActive.length === 0}>{epicsActive.length}</span>
      <a class="overview-link" href="/test/tickets/">tickets ↗</a>
    </h2>
    {#if epicsActive.length === 0}
      <p class="overview-empty">No epics with work in progress.</p>
    {:else}
      <ul class="epic-list">
        {#each epicsActive as s (s.epic.id)}
          {@const pri = epicPriority(s.epic)}
          <li class="epic-card epic-active">
            <div class="epic-head">
              <span class="epic-pri" style="color: {epicPriorityColor(s.epic)}">{pri}</span>
              <span class="epic-id">{s.epic.id}</span>
              <span class="epic-title">{s.epic.title}</span>
              <span class="epic-pct">{s.pctDone}% done</span>
            </div>
            <div class="epic-meta">
              <span class="epic-stat epic-stat-active">{s.inProgress} in progress</span>
              {#if s.review > 0}<span class="epic-stat epic-stat-review">{s.review} in review</span>{/if}
              {#if s.queued > 0}<span class="epic-stat epic-stat-queued">{s.queued} queued</span>{/if}
              <span class="epic-stat epic-stat-total">{s.total} total</span>
              {#if s.leads.length > 0}
                <span class="epic-leads">
                  {#each s.leads as lead (lead)}
                    <span class="epic-lead-chip" style="color: {agentColor(lead)}">{lead}</span>
                  {/each}
                </span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section class="overview-section overview-half">
    <h2 class="overview-title">
      <span class="overview-marker overview-marker-deck"></span>
      Epics on Deck
      <span class="overview-count" class:overview-count-zero={epicsOnDeck.length === 0}>{epicsOnDeck.length}</span>
      <span class="overview-hint">queued — no in-progress tickets yet</span>
    </h2>
    {#if epicsOnDeck.length === 0}
      <p class="overview-empty">Queue is empty.</p>
    {:else}
      <ul class="epic-list">
        {#each epicsOnDeck.slice(0, 10) as s (s.epic.id)}
          {@const pri = epicPriority(s.epic)}
          <li class="epic-card epic-deck">
            <div class="epic-head">
              <span class="epic-pri" style="color: {epicPriorityColor(s.epic)}">{pri}</span>
              <span class="epic-id">{s.epic.id}</span>
              <span class="epic-title">{s.epic.title}</span>
              {#if s.total > 0}
                <span class="epic-pct">{s.queued} queued / {s.total}</span>
              {/if}
            </div>
          </li>
        {/each}
      </ul>
      {#if epicsOnDeck.length > 10}
        <p class="overview-more">+{epicsOnDeck.length - 10} more</p>
      {/if}
    {/if}
  </section>
  </div>

  <!-- Milestone progress -->
  {#if milestoneEstimates.length > 0}
    <div class="ms-progress">
      {#each milestoneEstimates as ms}
        <div class="ms-card" class:ms-card-unscoped={!ms.scoped}>
          <div class="ms-header">
            <span class="ms-name">{ms.name}</span>
            {#if ms.scoped}
              <span class="ms-pct">{ms.pctDone}%</span>
            {:else}
              <span class="ms-scope-tag">Not scoped yet</span>
            {/if}
          </div>
          {#if ms.scoped}
            <div class="ms-bar"><div class="ms-bar-fill" style="width: {ms.pctDone}%"></div></div>
            <div class="ms-detail">
              <span>{ms.epicCount} epics</span>
              <span>{ms.doneCount}/{ms.ticketCount} tickets</span>
              {#if ms.totalHours > 0}<span>~{Math.round(ms.weightedDone / ms.ticketCount * ms.totalHours)}h / {ms.totalHours}h</span>{/if}
            </div>
          {:else}
            <div class="ms-bar ms-bar-empty"><div class="ms-bar-fill ms-bar-fill-muted" style="width: 0%"></div></div>
            <div class="ms-detail ms-detail-muted">
              {#if ms.epicCount > 0}
                <span>{ms.epicCount} epic{ms.epicCount === 1 ? "" : "s"} sketched</span>
              {:else}
                <span>No epics yet</span>
              {/if}
              <span class="ms-scope-hint">estimates meaningful once scoped</span>
            </div>
          {/if}
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

    {#if viewerIsAdmin}
    <!-- Budget -->
    <div class="card">
      <h3 class="card-title">Budget</h3>
      {#if budgetStatus}
        <div class="card-stat">{budgetStatus.pctUsed}<span class="stat-label">%</span></div>
        <div class="budget-bar">
          <div
            class="budget-fill"
            class:budget-warn={budgetStatus.pctUsed >= 60}
            class:budget-danger={budgetStatus.pctUsed >= 80}
            style="width: {Math.min(budgetStatus.pctUsed, 100)}%"
          ></div>
        </div>
        <span class="card-sub">${budgetStatus.spent} / ${budgetStatus.budget} · {budgetStatus.daysRemaining}d left</span>
      {:else}
        <div class="card-stat">—</div>
      {/if}
    </div>
    {/if}
  </div>

  <!-- Users graph (7-day history, admin only) -->
  {#if viewerIsAdmin && userAnalytics?.dailyHistory?.length}
    {@const history = userAnalytics.dailyHistory}
    {@const maxNew = Math.max(...history.map(d => d.new), 1)}
    {@const minTotal = Math.min(...history.map(d => d.total))}
    {@const totalRange = Math.max(...history.map(d => d.total)) - minTotal || 1}
    <div class="users-chart-section">
      <h3 class="section-title">Users <span class="section-subtitle">{userAnalytics.totalRegistered} total · +{userAnalytics.newThisWeek} this week</span></h3>
      <div class="users-chart">
        <svg viewBox="0 0 700 160" class="users-svg">
          <polyline
            fill="none"
            stroke="#60a5fa"
            stroke-width="2"
            points={history.map((d, i) => {
              const x = 50 + i * (600 / (history.length - 1 || 1));
              const y = 140 - ((d.total - minTotal) / totalRange) * 120;
              return `${x},${y}`;
            }).join(" ")}
          />
          {#each history as d, i}
            {@const x = 50 + i * (600 / (history.length - 1 || 1))}
            {@const y = 140 - ((d.total - minTotal) / totalRange) * 120}
            {@const barH = (d.new / maxNew) * 40}
            <circle cx={x} cy={y} r="3" fill="#60a5fa" />
            <text x={x} y={y - 8} fill="#60a5fa" font-size="10" text-anchor="middle">{d.total}</text>
            <rect x={x - 12} y={140 - barH} width="24" height={barH} fill="rgba(52, 211, 153, 0.4)" rx="2" />
            {#if d.new > 0}
              <text x={x} y={140 - barH - 3} fill="#34d399" font-size="9" text-anchor="middle">+{d.new}</text>
            {/if}
            <text x={x} y={156} fill="#6b7280" font-size="9" text-anchor="middle">{d.date.slice(5)}</text>
          {/each}
        </svg>
        <div class="users-chart-legend">
          <span class="legend-item"><span class="legend-dot" style="background: #60a5fa"></span> Total users</span>
          <span class="legend-item"><span class="legend-dot" style="background: #34d399"></span> New signups</span>
          <span class="legend-item" style="color: #9ca3af">{userAnalytics.oauthUsers} OAuth · {userAnalytics.emailPasswordUsers} email</span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Site traffic graph (7-day, admin only) -->
  {#if viewerIsAdmin && siteTraffic?.dailyRequests?.length}
    {@const traffic = siteTraffic.dailyRequests}
    {@const maxReq = Math.max(...traffic.map(d => d.requests), 1)}
    <div class="users-chart-section">
      <h3 class="section-title">Site Traffic <span class="section-subtitle">{siteTraffic.totalRequests7d.toLocaleString()} requests (7 days)</span></h3>
      <div class="users-chart">
        <svg viewBox="0 0 700 140" class="users-svg">
          {#each traffic as d, i}
            {@const x = 50 + i * (600 / (traffic.length - 1 || 1))}
            {@const barH = (d.requests / maxReq) * 100}
            <rect x={x - 20} y={120 - barH} width="40" height={barH} fill="rgba(96, 165, 250, 0.5)" rx="3" />
            <text x={x} y={120 - barH - 5} fill="#60a5fa" font-size="10" text-anchor="middle">{d.requests > 999 ? (d.requests / 1000).toFixed(1) + "k" : d.requests}</text>
            <text x={x} y={136} fill="#6b7280" font-size="9" text-anchor="middle">{d.date.slice(5)}</text>
          {/each}
        </svg>
      </div>
    </div>
  {/if}

  <!-- Fixture picker (Legend+ only) -->
  {#if viewerIsLegend}
    <FixturePicker />
  {/if}

  <!-- Historical usage chart (Legend only) -->
  <!-- Current-week usage bars (above the history chart) -->
  {#if usageData && viewerIsLegend}
    <h3 class="section-title">Current Week</h3>
    <div class="usage-bars">
      <div class="usage-row">
        <span class="usage-label">Messages</span>
        <div class="usage-bar"><div class="usage-fill usage-blue" style="width: {usageData.usage.usagePct}%"></div></div>
        <span class="usage-pct">{usageData.usage.messages.toLocaleString()}</span>
      </div>
      <div class="usage-row">
        <span class="usage-label">Time Elapsed</span>
        <div class="usage-bar"><div class="usage-fill usage-grey" style="width: {usageData.week.progressPct}%"></div></div>
        <span class="usage-pct">{usageData.week.progressPct}%</span>
      </div>
      <div class="usage-note" class:usage-ahead={usageData.paceDeltaPct > 5} class:usage-behind={usageData.paceDeltaPct < -5}>
        {#if usageData.paceDeltaPct > 5}
          {usageData.paceDeltaPct}% ahead of pace
        {:else if usageData.paceDeltaPct < -5}
          {Math.abs(usageData.paceDeltaPct)}% behind pace
        {:else}
          on pace
        {/if}
      </div>
    </div>
  {/if}

  {#if viewerIsLegend && usageHistory?.hours?.length > 0}
    <h3 class="section-title">Usage History</h3>
    <div class="history-chart">
      <!-- Legend toggles + moving-average window -->
      <div class="chart-legend-toggles">
        {#each SERIES as s}
          <button
            class="series-toggle"
            class:series-active={activeSeries.has(s.key)}
            style="--series-color: {s.color}"
            onclick={() => toggleSeries(s.key)}
          >
            <span class="series-swatch"></span>
            {s.label}
          </button>
        {/each}
        <span class="ma-window-ctrl">
          Trend:
          <select bind:value={maWindow} class="ma-window-select">
            <option value={7}>7h</option>
            <option value={12}>12h</option>
            <option value={24}>24h</option>
            <option value={48}>48h</option>
            <option value={72}>3d</option>
            <option value={168}>1w</option>
          </select>
        </span>
      </div>

      <!-- One row per active series (small multiples) -->
      {#each SERIES.filter(s => activeSeries.has(s.key)) as s}
        {@const values = usageHistory.hours.map((h: any) => h[s.field] ?? 0)}
        {@const maxVal = Math.max(...values, 1)}
        <div class="series-row">
          <div class="series-label" style="color: {s.color}">
            {s.label}
            <span class="series-max">max {maxVal.toLocaleString()}/hr</span>
          </div>
          <div class="chart-bars">
            {#each usageHistory.hours as h, i}
              {@const prevWeek = i > 0 ? usageHistory.hours[i-1].weekStart : null}
              {@const isWeekStart = prevWeek !== h.weekStart}
              {@const v = h[s.field] ?? 0}
              {#if isWeekStart && i > 0}
                <div class="week-divider" title="Week {h.weekStart}"></div>
              {/if}
              <div class="hour-bar-wrap" title="{h.hour}:00 — {s.label}: {v.toLocaleString()}">
                <div
                  class="hour-bar"
                  style="height: {maxVal > 0 ? (v / maxVal) * 100 : 0}%; background: {s.color};"
                ></div>
              </div>
            {/each}
            <!-- Moving-average overlay -->
            <svg class="ma-overlay" viewBox="0 0 100 100" preserveAspectRatio="none">
              <polyline
                points={mavgPoints(values, maxVal, maWindow)}
                stroke={s.color}
                stroke-width="2.5"
                stroke-linejoin="round"
                stroke-linecap="round"
                vector-effect="non-scaling-stroke"
                fill="none"
                opacity="1"
              />
            </svg>
          </div>
        </div>
      {/each}
      <div class="chart-legend">
        <span>Each series scaled to its own peak. {usageHistory.hours.length} active hours across {usageHistory.weeks.length} weeks. Bars show raw counts (not % of budget — weekly limits have varied with plan changes).</span>
      </div>
    </div>
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
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
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

  .budget-bar {
    width: 100%;
    height: 6px;
    background: rgba(167, 243, 208, 0.1);
    border-radius: 3px;
    overflow: hidden;
    margin: 0.3rem 0;
  }
  .budget-fill {
    height: 100%;
    background: #34d399;
    border-radius: 3px;
    transition: width 0.5s;
  }
  .budget-fill.budget-warn { background: #fbbf24; }
  .budget-fill.budget-danger { background: #f87171; }

  .users-chart-section {
    margin: 1.5rem 0;
  }
  .section-subtitle {
    font-size: 0.8rem;
    color: #6b7280;
    font-weight: 400;
    margin-left: 0.5rem;
  }
  .users-chart {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 6px;
    padding: 1rem;
  }
  .users-svg {
    width: 100%;
    height: auto;
  }
  .users-chart-legend {
    display: flex;
    gap: 1.2rem;
    margin-top: 0.5rem;
    font-size: 0.75rem;
    color: #9ca3af;
  }
  .legend-item {
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .legend-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    display: inline-block;
  }

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

  /* Usage vs Time Elapsed */
  .usage-bars {
    margin: 0.75rem 0;
    padding: 0.75rem 1rem;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 6px;
  }
  .usage-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    margin-bottom: 0.4rem;
  }
  .usage-label {
    font-size: 0.75rem;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    min-width: 6.5rem;
  }
  .usage-bar {
    flex: 1;
    height: 8px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 4px;
    overflow: hidden;
  }
  .usage-fill {
    height: 100%;
    border-radius: 4px;
    transition: width 0.3s;
  }
  .usage-blue { background: #60a5fa; }
  .usage-grey { background: #6b7280; }
  .usage-pct {
    font-size: 0.82rem;
    font-weight: 700;
    color: #d1d5db;
    min-width: 3rem;
    text-align: right;
  }
  .usage-note {
    font-size: 0.72rem;
    color: #6b7280;
    text-align: right;
    margin-top: 0.3rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }
  .usage-note.usage-ahead { color: #fbbf24; }
  .usage-note.usage-behind { color: #a7f3d0; }
  .usage-budget-hint {
    color: #4b5563;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
    margin-left: 0.5rem;
  }

  /* Historical chart */
  .history-chart {
    margin: 0.5rem 0 1rem;
    padding: 0.75rem 1rem;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 6px;
  }
  .chart-legend-toggles {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
    margin-bottom: 0.6rem;
  }
  .series-toggle {
    background: #0d1117;
    border: 1px solid rgba(255, 255, 255, 0.08);
    border-radius: 3px;
    color: #6b7280;
    font-family: inherit;
    font-size: 0.75rem;
    font-weight: 600;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    opacity: 0.5;
    transition: all 0.15s;
  }
  .series-toggle:hover { opacity: 0.8; }
  .series-toggle.series-active {
    opacity: 1;
    color: var(--series-color);
    border-color: var(--series-color);
    background: rgba(0, 0, 0, 0.3);
  }
  .series-swatch {
    width: 10px;
    height: 10px;
    border-radius: 2px;
    background: var(--series-color);
    display: inline-block;
  }
  .series-row {
    margin-bottom: 0.5rem;
  }
  .series-label {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    margin-bottom: 0.25rem;
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
  }
  .series-max {
    font-size: 0.68rem;
    color: #6b7280;
    font-weight: 400;
    text-transform: none;
    letter-spacing: normal;
  }

  .chart-bars {
    position: relative;
    display: flex;
    align-items: flex-end;
    gap: 1px;
    height: 70px;
    padding: 0.15rem 0;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
  }
  .ma-overlay {
    position: absolute;
    inset: 0.15rem 0;
    width: 100%;
    height: calc(100% - 0.3rem);
    pointer-events: none;
    overflow: visible;
  }
  .ma-window-ctrl {
    margin-left: auto;
    font-size: 0.72rem;
    color: #6b7280;
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
  }
  .ma-window-select {
    background: #0d1117;
    color: #d1d5db;
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 3px;
    padding: 0.15rem 0.3rem;
    font-family: inherit;
    font-size: 0.72rem;
    cursor: pointer;
  }
  .hour-bar-wrap {
    flex: 1 1 0;
    min-width: 2px;
    height: 100%;
    display: flex;
    align-items: flex-end;
    cursor: default;
  }
  .hour-bar {
    width: 100%;
    background: linear-gradient(180deg, #60a5fa, #3b82f6);
    min-height: 1px;
    opacity: 0.35;
    transition: opacity 0.15s;
  }
  .hour-bar-wrap:hover .hour-bar { opacity: 1; background: #fbbf24; }
  .week-divider {
    flex: 0 0 1px;
    background: rgba(167, 243, 208, 0.25);
    height: 100%;
    margin: 0 3px;
  }
  .chart-legend {
    margin-top: 0.4rem;
    font-size: 0.7rem;
    color: #4b5563;
    font-style: italic;
  }

  /* ===== Live agents strip (top of console) ===== */
  .agent-strip {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0.75rem 0 0.5rem;
  }
  .agent-strip-empty {
    color: #6b7280;
    font-style: italic;
    font-size: 0.82rem;
    padding: 0.4rem 0;
  }
  .agent-card-mini {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-left: 3px solid var(--agent-color);
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    min-width: 160px;
    max-width: 280px;
  }
  .agent-card-name {
    font-weight: 700;
    font-size: 0.88rem;
    line-height: 1;
    margin-bottom: 0.25rem;
  }
  .agent-card-epic {
    color: #9ca3af;
    font-size: 0.78rem;
    line-height: 1.3;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-card-epic-multi {
    color: #6b7280;
    font-style: italic;
  }
  .agent-card-mini {
    position: relative;
  }
  .agent-card-quiet {
    border-left-color: #fbbf24;
  }
  .agent-card-stale {
    border-left-color: #f87171;
    background: #1a0d0d;
  }
  .agent-card-unverified {
    border-left-color: #6b7280;
    opacity: 0.85;
  }
  .agent-card-corro {
    position: absolute;
    top: 0.3rem;
    right: 0.4rem;
    font-size: 0.7rem;
    line-height: 1;
    font-weight: 700;
  }
  .agent-card-corro-corroborated { color: #34d399; }
  .agent-card-corro-quiet        { color: #fbbf24; }
  .agent-card-corro-stale        { color: #f87171; }
  .agent-card-corro-unverified   { color: #6b7280; }

  .agent-strip-header {
    display: flex;
    align-items: center;
    margin: 0.4rem 0 0.1rem;
  }
  .strip-rollup {
    color: #9ca3af;
    font-size: 0.75rem;
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
    cursor: help;
  }
  .strip-rollup .rollup-ok    { color: #34d399; font-weight: 700; }
  .strip-rollup .rollup-quiet { color: #fbbf24; font-weight: 700; }
  .strip-rollup .rollup-bad   { color: #f87171; font-weight: 700; }
  .strip-rollup .rollup-unk   { color: #6b7280; font-weight: 700; }

  /* ===== Three-section headline overview ===== */
  .overview-epics-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1.25rem;
    margin: 0.75rem 0 0;
  }
  .overview-epics-row .overview-section {
    margin: 0;
  }
  .overview-half {
    min-width: 0; /* allow ellipsis on long titles inside flex/grid columns */
  }
  @media (max-width: 900px) {
    .overview-epics-row { grid-template-columns: 1fr; gap: 0.5rem; }
  }
  .agent-name-unknown {
    color: #9ca3af !important;
    font-style: italic;
    font-weight: 400;
  }
  .agent-tickets-missing {
    color: #6b7280;
    font-style: italic;
  }
  .agent-tickets-missing code {
    color: #9ca3af;
    background: rgba(255, 255, 255, 0.04);
    padding: 0 0.25rem;
    border-radius: 2px;
    font-style: normal;
  }
  .overview-section {
    margin: 0.75rem 0 1.25rem;
  }
  .overview-title {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    color: #d1d5db;
    font-size: 0.95rem;
    font-weight: 700;
    margin: 0 0 0.5rem;
    letter-spacing: 0.01em;
  }
  .overview-marker {
    width: 4px;
    height: 1.05rem;
    border-radius: 2px;
    flex: 0 0 auto;
  }
  .overview-marker-active { background: #34d399; box-shadow: 0 0 6px rgba(52, 211, 153, 0.5); }
  .overview-marker-agent  { background: #f472b6; box-shadow: 0 0 6px rgba(244, 114, 182, 0.5); }
  .overview-marker-deck   { background: #60a5fa; }
  .overview-count {
    background: rgba(167, 243, 208, 0.12);
    color: #a7f3d0;
    border: 1px solid rgba(167, 243, 208, 0.3);
    padding: 0.05rem 0.45rem;
    border-radius: 999px;
    font-size: 0.78rem;
    font-weight: 700;
  }
  .overview-count-zero {
    background: rgba(75, 85, 99, 0.2);
    color: #6b7280;
    border-color: #374151;
  }
  .overview-count-live {
    background: rgba(52, 211, 153, 0.15);
    color: #34d399;
    border-color: rgba(52, 211, 153, 0.4);
  }
  .overview-count-file {
    background: rgba(96, 165, 250, 0.12);
    color: #60a5fa;
    border-color: rgba(96, 165, 250, 0.4);
  }
  .overview-link {
    margin-left: auto;
    color: #60a5fa;
    text-decoration: none;
    font-size: 0.78rem;
    font-weight: 400;
  }
  .overview-link:hover { text-decoration: underline; }
  .overview-hint {
    margin-left: auto;
    color: #6b7280;
    font-size: 0.78rem;
    font-weight: 400;
  }
  .overview-empty {
    color: #6b7280;
    font-style: italic;
    font-size: 0.85rem;
    margin: 0.25rem 0 0;
  }
  .overview-more {
    margin: 0.5rem 0 0;
    font-size: 0.78rem;
    color: #6b7280;
  }
  .overview-more a {
    color: #60a5fa;
    text-decoration: none;
  }
  .overview-more a:hover { text-decoration: underline; }

  .epic-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .epic-card {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 4px;
    padding: 0.55rem 0.85rem;
  }
  .epic-active {
    border-left: 3px solid #34d399;
  }
  .epic-deck {
    border-left: 3px solid #60a5fa;
    opacity: 0.95;
  }
  .epic-head {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-wrap: wrap;
  }
  .epic-pri {
    font-weight: 700;
    font-size: 0.78rem;
    min-width: 1.6rem;
  }
  .epic-id {
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
    color: #6b7280;
  }
  .epic-title {
    color: #e5e7eb;
    font-size: 0.88rem;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .epic-pct {
    color: #9ca3af;
    font-size: 0.78rem;
    font-family: "Courier New", monospace;
    flex-shrink: 0;
  }
  .epic-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin-top: 0.4rem;
  }
  .epic-stat {
    font-size: 0.74rem;
    padding: 0.05rem 0.4rem;
    border-radius: 2px;
    font-family: "Courier New", monospace;
  }
  .epic-stat-active {
    background: rgba(52, 211, 153, 0.12);
    color: #34d399;
    border: 1px solid rgba(52, 211, 153, 0.3);
  }
  .epic-stat-review {
    background: rgba(251, 191, 36, 0.1);
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.3);
  }
  .epic-stat-queued {
    background: rgba(96, 165, 250, 0.1);
    color: #60a5fa;
    border: 1px solid rgba(96, 165, 250, 0.3);
  }
  .epic-stat-total {
    color: #6b7280;
  }
  .epic-leads {
    display: inline-flex;
    gap: 0.3rem;
    margin-left: auto;
  }
  .epic-lead-chip {
    font-weight: 700;
    font-size: 0.74rem;
    padding: 0 0.3rem;
    border-radius: 2px;
    background: rgba(255, 255, 255, 0.04);
  }

  .agent-list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .agent-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.4rem 0.75rem;
    background: #12161e;
    border-left: 3px solid var(--agent-color);
    border-radius: 3px;
    font-size: 0.82rem;
    flex-wrap: wrap;
  }
  .agent-row-stale {
    opacity: 0.75;
    border-left-color: #fbbf24;
    background: rgba(251, 191, 36, 0.04);
  }
  .agent-row-unknown {
    opacity: 0.7;
    border-left-color: #6b7280;
  }
  .agent-state-live {
    background: #34d399;
    color: #052e1a;
    padding: 0.05rem 0.4rem;
    border-radius: 2px;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .agent-state-stale {
    background: #fbbf24;
    color: #422006;
    padding: 0.05rem 0.4rem;
    border-radius: 2px;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .agent-state-unknown {
    background: #6b7280;
    color: #111827;
    padding: 0.05rem 0.4rem;
    border-radius: 2px;
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .agent-name {
    font-weight: 700;
    font-size: 0.85rem;
  }
  .agent-tickets {
    color: #d1d5db;
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-elapsed {
    color: #34d399;
    font-weight: 600;
    font-size: 0.78rem;
    flex-shrink: 0;
  }
  .agent-row-stale .agent-elapsed { color: #fbbf24; }
  .agent-subagents {
    color: #6b7280;
    font-size: 0.74rem;
    flex-shrink: 0;
  }

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

  /* Unscoped milestones (Alpha / Beta before they're broken into epics).
     Muted styling signals "this is a placeholder; estimation isn't
     meaningful yet" — visible in the progression but obviously not
     tracking live work. */
  .ms-card-unscoped {
    border-color: rgba(156, 163, 175, 0.18);
    background: rgba(18, 22, 30, 0.5);
  }
  .ms-card-unscoped .ms-name {
    color: #9ca3af;
  }
  .ms-scope-tag {
    font-size: 0.72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: #9ca3af;
    border: 1px dashed rgba(156, 163, 175, 0.45);
    padding: 0.1rem 0.45rem;
    border-radius: 2px;
  }
  .ms-bar-empty {
    background: rgba(255, 255, 255, 0.03);
  }
  .ms-bar-fill-muted {
    background: rgba(156, 163, 175, 0.25);
  }
  .ms-detail-muted {
    color: rgba(156, 163, 175, 0.7);
  }
  .ms-scope-hint {
    font-style: italic;
    color: rgba(156, 163, 175, 0.55);
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
