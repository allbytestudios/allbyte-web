<script lang="ts">
  import type { TestIndex, TestRunStatus } from "../lib/testIndex";
  import type { TestingRoadmap } from "../lib/testingRoadmap";
  import type { SyncHeartbeat } from "../lib/testDataSource";
  import type { BdIssue } from "../lib/beadsTypes";
  import type { MilestoneMeta } from "../lib/milestones";
  import { TIER_META } from "../lib/testIndex";
  import {
    fetchIndex, fetchStatus, fetchRoadmap, fetchHeartbeat,
    fetchUserAnalytics, fetchBudgetStatus, fetchSiteTraffic,
  } from "../lib/testDataSource";
  import { fetchBeadsIssues } from "../lib/beadsSource";
  import { epicsOnly, isOpen, isClosed } from "../lib/beadsTypes";
  import { milestonesOrdered, milestoneIdFromLabels } from "../lib/milestones";
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

  // Shared time-range selector for all three historical charts (Users,
  // Site Traffic, Usage History). Owner spec (2026-06-03): one dropdown
  // controls every graph in unison — keeps comparison consistent across
  // panes and removes redundant chrome. Backend currently returns ~7
  // days of daily data and a rolling hourly window for usage; the
  // dropdown slices client-side, so "month" / "year" may render with
  // whatever data is available (smaller than the nominal range until
  // backend returns more).
  type TimeRange = "week" | "month" | "year";
  let graphRange = $state<TimeRange>("week");

  // Convert a range to the slice length in DAYS for daily-bucket data.
  function rangeDays(r: TimeRange): number {
    return r === "week" ? 7 : r === "month" ? 30 : 365;
  }
  // Convert a range to the slice length in HOURS for hourly-bucket data.
  function rangeHours(r: TimeRange): number {
    return r === "week" ? 7 * 24 : r === "month" ? 30 * 24 : 365 * 24;
  }
  // Moving-average window for the usage chart; scales with the selected
  // time range (24h smoothing for a week of data, daily for a month,
  // weekly for a year).
  function rangeMaWindow(r: TimeRange): number {
    return r === "week" ? 24 : r === "month" ? 24 * 7 : 24 * 30;
  }
  let maWindow = $derived(rangeMaWindow(graphRange));
  // Sliced usage hours used by the chart. $derived so a range change
  // re-renders cleanly.
  let usageHours = $derived(usageHistory.hours.slice(-rangeHours(graphRange)));

  // Display-density helpers for the Users / Site Traffic SVGs. Every
  // data point always renders — only the bar width and the x-axis text
  // labels adapt with density. Label filtering is date-semantic so the
  // labels that DO show fall on natural cadence points (Mondays for
  // the month view, first-of-month for the year view), not arbitrary
  // index strides that drift relative to wall-clock weeks/months.
  function chartBarWidth(n: number): number {
    // Bar width = 60% of the per-point spacing, capped at 24px so the
    // week view doesn't look chunky and floored at 1px so year-view
    // bars stay visible as a thin histogram instead of vanishing.
    const spacing = 600 / Math.max(n, 1);
    return Math.max(1, Math.min(24, spacing * 0.6));
  }
  function chartShouldShowLabel(dateStr: string, range: TimeRange): boolean {
    if (range === "week") return true;                    // all 7 days
    const d = new Date(dateStr + "T00:00:00Z");
    if (range === "month") return d.getUTCDay() === 1;    // Mondays only
    if (range === "year") return dateStr.endsWith("-01"); // first of month only
    return false;
  }
  function chartShowPerPointDetails(n: number): boolean {
    // Per-point text (count above each bar, "+N" badges, total-line
    // dots) — hide these when there are too many to read without
    // overlap. The bars and dots themselves still render.
    return n <= 12;
  }
  function chartDateLabel(s: string, range: TimeRange): string {
    // s is "YYYY-MM-DD". Year-range labels read better as "MM/YY".
    if (range === "year") return s.slice(5, 7) + "/" + s.slice(2, 4);
    return s.slice(5);
  }

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
  let bdIssues = $state<BdIssue[]>([]);
  let userAnalytics = $state<UserAnalytics | null>(null);
  let budgetStatus = $state<BudgetStatus | null>(null);
  let siteTraffic = $state<SiteTraffic | null>(null);
  let nowTs = $state<number>(Date.now());

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let tickTimer: ReturnType<typeof setInterval> | null = null;

  async function loadAll() {
    const [idx, st, rm, hb, bd] = await Promise.all([
      fetchIndex().catch(() => null),
      fetchStatus().catch(() => null),
      fetchRoadmap().catch(() => null),
      fetchHeartbeat().catch(() => null),
      fetchBeadsIssues().catch(() => [] as BdIssue[]),
    ]);
    index = idx as TestIndex | null;
    status = st as TestRunStatus | null;
    roadmap = rm as TestingRoadmap | null;
    heartbeat = hb as SyncHeartbeat | null;
    bdIssues = bd;
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
  // for SSE-drop recovery.
  let sseUnsubs: Array<() => void> = [];
  const SSE_WATCHED = [".beads/issues.jsonl"];

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

  // ---- Epic rollup, sourced from bd (.beads/issues.jsonl) ----
  // Console only surfaces milestone-level rollup + per-milestone epic counts.
  // Per-epic detail lists live on /test/tickets/, not here.
  let bdEpics = $derived(epicsOnly(bdIssues));
  let openEpicCount = $derived(bdEpics.filter(isOpen).length);
  let closedEpicCount = $derived(bdEpics.filter(isClosed).length);

  function elapsedSinceIso(iso: string): string {
    const ms = Math.max(0, nowTs - Date.parse(iso));
    if (ms < 60_000) return `${Math.round(ms / 1000)}s`;
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m`;
    return `${(ms / 3_600_000).toFixed(1)}h`;
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

  interface MilestoneRollup {
    meta: MilestoneMeta;
    openCount: number;
    closedCount: number;
    totalCount: number;
    pctDone: number;
    scoped: boolean;
  }
  let milestoneRollups = $derived.by<MilestoneRollup[]>(() => {
    return milestonesOrdered().map((meta) => {
      const inMilestone = bdEpics.filter((e) => milestoneIdFromLabels(e.labels) === meta.id);
      const open = inMilestone.filter(isOpen).length;
      const closed = inMilestone.filter(isClosed).length;
      const total = open + closed;
      // Complete milestones (pre_alpha — predates bd) are scoped + 100% by
      // definition. Live milestones are scoped once at least one bd epic
      // carries their label.
      const scoped = meta.status === "complete" || total > 0;
      let pctDone: number;
      if (meta.status === "complete") pctDone = 100;
      else if (total > 0) pctDone = Math.round((closed / total) * 100);
      else pctDone = 0;
      return { meta, openCount: open, closedCount: closed, totalCount: total, pctDone, scoped };
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
    {#if index}
      <span class="commit" title={index.repo.commit}>@{index.repo.commit.slice(0, 7)}</span>
    {/if}
  </div>

  <!-- Milestone rollup. Source of truth: static milestone metadata
       (`src/lib/milestones.ts`) crossed with bd epic counts. Per-epic detail
       lists live on /test/tickets/, not here. -->
  <div class="ms-progress">
    {#each milestoneRollups as ms (ms.meta.id)}
      <div
        class="ms-card"
        class:ms-card-complete={ms.meta.status === "complete"}
        class:ms-card-current={ms.meta.status === "current"}
        class:ms-card-planned={ms.meta.status === "planned"}
        class:ms-card-unscoped={!ms.scoped}
      >
        <div class="ms-header">
          <span class="ms-name">{ms.meta.label}</span>
          {#if ms.meta.status === "complete"}
            <span class="ms-tag ms-tag-complete">Complete</span>
          {:else if ms.meta.status === "current"}
            <span class="ms-pct">{ms.pctDone}%</span>
          {:else}
            <span class="ms-tag ms-tag-planned">Planned</span>
          {/if}
        </div>
        {#if ms.meta.description}
          <p class="ms-description">{ms.meta.description}</p>
        {/if}
        {#if ms.scoped}
          <div class="ms-bar"><div class="ms-bar-fill" style="width: {ms.pctDone}%"></div></div>
          <div class="ms-detail">
            {#if ms.totalCount > 0}
              <span>{ms.closedCount}/{ms.totalCount} epics complete</span>
              {#if ms.openCount > 0}<span>{ms.openCount} on deck</span>{/if}
            {:else if ms.meta.status === "complete"}
              <span>Predates bd tracking</span>
            {/if}
            <a class="ms-link" href="/test/tickets/">tickets ↗</a>
          </div>
        {:else}
          <div class="ms-bar ms-bar-empty"><div class="ms-bar-fill ms-bar-fill-muted" style="width: 0%"></div></div>
          <div class="ms-detail ms-detail-muted">
            <span>Not scoped yet</span>
          </div>
        {/if}
      </div>
    {/each}
  </div>

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

    <!-- Epics -->
    <a href="/test/tickets/" class="card">
      <h3 class="card-title">Epics</h3>
      {#if bdIssues.length > 0}
        <div class="card-stat">{openEpicCount} <span class="stat-label">on deck</span></div>
        <div class="card-detail">
          {#if closedEpicCount > 0}
            <span style="color: #a7f3d0">{closedEpicCount} complete</span>
          {/if}
        </div>
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

  <!-- Shared time-range selector for the three historical charts below.
       Owner spec 2026-06-03: one dropdown controls Users / Site Traffic /
       Usage History together. Renders only when at least one of those
       graphs would be visible to the current viewer. -->
  {#if (viewerIsAdmin && (userAnalytics?.dailyHistory?.length || siteTraffic?.dailyRequests?.length)) || (viewerIsLegend && usageHistory?.hours?.length > 0)}
    <div class="graph-range-control">
      <label class="range-control-label">
        Time range
        <select bind:value={graphRange} class="range-select" aria-label="Time range for all graphs">
          <option value="week">Week</option>
          <option value="month">Month</option>
          <option value="year">Year</option>
        </select>
      </label>
    </div>
  {/if}

  <!-- Users graph (admin only). Time range from the shared selector. -->
  {#if viewerIsAdmin && userAnalytics?.dailyHistory?.length}
    {@const history = userAnalytics.dailyHistory.slice(-rangeDays(graphRange))}
    {@const maxNew = Math.max(...history.map(d => d.new), 1)}
    {@const minTotal = Math.min(...history.map(d => d.total))}
    {@const totalRange = Math.max(...history.map(d => d.total)) - minTotal || 1}
    <div class="users-chart-section">
      <h3 class="section-title">
        Users
        <span class="section-subtitle">{userAnalytics.totalRegistered} total · +{userAnalytics.newThisWeek} this week</span>
      </h3>
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
            {@const barW = chartBarWidth(history.length)}
            {@const barH = (d.new / maxNew) * 40}
            {@const showDetails = chartShowPerPointDetails(history.length)}
            {@const showLabel = chartShouldShowLabel(d.date, graphRange)}
            {#if showDetails}
              <circle cx={x} cy={y} r="3" fill="#60a5fa" />
              <text x={x} y={y - 8} fill="#60a5fa" font-size="10" text-anchor="middle">{d.total}</text>
            {/if}
            <rect x={x - barW / 2} y={140 - barH} width={barW} height={barH} fill="rgba(52, 211, 153, 0.4)" rx={barW > 4 ? 2 : 0} />
            {#if d.new > 0 && showDetails}
              <text x={x} y={140 - barH - 3} fill="#34d399" font-size="9" text-anchor="middle">+{d.new}</text>
            {/if}
            {#if showLabel}
              <text x={x} y={156} fill="#6b7280" font-size="9" text-anchor="middle">{chartDateLabel(d.date, graphRange)}</text>
            {/if}
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

  <!-- Site traffic graph (admin only). Time range from the shared selector. -->
  {#if viewerIsAdmin && siteTraffic?.dailyRequests?.length}
    {@const traffic = siteTraffic.dailyRequests.slice(-rangeDays(graphRange))}
    {@const maxReq = Math.max(...traffic.map(d => d.requests), 1)}
    <div class="users-chart-section">
      <h3 class="section-title">
        Site Traffic
        <span class="section-subtitle">{siteTraffic.totalRequests7d.toLocaleString()} requests (7 days)</span>
      </h3>
      <div class="users-chart">
        <svg viewBox="0 0 700 140" class="users-svg">
          {#each traffic as d, i}
            {@const x = 50 + i * (600 / (traffic.length - 1 || 1))}
            {@const barW = chartBarWidth(traffic.length)}
            {@const barH = (d.requests / maxReq) * 100}
            {@const showCount = chartShowPerPointDetails(traffic.length)}
            {@const showLabel = chartShouldShowLabel(d.date, graphRange)}
            <rect x={x - barW / 2} y={120 - barH} width={barW} height={barH} fill="rgba(96, 165, 250, 0.5)" rx={barW > 4 ? 3 : 0} />
            {#if showCount}
              <text x={x} y={120 - barH - 5} fill="#60a5fa" font-size="10" text-anchor="middle">{d.requests > 999 ? (d.requests / 1000).toFixed(1) + "k" : d.requests}</text>
            {/if}
            {#if showLabel}
              <text x={x} y={136} fill="#6b7280" font-size="9" text-anchor="middle">{chartDateLabel(d.date, graphRange)}</text>
            {/if}
          {/each}
        </svg>
      </div>
    </div>
  {/if}

  <!-- Fixture picker (Legend+ only) -->
  {#if viewerIsLegend}
    <FixturePicker />
  {/if}

  <!-- Historical usage chart (Legend only). "Current Week" Messages/
       Time-Elapsed block removed 2026-06-01 per owner spec — the same
       data is implicit in the Usage History chart, and the standalone
       bars were just clutter at the top of the section. -->
  {#if viewerIsLegend && usageHistory?.hours?.length > 0}
    <h3 class="section-title">
      Usage History
    </h3>
    <div class="history-chart">
      <!-- Series toggles. The standalone "Trend" dropdown was removed
           2026-06-01; the moving-average window now scales automatically
           with the selected time range (24h smoothing for a week of data,
           weekly for a month, monthly for a year). -->
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
      </div>

      <!-- One row per active series (small multiples). usageHours is a
           $derived in the script — sliced to the selected range; backend
           returns a rolling hourly window, so year may render with fewer
           bars than nominal until backend support widens. -->
      {#each SERIES.filter(s => activeSeries.has(s.key)) as s}
        {@const values = usageHours.map((h: any) => h[s.field] ?? 0)}
        {@const maxVal = Math.max(...values, 1)}
        <div class="series-row">
          <div class="series-label" style="color: {s.color}">
            {s.label}
            <span class="series-max">max {maxVal.toLocaleString()}/hr</span>
          </div>
          <div class="chart-bars">
            {#each usageHours as h, i}
              {@const prevWeek = i > 0 ? usageHours[i-1].weekStart : null}
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
  /* Range selector that sits inline in each section title. Subtle so it
     doesn't compete with the title text, hovers up slightly to align
     with the section-subtitle line height. */
  .range-select {
    margin-left: 0.6rem;
    background: #0d1117;
    color: #d1d5db;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 3px;
    padding: 0.18rem 0.4rem;
    font-family: inherit;
    font-size: 0.72rem;
    cursor: pointer;
    vertical-align: middle;
  }
  /* Shared range-control bar above the three historical charts. */
  .graph-range-control {
    display: flex;
    justify-content: flex-end;
    margin: 0.6rem 0 0.4rem;
  }
  .range-control-label {
    display: inline-flex;
    align-items: center;
    gap: 0.2rem;
    font-size: 0.72rem;
    color: #9ca3af;
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

  /* ===== Epic overview row ===== */
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
