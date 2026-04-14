<script lang="ts">
  import type { TicketsFile, Ticket, TicketPriority, EpicsFile, Epic } from "../lib/ticketTypes";
  import {
    PRIORITY_ORDER, PRIORITY_META, EXPERT_META, TEST_SHAPE_META, COMMENT_TYPE_META,
    phaseColor, effectivePhase, subtaskProgress,
  } from "../lib/ticketTypes";
  import type { Comment } from "../lib/ticketTypes";
  import type { ChatMessage } from "../lib/ticketTypes";
  import { fetchTickets, fetchEpics, fetchAgentChat } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));
  let viewerIsLegend = $derived(isTierAtLeast(auth.currentUser, "legend"));

  let tickets = $state<TicketsFile | null>(null);
  let epicsData = $state<EpicsFile | null>(null);
  let chatMessages = $state<ChatMessage[]>([]);
  let loadError = $state<string | null>(null);
  let filterPriority = $state<TicketPriority | "all">("all");
  let filterPhase = $state<string>("planning");
  let filterMilestone = $state<string>("pre_alpha");

  // Track open/closed state of folds in sessionStorage (survives polling, resets on refresh)
  const FOLD_KEY = "tickets-folds";
  let openFolds = $state<Set<string>>(new Set());

  function isFoldOpen(key: string): boolean {
    return openFolds.has(key);
  }

  function toggleFold(key: string) {
    const next = new Set(openFolds);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    openFolds = next;
    sessionStorage.setItem(FOLD_KEY, JSON.stringify([...next]));
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      const [t, e, c] = await Promise.all([fetchTickets(), fetchEpics(), fetchAgentChat().catch(() => [])]);
      tickets = t;
      epicsData = e;
      chatMessages = c;
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

  // --- Swim lanes ---
  const LANE_ORDER = ["planning", "tech_review", "ready", "in_progress", "testing", "done"];
  const LANE_LABELS: Record<string, string> = {
    planning: "Planning",
    tech_review: "Tech Review",
    ready: "Ready",
    in_progress: "In Progress",
    testing: "Testing",
    done: "Done",
  };

  // Ticket → milestone lookup via epics
  const MS_ORDER = ["pre_alpha", "alpha", "beta"];
  const MS_LABELS: Record<string, string> = { pre_alpha: "Pre-Alpha", alpha: "Alpha", beta: "Beta" };

  let ticketMilestone = $derived.by<Map<string, string>>(() => {
    const m = new Map<string, string>();
    if (!epicsData) return m;
    const epicById = new Map(epicsData.epics.map((e) => [e.id, e]));
    // Map from epic's ticketIds
    for (const epic of epicsData.epics) {
      for (const tid of epic.ticketIds) m.set(tid, epic.milestone);
    }
    // Also map from ticket's own epic field (catches tickets added after epics.json was last updated)
    if (tickets) {
      for (const t of tickets.tickets) {
        if (!m.has(t.id) && t.epic) {
          const epic = epicById.get(t.epic);
          if (epic) m.set(t.id, epic.milestone);
        }
      }
    }
    return m;
  });

  let milestones = $derived.by<{ id: string; label: string; count: number }[]>(() => {
    if (!tickets) return [];
    const counts = new Map<string, number>();
    for (const t of tickets.tickets) {
      const ms = ticketMilestone.get(t.id) ?? "_none";
      counts.set(ms, (counts.get(ms) ?? 0) + 1);
    }
    // Count epics per milestone and their states
    const epicTotal = new Map<string, number>();
    const epicActive = new Map<string, number>();
    const epicWaiting = new Map<string, number>();
    if (epicsData && tickets) {
      const ticketById = new Map(tickets.tickets.map(t => [t.id, t]));
      for (const e of epicsData.epics) {
        const ms = e.milestone;
        epicTotal.set(ms, (epicTotal.get(ms) ?? 0) + 1);
        // Check if epic has active tickets (in_progress/testing)
        const hasActive = e.ticketIds.some(tid => {
          const t = ticketById.get(tid);
          return t && (effectivePhase(t) === "in_progress" || effectivePhase(t) === "testing");
        });
        if (hasActive) epicActive.set(ms, (epicActive.get(ms) ?? 0) + 1);
        // Check if epic needs owner input
        if (e.ownerReviewNeeded) epicWaiting.set(ms, (epicWaiting.get(ms) ?? 0) + 1);
      }
    }
    // Always show all three milestones even if count is 0
    return MS_ORDER.map((ms) => ({
      id: ms,
      label: MS_LABELS[ms] ?? ms,
      count: counts.get(ms) ?? 0,
      epicCount: epicTotal.get(ms) ?? 0,
      epicActive: epicActive.get(ms) ?? 0,
      epicWaiting: epicWaiting.get(ms) ?? 0,
    }));
  });

  // Pre-filter by milestone (applies to both swim lanes and ticket list)
  let milestoneFiltered = $derived.by<Ticket[]>(() => {
    if (!tickets) return [];
    let list = tickets.tickets;
    if (!viewerIsLegend) {
      list = list.filter((t) => t.priority !== "P3" && effectivePhase(t) !== "deferred");
    }
    if (filterMilestone !== "all") {
      list = list.filter((t) => ticketMilestone.get(t.id) === filterMilestone);
    }
    return list;
  });

  interface Lane { phase: string; tickets: Ticket[]; }
  let lanes = $derived.by<Lane[]>(() => {
    const map = new Map<string, Ticket[]>();
    for (const p of LANE_ORDER) map.set(p, []);
    for (const t of milestoneFiltered) {
      const p = effectivePhase(t);
      if (p === "deferred") continue;
      const bucket = map.get(p);
      if (bucket) bucket.push(t);
    }
    return LANE_ORDER.map((p) => ({ phase: p, tickets: map.get(p)! }));
  });

  // --- Filtered list (milestone + priority + phase) ---
  let filtered = $derived.by<Ticket[]>(() => {
    let list = milestoneFiltered;
    if (filterPriority !== "all") {
      list = list.filter((t) => t.priority === filterPriority);
    }
    if (filterPhase !== "all") {
      list = list.filter((t) => effectivePhase(t) === filterPhase);
    }
    return list;
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

  // Group filtered tickets by epic
  interface EpicGroup {
    epic: Epic | null; // null = uncategorized
    label: string;
    tickets: Ticket[];       // matched by phase filter
    allTickets: Ticket[];    // all tickets in epic (milestone-filtered only)
    doneCount: number;
    totalInEpic: number;
    hours: number;
  }
  let epicGroups = $derived.by<EpicGroup[]>(() => {
    if (!epicsData) return [];
    const epicMap = new Map<string, Epic>();
    for (const e of epicsData.epics) epicMap.set(e.id, e);

    // Build epic→ticket IDs from both epics.json and ticket back-references
    const epicTicketIds = new Map<string, Set<string>>();
    for (const e of epicsData.epics) epicTicketIds.set(e.id, new Set(e.ticketIds));
    if (tickets) {
      for (const t of tickets.tickets) {
        if (t.epic && epicTicketIds.has(t.epic)) epicTicketIds.get(t.epic)!.add(t.id);
      }
    }

    // Group filtered tickets by epic (phase-filtered)
    const groups = new Map<string, Ticket[]>();
    const assigned = new Set<string>();
    for (const t of filtered) {
      const eid = t.epic;
      if (eid && epicMap.has(eid)) {
        if (!groups.has(eid)) groups.set(eid, []);
        groups.get(eid)!.push(t);
        assigned.add(t.id);
      }
    }
    const uncategorized = filtered.filter((t) => !assigned.has(t.id));

    // All tickets per epic (milestone-filtered only, ignoring phase)
    const allGroups = new Map<string, Ticket[]>();
    for (const t of milestoneFiltered) {
      const eid = t.epic;
      if (eid && epicMap.has(eid)) {
        if (!allGroups.has(eid)) allGroups.set(eid, []);
        allGroups.get(eid)!.push(t);
      }
    }

    // Build all ticket map for done counts across ALL tickets (not just filtered)
    const allTicketById = new Map<string, Ticket>();
    if (tickets) for (const t of tickets.tickets) allTicketById.set(t.id, t);

    // Show ALL epics in the selected milestone
    // Sort: epics with matching tickets first, then done epics last
    const result: EpicGroup[] = [];
    for (const epic of epicsData.epics) {
      if (filterMilestone !== "all" && epic.milestone !== filterMilestone) continue;
      const allIds = epicTicketIds.get(epic.id) ?? new Set<string>();
      const doneCount = [...allIds].filter((id) => { const t = allTicketById.get(id); return t && effectivePhase(t) === "done"; }).length;
      result.push({
        epic,
        label: epic.title,
        tickets: groups.get(epic.id) ?? [],
        allTickets: allGroups.get(epic.id) ?? [],
        doneCount,
        totalInEpic: allIds.size,
        hours: epic.estimatedHours ?? 0,
      });
    }
    if (uncategorized.length > 0) {
      result.push({
        epic: null,
        label: "Uncategorized",
        tickets: uncategorized,
        allTickets: uncategorized,
        doneCount: 0,
        totalInEpic: uncategorized.length,
        hours: 0,
      });
    }
    // Sort: has matching tickets → no matches (but not done) → fully done
    result.sort((a, b) => {
      const aDone = a.totalInEpic > 0 && a.doneCount === a.totalInEpic;
      const bDone = b.totalInEpic > 0 && b.doneCount === b.totalInEpic;
      if (aDone !== bDone) return aDone ? 1 : -1;
      const aHas = a.tickets.length > 0;
      const bHas = b.tickets.length > 0;
      if (aHas !== bHas) return aHas ? -1 : 1;
      return 0;
    });
    return result;
  });

  // Tickets that still have pending decisions (shared between stats and template)
  let ticketsWithPending = $derived.by<Set<string>>(() => {
    const s = new Set<string>();
    for (const m of chatMessages) {
      if ((m as any).decision?.status === "pending") {
        for (const tid of (m as any).refs?.tickets ?? []) s.add(tid);
      }
    }
    return s;
  });

  // Quick stats for the selected milestone
  let epicStats = $derived.by(() => {
    const total = epicGroups.filter((eg) => eg.epic != null).length;
    const withPlanning = epicGroups.filter((eg) => eg.epic != null && eg.allTickets.some((t) => effectivePhase(t) === "planning")).length;
    const needsReview = epicGroups.filter((eg) => {
      if (!eg.epic?.ownerReviewNeeded) return false;
      if (ticketsWithPending.size === 0) return false;
      return eg.allTickets.some((t) => ticketsWithPending.has(t.id));
    }).length;
    const done = epicGroups.filter((eg) => eg.epic != null && eg.totalInEpic > 0 && eg.doneCount === eg.totalInEpic).length;
    return { total, withPlanning, needsReview, done };
  });

  function relativeDate(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }
</script>

{#snippet ticketCard(t: Ticket, prog: { done: number; total: number })}
  <div class="ticket-card" class:blocker={t.blocksDemo}>
    <div class="ticket-header">
      <span class="ticket-priority" style="color: {PRIORITY_META[t.priority as TicketPriority]?.color ?? '#9ca3af'}">
        {t.priority}
      </span>
      <span class="ticket-id">{t.id}</span>
      <span class="ticket-phase" style="color: {phaseColor(effectivePhase(t))}">
        {effectivePhase(t).replace(/_/g, " ")}
      </span>
      {#if t.awaitingOwner}
        <span class="awaiting-badge">NEEDS CONFIRM</span>
      {/if}
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
      {#if t.leads?.length}
        {#each t.leads as lead}
          <span class="meta-lead" style="color: {EXPERT_META[lead.toLowerCase()]?.color ?? '#9ca3af'}">{lead}</span>
        {/each}
      {/if}
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
    {#if t.subtasks?.length && viewerIsLegend}
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
    {#if t.successCriteria?.length}
      <div class="success-criteria">
        <h4 class="sc-title">Success Criteria</h4>
        {#each t.successCriteria as sc}
          <div class="criterion-row">
            <span class="criterion-check" class:approved={sc.veraApproved}>{sc.veraApproved ? "V" : "?"}</span>
            <div class="criterion-body">
              <span class="criterion-text">{sc.criterion}</span>
              {#if sc.testSpec}
                <span class="criterion-spec">{sc.testSpec}</span>
              {/if}
              {#if sc.testShape}
                <span class="test-shape-badge" style="color: {TEST_SHAPE_META[sc.testShape]?.color ?? '#9ca3af'}">
                  {sc.testShape}
                </span>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
    {#if t.leadReview && Object.keys(t.leadReview).length > 0}
      <div class="lead-signoffs">
        {#each Object.entries(t.leadReview) as [agent, review]}
          {@const call = typeof review === "string" ? review.split(" ")[0] : (review as any)?.call ?? "watch"}
          {@const note = typeof review === "string" ? review : (review as any)?.note ?? ""}
          <span class="signoff-chip signoff-{call}" title={note}>
            {EXPERT_META[agent.toLowerCase()]?.label ?? agent}: {call}
          </span>
        {/each}
      </div>
    {/if}
    {#if t.comments?.length}
      {@const showAll = isFoldOpen(`comments:${t.id}`)}
      {@const visibleComments = showAll ? t.comments : t.comments.slice(-3)}
      <div class="discussion">
        <h4 class="disc-title">
          Discussion ({t.comments.length})
          {#if t.comments.length > 3}
            <button class="disc-toggle" aria-label="Toggle all comments" onclick={() => toggleFold(`comments:${t.id}`)}>
              {showAll ? "Show recent" : `Show all ${t.comments.length}`}
            </button>
          {/if}
        </h4>
        {#each visibleComments as c}
          {@const meta = EXPERT_META[c.author.toLowerCase()]}
          {@const typeMeta = COMMENT_TYPE_META[c.type as keyof typeof COMMENT_TYPE_META]}
          <div class="comment" class:comment-question={c.type === "question"} style="--author-color: {meta?.color ?? '#9ca3af'}">
            <div class="comment-header">
              <a href="/test/agents/#agent-{c.author.toLowerCase()}" class="comment-author" style="color: {meta?.color ?? '#9ca3af'}">{meta?.label ?? c.author}</a>
              <span class="comment-type" style="color: {typeMeta?.color ?? '#9ca3af'}">{typeMeta?.label ?? c.type}</span>
              <span class="comment-time">{relativeDate(c.timestamp)}</span>
            </div>
            <p class="comment-body">{c.content}</p>
          </div>
        {/each}
      </div>
    {/if}
    <p class="ticket-update">{t.lastUpdate}</p>
  </div>
{/snippet}

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

    <!-- Milestone filter -->
    {#if milestones.length > 0}
      <div class="ms-filters">
        {#each milestones as ms (ms.id)}
          <button
            class="ms-btn"
            class:ms-active={filterMilestone === ms.id}
            class:ms-empty={ms.count === 0}
            onclick={() => { filterMilestone = ms.id; }}
          >{ms.label} <span class="badge badge-green">{ms.epicActive}</span><span class="badge badge-yellow">{ms.epicWaiting}</span><span class="badge badge-grey">{ms.epicCount}</span></button>
        {/each}
        <button
          class="ms-btn"
          class:ms-active={filterMilestone === "all"}
          onclick={() => { filterMilestone = "all"; }}
        >All</button>
      </div>
    {/if}

    <!-- Phase swim lanes -->
    <div class="lane-stats">
      {#if epicStats.withPlanning > 0}
        <span class="stat stat-planning">{epicStats.withPlanning} epics in planning</span>
      {/if}
      {#if epicStats.needsReview > 0}
        <span class="stat stat-review">{epicStats.needsReview} need your review</span>
      {/if}
    </div>
    <div class="swim-lanes">
      {#each lanes as lane (lane.phase)}
        {@const epicIds = new Set(lane.tickets.map(t => t.epic).filter(Boolean))}
        {@const allEpicCount = epicsData ? epicsData.epics.filter(e => filterMilestone === "all" || e.milestone === filterMilestone).length : epicIds.size}
        {@const epicsActive = epicIds.size}
        {@const epicsWaiting = [...epicIds].filter(eid => lane.tickets.some(t => t.epic === eid && t.awaitingOwner && effectivePhase(t) !== "done")).length}
        <button
          class="lane"
          class:lane-empty={lane.tickets.length === 0}
          class:lane-active={filterPhase === lane.phase}
          onclick={() => { filterPhase = filterPhase === lane.phase ? "all" : lane.phase; }}
        >
          <span class="lane-ticket-count" style="color: {phaseColor(lane.phase)}">{lane.tickets.length}</span>
          <div class="lane-badges">
            <span class="badge badge-green">{epicsActive}</span>
            <span class="badge badge-yellow">{epicsWaiting}</span>
            <span class="badge badge-grey">{allEpicCount}</span>
          </div>
          <span class="lane-label">{LANE_LABELS[lane.phase]}</span>
        </button>
      {/each}
    </div>

    <!-- Filters -->
    <div class="filters">
      <select bind:value={filterPriority} class="filter-select">
        <option value="all">All priorities</option>
        {#each PRIORITY_ORDER as p}
          <option value={p}>{p} — {PRIORITY_META[p].label}</option>
        {/each}
      </select>
      {#if filterPhase !== "all"}
        <button class="filter-clear" onclick={() => { filterPhase = "all"; }}>
          Clear phase filter
        </button>
      {/if}
    </div>

    <!-- Tickets grouped by epic -->
    {#if epicGroups.length > 0}
      {@const firstNoMatch = epicGroups.findIndex((eg) => eg.tickets.length === 0)}
      {#each epicGroups as eg, i (eg.label)}
        {@const epicDone = eg.totalInEpic > 0 && eg.doneCount === eg.totalInEpic}
        {#if i === firstNoMatch && firstNoMatch > 0}
          <div class="epic-divider">
            <span class="epic-divider-text">{filterPhase !== "all" ? `No tickets in ${LANE_LABELS[filterPhase] ?? filterPhase}` : "Other epics"}</span>
          </div>
        {/if}
        <div class="epic-row" class:epic-no-matches={eg.tickets.length === 0 && !epicDone} class:epic-done={epicDone}>
          <details class="epic-fold" open={isFoldOpen(`epic:${eg.label}`)}>
            <summary class="epic-fold-summary" onclick={(e) => { e.preventDefault(); toggleFold(`epic:${eg.label}`); }}>
              <span class="fold-arrow"></span>
              <span class="epic-label">{eg.label}</span>
              <span class="epic-progress">{eg.doneCount}/{eg.totalInEpic}</span>
              <span class="epic-bar"><span class="epic-bar-fill" style="width: {eg.totalInEpic > 0 ? (eg.doneCount / eg.totalInEpic * 100).toFixed(0) : 0}%"></span></span>
              {#if eg.hours > 0}<span class="epic-hours">~{eg.hours}h</span>{/if}
              {#if eg.epic?.ownerReviewNeeded && eg.allTickets.some((t) => ticketsWithPending.has(t.id))}
                <span class="epic-review-badge" title={eg.epic.ownerReviewReason ?? ""}>REVIEW</span>
              {/if}
              {#if eg.tickets.some((t) => t.awaitingOwner && effectivePhase(t) !== "done")}
                <span class="epic-awaiting-badge">NEEDS CONFIRM</span>
              {/if}
              {#if eg.tickets.length > 0}<span class="epic-showing">{eg.tickets.length} in phase</span>{/if}
            </summary>
            <div class="epic-fold-content">
              {#each eg.tickets.length > 0 ? eg.tickets : eg.allTickets as t (t.id)}
              {@const prog = subtaskProgress(t)}
              <details class="ticket-fold" open={isFoldOpen(`ticket:${t.id}`)}>
                <summary class="ticket-fold-summary" onclick={(e) => { e.preventDefault(); toggleFold(`ticket:${t.id}`); }}>
                  <span class="fold-arrow"></span>
                  <span class="ticket-priority" style="color: {PRIORITY_META[t.priority as TicketPriority]?.color ?? '#9ca3af'}">{t.priority}</span>
                  <span class="ticket-id">{t.id}</span>
                  <span class="ticket-title-inline">{t.title}</span>
                  <span class="ticket-phase-inline" style="color: {phaseColor(effectivePhase(t))}">{effectivePhase(t).replace(/_/g, " ")}</span>
                  {#if t.awaitingOwner}<span class="awaiting-badge">NEEDS CONFIRM</span>{/if}
                  {#if t.blocksDemo}<span class="blocker-badge">BLOCKER</span>{/if}
                  {#if prog.total > 0}<span class="fold-counts">{prog.done}/{prog.total}</span>{/if}
                </summary>
                <div class="ticket-fold-content">
                  {@render ticketCard(t, prog)}
                </div>
              </details>
            {/each}
          </div>
        </details>
        </div>
      {/each}
    {:else if filtered.length === 0 && filterPhase !== "all"}
      <div class="empty-state">No tickets in {LANE_LABELS[filterPhase] ?? filterPhase}</div>
    {/if}

    {#if !viewerIsLegend}
      <div class="legend-gate">
        <span>Deferred tickets, P3 backlog, and subtask detail are <strong>Legend</strong> tier perks.</span>
        <a href="/subscribe/">Upgrade →</a>
      </div>
    {/if}
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

  /* Summary bar */
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

  /* Milestone filter */
  .ms-filters {
    display: flex;
    gap: 0.35rem;
    margin: 0.5rem 0;
  }
  .ms-btn {
    background: #0d1117;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 3px;
    color: #6b7280;
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    transition: all 0.15s;
    display: flex;
    align-items: center;
    gap: 0.3rem;
  }
  .ms-btn:hover { color: #d1d5db; border-color: rgba(167, 243, 208, 0.25); }
  .ms-btn.ms-active {
    color: #a7f3d0;
    border-color: #a7f3d0;
    background: rgba(167, 243, 208, 0.08);
  }
  .ms-btn.ms-empty { opacity: 0.4; }
  .ms-epics {
    font-size: 0.65rem;
    color: #4b5563;
    font-weight: 400;
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
  }

  /* Shared badge styles */
  .badge {
    font-size: 0.68rem;
    padding: 0.05rem 0.3rem;
    border-radius: 2px;
    border: 1px solid;
    font-weight: 600;
    display: inline-block;
  }
  .badge-green {
    color: #34d399;
    background: rgba(52, 211, 153, 0.12);
    border-color: rgba(52, 211, 153, 0.4);
  }
  .badge-yellow {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    border-color: rgba(251, 191, 36, 0.35);
  }
  .badge-grey {
    color: #6b7280;
    background: rgba(107, 114, 128, 0.08);
    border-color: rgba(107, 114, 128, 0.2);
  }

  /* Lane stats */
  .lane-stats {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.25rem 0;
    font-size: 0.75rem;
  }
  .stat-planning { color: #818cf8; }
  .stat-review {
    color: #fbbf24;
    font-weight: 700;
  }

  /* Swim lanes */
  .swim-lanes {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 0.4rem;
    margin: 0.75rem 0;
  }
  .lane {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.2rem;
    padding: 0.5rem 0.3rem;
    background: #0d1117;
    border: 1px solid rgba(255, 255, 255, 0.04);
    border-radius: 4px;
    cursor: pointer;
    font-family: inherit;
    color: inherit;
    opacity: 0.5;
    transition: all 0.15s;
  }
  .lane:hover { opacity: 0.75; border-color: rgba(167, 243, 208, 0.2); }
  .lane-active {
    opacity: 1 !important;
    background: rgba(167, 243, 208, 0.08);
    border-color: #a7f3d0;
    border-width: 2px;
    box-shadow: 0 0 8px rgba(167, 243, 208, 0.15);
  }
  .lane-active .lane-label { color: #a7f3d0; }
  .lane-empty { opacity: 0.25; }
  .lane-ticket-count {
    font-size: 1.4rem;
    font-weight: 700;
    line-height: 1;
  }
  .lane-badges {
    display: flex;
    gap: 0.2rem;
    justify-content: center;
  }
  .lane-label {
    font-size: 0.68rem;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    text-align: center;
  }

  /* Filters */
  .filters {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 1rem;
    align-items: center;
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
  .filter-clear {
    background: none;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 3px;
    color: #9ca3af;
    font-family: inherit;
    font-size: 0.75rem;
    padding: 0.3rem 0.5rem;
    cursor: pointer;
  }
  .filter-clear:hover { color: #d1d5db; border-color: rgba(167, 243, 208, 0.4); }

  /* Epic groups */
  .epic-fold {
    margin: 0 0 0.5rem;
    border: none;
  }
  .epic-fold-summary {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    list-style: none;
    padding: 0.5rem 0;
    user-select: none;
    border-bottom: 1px solid rgba(167, 243, 208, 0.1);
  }
  .epic-fold-summary::-webkit-details-marker { display: none; }
  .epic-label {
    font-size: 0.88rem;
    color: #e5e7eb;
    font-weight: 600;
  }
  .epic-progress {
    font-size: 0.78rem;
    color: #a7f3d0;
    font-weight: 700;
    flex-shrink: 0;
  }
  .epic-bar {
    width: 50px;
    height: 4px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 2px;
    overflow: hidden;
    flex-shrink: 0;
  }
  .epic-bar-fill {
    display: block;
    height: 100%;
    background: #a7f3d0;
  }
  .epic-hours {
    font-size: 0.72rem;
    color: #4b5563;
  }
  .epic-review-badge {
    font-size: 0.6rem;
    font-weight: 700;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 2px;
    padding: 0 0.3rem;
    letter-spacing: 0.08em;
    cursor: help;
  }
  .epic-showing {
    font-size: 0.72rem;
    color: #6b7280;
    margin-left: auto;
  }
  .epic-fold-content {
    padding-left: 0.5rem;
  }
  .epic-row.epic-no-matches { opacity: 0.4; }
  .epic-row.epic-done { opacity: 0.35; }
  .epic-row.epic-done .epic-label { text-decoration: line-through; }
  .epic-divider {
    border-top: 1px dashed rgba(167, 243, 208, 0.2);
    margin: 0.75rem 0 0.5rem;
    padding-top: 0.4rem;
  }
  .epic-divider-text {
    font-size: 0.7rem;
    color: #4b5563;
    text-transform: uppercase;
    letter-spacing: 0.06em;
  }
  .empty-state {
    text-align: center;
    padding: 2rem;
    color: #6b7280;
    font-size: 0.85rem;
  }

  /* Ticket folds */
  .ticket-fold {
    margin: 0;
    border: none;
  }
  .ticket-fold-summary {
    display: flex;
    align-items: center;
    gap: 0.45rem;
    cursor: pointer;
    list-style: none;
    padding: 0.4rem 0;
    user-select: none;
    font-size: 0.82rem;
  }
  .ticket-fold-summary::-webkit-details-marker { display: none; }
  .fold-arrow {
    width: 0;
    height: 0;
    border-left: 5px solid currentColor;
    border-top: 4px solid transparent;
    border-bottom: 4px solid transparent;
    flex-shrink: 0;
    transition: transform 0.15s;
    color: #4b5563;
  }
  details[open] > .ticket-fold-summary > .fold-arrow {
    transform: rotate(90deg);
  }
  .fold-counts {
    font-size: 0.75rem;
    color: #6b7280;
    margin-left: auto;
  }
  .ticket-fold-content {
    padding-left: 1rem;
    padding-bottom: 0.5rem;
  }

  .ticket-id { color: #6b7280; font-size: 0.75rem; flex-shrink: 0; }
  .ticket-title-inline {
    color: #d1d5db;
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .ticket-phase-inline {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    flex-shrink: 0;
  }
  .awaiting-badge {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    background: rgba(251, 191, 36, 0.15);
    border: 1px solid rgba(251, 191, 36, 0.5);
    border-radius: 2px;
    color: #fbbf24;
    letter-spacing: 0.08em;
    font-weight: 700;
    flex-shrink: 0;
  }
  .epic-awaiting-badge {
    font-size: 0.6rem;
    font-weight: 700;
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 2px;
    padding: 0 0.3rem;
    letter-spacing: 0.08em;
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
    flex-shrink: 0;
  }

  /* Ticket card (expanded) */
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
  .ticket-phase {
    margin-left: auto;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
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
  .meta-lead {
    font-weight: 600;
    font-size: 0.72rem;
    padding: 0.05rem 0.3rem;
    border: 1px solid currentColor;
    border-radius: 2px;
    opacity: 0.8;
  }
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

  .subtask-details { margin-top: 0.4rem; }
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

  /* Success criteria */
  .success-criteria {
    margin: 0.6rem 0 0.3rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    padding-top: 0.5rem;
  }
  .sc-title {
    font-size: 0.75rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 0.35rem;
  }
  .criterion-row {
    display: flex;
    gap: 0.5rem;
    padding: 0.25rem 0;
    align-items: flex-start;
  }
  .criterion-check {
    flex-shrink: 0;
    width: 1.2rem;
    height: 1.2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 2px;
    font-size: 0.7rem;
    font-weight: 700;
    background: rgba(251, 191, 36, 0.12);
    color: #fbbf24;
    border: 1px solid rgba(251, 191, 36, 0.3);
  }
  .criterion-check.approved {
    background: rgba(167, 243, 208, 0.12);
    color: #a7f3d0;
    border-color: rgba(167, 243, 208, 0.3);
  }
  .criterion-body {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .criterion-text { font-size: 0.82rem; color: #d1d5db; }
  .criterion-spec { font-size: 0.75rem; color: #6b7280; font-style: italic; }
  .test-shape-badge { font-size: 0.68rem; font-weight: 700; letter-spacing: 0.06em; }

  /* Lead signoffs */
  .lead-signoffs {
    display: flex;
    flex-wrap: wrap;
    gap: 0.35rem;
    margin: 0.5rem 0;
  }
  .signoff-chip {
    font-size: 0.72rem;
    padding: 0.1rem 0.4rem;
    border-radius: 2px;
    border: 1px solid rgba(156, 163, 175, 0.3);
    color: #9ca3af;
  }
  .signoff-chip.signoff-needed {
    border-color: rgba(251, 191, 36, 0.4);
    color: #fbbf24;
  }
  .signoff-chip.signoff-clear {
    border-color: rgba(167, 243, 208, 0.3);
    color: #a7f3d0;
  }
  .signoff-chip.signoff-watch {
    border-color: rgba(156, 163, 175, 0.3);
    color: #9ca3af;
  }

  /* Discussion thread */
  .discussion {
    margin: 0.6rem 0 0.3rem;
    border-top: 1px solid rgba(255, 255, 255, 0.05);
    padding-top: 0.5rem;
  }
  .disc-title {
    font-size: 0.75rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin: 0 0 0.4rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .disc-toggle {
    background: none;
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 2px;
    color: #6b7280;
    font-family: inherit;
    font-size: 0.68rem;
    padding: 0.1rem 0.4rem;
    cursor: pointer;
    text-transform: none;
    letter-spacing: normal;
  }
  .disc-toggle:hover { color: #a7f3d0; border-color: rgba(167, 243, 208, 0.4); }
  .comment {
    padding: 0.4rem 0.6rem;
    margin-bottom: 0.3rem;
    border-left: 2px solid var(--author-color);
    background: rgba(255, 255, 255, 0.02);
    border-radius: 0 3px 3px 0;
  }
  .comment-question {
    background: rgba(251, 191, 36, 0.04);
  }
  .comment-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.2rem;
  }
  .comment-author {
    font-weight: 700;
    font-size: 0.78rem;
    text-decoration: none;
  }
  .comment-author:hover { text-decoration: underline; }
  .comment-type {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .comment-time {
    margin-left: auto;
    font-size: 0.68rem;
    color: #4b5563;
  }
  .comment-body {
    font-size: 0.8rem;
    color: #d1d5db;
    margin: 0;
    line-height: 1.45;
    white-space: pre-wrap;
  }

  @media (max-width: 640px) {
    .tickets-page { padding: 0.5rem 0.5rem 2rem; }
    .summary-bar { font-size: 0.75rem; }
    .ms-filters { flex-wrap: wrap; }
    .ticket-meta { font-size: 0.72rem; }
    .filters { flex-direction: column; }
    .blocker-badge { font-size: 0.65rem; }
    .swim-lanes { grid-template-columns: repeat(3, 1fr); }
    .epic-fold-summary { flex-wrap: wrap; }
    .lane-stats { flex-wrap: wrap; }
  }
</style>
