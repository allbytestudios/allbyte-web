<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount } from "svelte";

  // ReadEndpoint output of the play-analytics stack (allbyte-studio-play-analytics,
  // us-east-1). Admin-gated server-side: verifies the JWT email claim.
  const READ_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/funnel";

  interface Funnel {
    totalSessions: number;
    bootedSessions: number;
    /** Reached a real gameplay location beyond Title/loader — "actually played". */
    pastTitleSessions?: number;
    /** Sessions whose referrer was NOT another allbyte.studio page. */
    inboundSessions?: number;
    movedSessions: number;
    bootedNoMove: number;
    /** Trailing-30-day cut of the same funnel. */
    window30?: {
      sessions: number;
      booted: number;
      past: number;
      inbound: number;
      medianDurationSec: number;
    };
    /** Unix seconds: first/last session in the retained window. */
    rangeStart?: number;
    rangeEnd?: number;
    retentionDays?: number;
    /** Known automation (CI Deploy QA / Playwright), excluded from every metric. */
    automationSessions?: number;
    /** §6.1 startup sequence, canonical order — drives the startup funnel. */
    startupSeq?: string[];
    startupCounts?: Record<string, number>;
    /** Median ms since navigation start, per startup event (§6.2). */
    startupMedianMs?: Record<string, number>;
    /** §6.3 verdict → session count. */
    startupClasses?: Record<string, number>;
    /** Sessions carrying startup marks; sessions predating §6 have none. */
    startupInstrumented?: number;
    /** §7 launch_context bucket → session count. */
    launchContexts?: Record<string, number>;
    sceneCounts: Record<string, number>;
    referrers: Record<string, number>;
    devices?: Record<string, number>;
    deviceEngagement?: Record<
      string,
      { sessions: number; booted: number; moved: number; past: number; medianDur: number }
    >;
    daily?: { date: string; sessions: number; booted: number; past?: number; bots?: number }[];
    medianDurationSec: number;
    /** Median duration among sessions that got past the title screen. */
    medianPlayedDurationSec?: number;
    /** Datacenter/cloud bot sessions, flagged server-side by source IP and
     *  excluded from every metric above. Surfaced so the count is visible. */
    botSessions?: number;
    generatedAt: number;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<Funnel | null>(null);

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    if (!isAdmin(auth.currentUser)) {
      loading = false;
      return;
    }
    await load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch(READ_URL, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${auth.authToken}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      data = (await res.json()) as Funnel;
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  function pct(a: number, b: number): number {
    return b > 0 ? Math.round((a / b) * 100) : 0;
  }

  function fmtDuration(s: number): string {
    if (!s) return "—";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  // Split sceneCounts into location scenes vs the two namespaced funnels:
  // "m:" progression milestones and "s:" §6.1 startup events. Both must be
  // excluded here or they'd render as places the player visited.
  let locations = $derived(
    data
      ? Object.entries(data.sceneCounts)
          .filter(([k]) => !k.startsWith("m:") && !k.startsWith("s:"))
          .sort((a, b) => b[1] - a[1])
      : []
  );

  // §6.1 startup funnel, in canonical order, with step-over-step retention.
  // Only events any session actually reached are shown, so the panel stays
  // short before the game-side marks (continue_confirmed) land.
  let startupFunnel = $derived.by(() => {
    if (!data?.startupSeq || !data.startupCounts) return [];
    const entry = data.startupCounts["play_page_open"] || data.startupInstrumented || 0;
    let prior = 0;
    return data.startupSeq
      .map((k) => ({ key: k, n: data!.startupCounts![k] || 0, ms: data!.startupMedianMs?.[k] }))
      .filter((r) => r.n > 0)
      .map((r, i) => {
        const row = {
          ...r,
          label: STARTUP_LABEL[r.key] ?? r.key,
          ofEntry: pct(r.n, entry),
          ofPrior: i === 0 ? 100 : pct(r.n, prior),
          first: i === 0,
        };
        prior = r.n;
        return row;
      });
  });

  const STARTUP_LABEL: Record<string, string> = {
    play_page_open: "Opened /play/",
    boot_shell_visible: "Boot shell painted",
    game_download_start: "Download started",
    game_download_complete: "Download complete",
    engine_init_start: "Engine bring-up began",
    engine_init_complete: "Engine running",
    title_rendered: "Title rendered",
    title_interactive: "Title interactive",
    first_input: "First input",
    new_game_confirmed: "Pressed New Game",
    continue_confirmed: "Chose Continue",
    first_world_scene_ready: "World scene ready",
    first_player_move: "First move",
  };

  // §6.3 verdicts. Ordered worst-to-best so the top row is the biggest problem;
  // the wording says what to go fix, not just which mark was missing.
  const CLASS_LABEL: Record<string, string> = {
    never_reached_boot_shell: "Never saw the boot shell — page/script failure",
    boot_shell_no_download: "Shell, then no download — network or abandonment",
    download_no_engine_init: "Downloaded but engine never started — WASM/runtime",
    engine_init_no_title_interactive: "Engine ran, title never became usable",
    title_interactive_no_input: "Title was usable, never touched — voluntary bounce",
    input_no_start: "Tapped but never started — menu/controls unclear",
    started_no_world_ready: "Started, world never loaded — scene failure",
    world_ready_no_movement: "In the world, never moved — onboarding",
    completed_to_movement: "Reached movement",
  };
  const CLASS_ORDER = [
    "never_reached_boot_shell",
    "boot_shell_no_download",
    "download_no_engine_init",
    "engine_init_no_title_interactive",
    "input_no_start",
    "started_no_world_ready",
    "world_ready_no_movement",
    "title_interactive_no_input",
    "completed_to_movement",
  ];
  let startupClasses = $derived.by(() => {
    if (!data?.startupClasses) return [];
    const tot = Object.values(data.startupClasses).reduce((a, b) => a + b, 0);
    return CLASS_ORDER.filter((k) => data!.startupClasses![k])
      .map((k) => ({
        key: k,
        label: CLASS_LABEL[k] ?? k,
        n: data!.startupClasses![k],
        pct: pct(data!.startupClasses![k], tot),
        good: k === "completed_to_movement",
        bounce: k === "title_interactive_no_input",
      }));
  });
  // Milestone progression funnel: milestones in PLAY ORDER (not by count), with
  // step-over-step drop-off, so you see how far players get and where they fall off.
  const MILESTONE_SEQ = ["m:newgame", "m:moved", "m:dialogue", "m:combat"];
  let milestoneFunnel = $derived.by(() => {
    if (!data) return [];
    const counts = new Map(
      Object.entries(data.sceneCounts).filter(([k]) => k.startsWith("m:"))
    );
    // story events after the known sequence, in numeric order (event_1, event_2, …)
    const eventNum = (k: string) => {
      const n = parseInt(k.slice("m:event_".length), 10);
      return Number.isNaN(n) ? Number.MAX_SAFE_INTEGER : n;
    };
    const events = [...counts.keys()]
      .filter((k) => k.startsWith("m:event_"))
      .sort((a, b) => eventNum(a) - eventNum(b));
    const seq = [...MILESTONE_SEQ, ...events];
    const others = [...counts.keys()].filter((k) => !seq.includes(k));
    const order = [...seq, ...others].filter((k) => counts.has(k));
    const entry = order.length ? counts.get(order[0]) ?? 0 : 0;
    let prev = entry;
    return order.map((k, i) => {
      const n = counts.get(k) ?? 0;
      const ofEntry = entry > 0 ? Math.round((n / entry) * 100) : 0;
      const ofPrior = i === 0 ? 100 : prev > 0 ? Math.round((n / prev) * 100) : 0;
      const row = { key: k, label: milestoneLabel(k), n, ofEntry, ofPrior, first: i === 0 };
      prev = n;
      return row;
    });
  });
  // Biggest single drop-off (lowest kept-% among non-first steps) — the row to fix.
  let worstDropKey = $derived.by(() => {
    const steps = milestoneFunnel.filter((r) => !r.first);
    if (!steps.length) return null;
    return steps.reduce((w, r) => (r.ofPrior < w.ofPrior ? r : w)).key;
  });
  let referrers = $derived(
    data ? Object.entries(data.referrers).sort((a, b) => b[1] - a[1]) : []
  );
  let devices = $derived(
    data?.devices ? Object.entries(data.devices).sort((a, b) => b[1] - a[1]) : []
  );
  // Engagement by device: per class, sessions → booted → past-Title, sorted by
  // volume. Surfaces abnormal engagement (a class with sessions but ~0% boot =
  // bots; low boot on one browser = a load problem on that platform).
  let deviceEngagement = $derived(
    data?.deviceEngagement
      ? Object.entries(data.deviceEngagement).sort((a, b) => b[1].sessions - a[1].sessions)
      : []
  );
  let maxDeviceSessions = $derived(
    deviceEngagement.reduce((m, [, e]) => Math.max(m, e.sessions), 0)
  );

  // Temporal: play sessions per day (UTC). Session-scoped + anonymous, so this
  // is sessions/day, not unique returning players — the "when did traffic come"
  // signal to line up against marketing drops.
  let daily = $derived(data?.daily ?? []);
  let maxDaily = $derived(daily.reduce((m, d) => Math.max(m, d.sessions), 0));

  // Reporting period. The table is TTL-bounded, so these are NOT lifetime
  // totals — stating the window stops the numbers being read as all-time.
  function shortDate(unix: number): string {
    return new Date(unix * 1000).toLocaleDateString(undefined, {
      month: "short",
      day: "numeric",
      year: "numeric",
    });
  }
  let periodLabel = $derived(
    data?.rangeStart && data?.rangeEnd
      ? `${shortDate(data.rangeStart)} – ${shortDate(data.rangeEnd)}`
      : "all retained data"
  );
  function dayLabel(iso: string): string {
    // "2026-07-01" → "Jul 1"
    const [y, m, d] = iso.split("-").map(Number);
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1] ?? "";
    return `${mo} ${d}`;
  }

  function milestoneLabel(k: string): string {
    if (k === "m:newgame") return "Pressed New Game";
    if (k === "m:moved") return "First move";
    if (k === "m:dialogue") return "Talked to someone";
    if (k === "m:combat") return "Reached combat";
    if (k.startsWith("m:event_")) return `Story event ${k.slice("m:event_".length)}`;
    return k.slice(2);
  }

</script>

<div class="funnel">
  {#if loading}
    <p class="muted">Loading funnel…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to view play analytics.</p>
  {:else if error}
    <p class="err">Couldn’t load funnel: {error}</p>
    <button class="btn" onclick={load}>Retry</button>
  {:else if !data || data.totalSessions === 0}
    <p class="muted">No play sessions recorded yet. Data appears here as people open <code>/play/</code>.</p>
    <button class="btn" onclick={load}>Refresh</button>
  {:else}
    <div class="head">
      <span class="muted">
        Play sessions · {periodLabel}
        <span class="sub">
          anonymous &amp; aggregate · sessions, not unique people (a returning player counts again) ·
          rolling {data.retentionDays ?? 90}-day window · updated {new Date(data.generatedAt * 1000).toLocaleString()}
        </span>
      </span>
      <button class="btn" onclick={load}>Refresh</button>
    </div>

    <!-- Top-line funnel: arrived -> booted -> actually played -->
    <div class="cards">
      <div class="card">
        <div class="num">{data.totalSessions}</div>
        <div class="lbl">Arrived <span class="sub">opened /play/</span></div>
      </div>
      <div class="card">
        <div class="num">{data.bootedSessions}</div>
        <div class="lbl">Booted <span class="sub">{pct(data.bootedSessions, data.totalSessions)}% of arrivals — the game ran</span></div>
      </div>
      {#if data.pastTitleSessions != null}
        <div class="card">
          <div class="num">{data.pastTitleSessions}</div>
          <div class="lbl">
            Played <span class="sub">{pct(data.pastTitleSessions, data.totalSessions)}% of arrivals — got past the title screen</span>
          </div>
        </div>
      {/if}
      <div class="card">
        <div class="num">{fmtDuration(data.medianPlayedDurationSec ?? data.medianDurationSec)}</div>
        <div class="lbl">
          Median play
          <span class="sub">
            {#if data.medianPlayedDurationSec != null}
              among sessions that got past the title ({fmtDuration(data.medianDurationSec)} across all arrivals)
            {/if}
          </span>
        </div>
      </div>
    </div>

    {#if data.window30 && data.window30.sessions !== data.totalSessions}
      <p class="window-note">
        Last 30 days: <strong>{data.window30.sessions}</strong> arrived ·
        <strong>{data.window30.booted}</strong> booted ·
        <strong>{data.window30.past}</strong> played ·
        median {fmtDuration(data.window30.medianDurationSec)}
      </p>
    {/if}

    {#if data.automationSessions || data.botSessions}
      <p class="bot-note">
        🤖 excluded from every number above:
        {#if data.automationSessions}{data.automationSessions} automation session{data.automationSessions === 1 ? "" : "s"}{/if}{#if data.automationSessions && data.botSessions} · {/if}{#if data.botSessions}{data.botSessions} datacenter bot session{data.botSessions === 1 ? "" : "s"}{/if}
        <span class="sub">
          CI Deploy QA / Playwright harnesses (they boot /play/ on prod after every deploy) plus
          anything arriving from a cloud IP — never counted as players
        </span>
      </p>
    {/if}

    <!-- Sessions per day — temporal signal for "when did players show up" -->
    <section class="daily">
      <h3>Sessions per day <span class="sub">(UTC · dark = booted · anonymous, so sessions not unique players)</span></h3>
      {#if daily.length === 0}
        <p class="muted">No dated sessions yet — appears as new play sessions come in.</p>
      {:else}
        <div class="daily-chart">
          {#each daily as d (d.date)}
            <div class="day-col" title="{d.date}: {d.sessions} arrived, {d.booted} booted{d.past != null ? `, ${d.past} played` : ''}{d.bots ? ` (+${d.bots} automation/bot excluded)` : ''}">
              <span class="day-n">{d.sessions}</span>
              <div class="day-bar-track">
                <div class="day-bar" style="height:{maxDaily ? Math.max(3, Math.round((d.sessions / maxDaily) * 100)) : 0}%">
                  <div class="day-bar-booted" style="height:{d.sessions ? Math.round((d.booted / d.sessions) * 100) : 0}%"></div>
                </div>
              </div>
              <span class="day-lbl">{dayLabel(d.date)}</span>
            </div>
          {/each}
        </div>
      {/if}
    </section>

    <!-- Milestone progression — how far players get once they start, and where they drop -->
    <section class="milestone-funnel startup-funnel">
      <h3>
        Startup sequence
        <span class="sub">(§6.1 · bar = share of /play/ opens · median = ms from navigation start)</span>
      </h3>
      {#if startupFunnel.length === 0}
        <p class="muted">
          No startup marks yet — sessions recorded before this instrumentation shipped carry none.
          New sessions populate this within minutes of a visit.
        </p>
      {:else}
        {#each startupFunnel as r (r.key)}
          <div class="mf-row">
            <span class="mf-label" title={r.key}>{r.label}</span>
            <div class="mf-track"><div class="mf-bar" style="width:{Math.max(2, r.ofEntry)}%"></div></div>
            <span class="mf-stat">
              {r.n}
              {#if r.ms != null}<span class="mf-kept">· {r.ms < 1000 ? `${r.ms}ms` : `${(r.ms / 1000).toFixed(1)}s`}</span>{/if}
            </span>
          </div>
        {/each}
      {/if}

      {#if startupClasses.length > 0}
        <h3 class="sc-head">
          Where sessions ended
          <span class="sub">(§6.3 · {data.startupInstrumented} instrumented session{data.startupInstrumented === 1 ? "" : "s"})</span>
        </h3>
        {#each startupClasses as c (c.key)}
          <div class="mf-row">
            <span class="mf-label sc-label" class:good={c.good} class:bounce={c.bounce} title={c.key}>{c.label}</span>
            <div class="mf-track">
              <div class="mf-bar" class:good={c.good} class:bounce={c.bounce} style="width:{Math.max(2, c.pct)}%"></div>
            </div>
            <span class="mf-stat">{c.n} <span class="mf-kept">· {c.pct}%</span></span>
          </div>
        {/each}
        <p class="mf-note muted">
          Everything above “Reached movement” is a session that stopped early. The rows split the one
          number the old funnel couldn’t: a <em>technical</em> failure (no shell, no download, no engine,
          no usable title) versus a <em>voluntary</em> bounce — the title worked and nobody touched it.
        </p>
      {/if}
    </section>

    <section class="milestone-funnel">
      <h3>
        Milestone progression
        <span class="sub">(in play order · bar = share of the first step · % = kept from the previous step)</span>
      </h3>
      {#if milestoneFunnel.length === 0}
        <p class="muted">No milestones yet — appears as players progress through <code>/play/</code>.</p>
      {:else}
        {#each milestoneFunnel as m (m.key)}
          <div class="mf-row" class:worst={m.key === worstDropKey}>
            <span class="mf-label" title={m.label}>{m.label}</span>
            <div class="mf-track">
              <div class="mf-bar" style="width:{Math.max(2, m.ofEntry)}%"></div>
            </div>
            <span class="mf-stat">
              {m.n}
              {#if !m.first}<span class="mf-kept">· kept {m.ofPrior}%</span>{/if}
            </span>
          </div>
        {/each}
        <p class="mf-note muted">
          Bar length = share of everyone who reached the first step ({milestoneFunnel[0]?.label}). The
          “kept %” is how many of the previous step continued —
          <span class="worst-key">red</span> marks the biggest drop-off, where you’re losing the most players.
        </p>
      {/if}
    </section>

    <!-- "Moved"/"never moved" cards removed 2026-06-25: movedSessions is sampled
         from the transient gameState.isMoving at a 4s poll, so it under-counts
         badly (a player who walked 4 scenes still read as "never moved"). Scenes
         reached (below) is the trustworthy starting-engagement signal. -->

    <div class="cols">
      <!-- Location funnel -->
      <section>
        <h3>Scenes reached <span class="sub">(distinct sessions)</span></h3>
        {#if locations.length === 0}
          <p class="muted">No scenes reached yet.</p>
        {:else}
          {#each locations as [scene, n]}
            <div class="bar-row">
              <span class="bar-label">{scene}</span>
              <div class="bar"><div class="fill" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
        {/if}
      </section>

      <!-- Referrers -->
      <section>
        <h3>Where they came from</h3>
        {#if referrers.length === 0}
          <p class="muted">No referrer data.</p>
        {:else}
          {#each referrers as [host, n]}
            <div class="bar-row">
              <span class="bar-label">{host === "internal" ? "allbyte.studio" : host}</span>
              <div class="bar"><div class="fill ref" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
          <p class="ref-note muted">
            <strong>allbyte.studio</strong> = clicked through from another page on this site (the
            Home → Play now path) — real visitors, just not a new outside referral.
            <strong>direct</strong> = typed/bookmarked, or the referrer was stripped (common on
            mobile and from apps).
            {#if data.inboundSessions != null}
              {data.inboundSessions} of {data.totalSessions} arrived from outside this site.
            {/if}
          </p>
        {/if}
      </section>

      <!-- Devices (play sessions, coarse class from UA — no PII) -->
      <section>
        <h3>Devices <span class="sub">(distinct sessions)</span></h3>
        {#if devices.length === 0}
          <p class="muted">No device data yet — appears as new play sessions come in.</p>
        {:else}
          {#each devices as [d, n]}
            <div class="bar-row">
              <span class="bar-label">{d}</span>
              <div class="bar"><div class="fill dev" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
        {/if}
      </section>
    </div>

    <!-- Engagement by device — nested funnel bar per class. Bar length ∝
         sessions (comparable across classes); the medium fill = booted, the
         bright fill = past-Title. Abnormal engagement shows at a glance. -->
    <section class="device-engagement">
      <h3>Engagement by device <span class="sub">(bar ∝ sessions · booted · past&nbsp;Title)</span></h3>
      {#if deviceEngagement.length === 0}
        <p class="muted">No device engagement yet — appears as new play sessions come in.</p>
      {:else}
        <div class="de-legend">
          <span><i class="sw all"></i> sessions</span>
          <span><i class="sw boot"></i> booted</span>
          <span><i class="sw past"></i> past&nbsp;Title</span>
        </div>
        {#each deviceEngagement as [d, e]}
          {@const bootPct = e.sessions ? Math.round((e.booted / e.sessions) * 100) : 0}
          {@const pastPct = e.sessions ? Math.round((e.past / e.sessions) * 100) : 0}
          {@const lowBoot = e.sessions >= 5 && bootPct < 40}
          <div class="de-row" class:flag={lowBoot}>
            <span class="bar-label" title={d}>{lowBoot ? "⚠ " : ""}{d}</span>
            <div class="de-track">
              <div class="de-bar" style="width:{Math.max(2, Math.round((e.sessions / maxDeviceSessions) * 100))}%">
                <div class="de-seg boot" style="width:{bootPct}%"></div>
                <div class="de-seg past" style="width:{pastPct}%"></div>
              </div>
            </div>
            <span class="de-stat">{e.sessions}<span class="de-sub"> · {bootPct}% boot · {pastPct}% past</span></span>
          </div>
        {/each}
        <p class="de-note muted">
          Sessions but ~0% boot ⇒ likely bots/crawlers. Low boot on one browser ⇒ a load problem on
          that platform (e.g. Safari/WebKit). High past-Title ⇒ real engaged players.
        </p>
      {/if}
    </section>
  {/if}
</div>

<style>
  .funnel {
    background: var(--panel);
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    padding: 1.25rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .muted { color: var(--ink-soft); }
  .err { color: var(--sem-danger); }
  .sub { color: var(--ink-soft); font-weight: normal; font-size: 0.78rem; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .btn {
    background: transparent; color: var(--crimson); border: 1px solid var(--rule);
    border-radius: 4px; padding: 0.3rem 0.7rem; font-family: inherit; cursor: pointer;
  }
  .btn:hover { background: var(--paperblend); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
  .bot-note { margin: 0.5rem 0 0; font-size: 0.82rem; color: var(--ink-soft); }
  .bot-note .sub { display: block; margin-top: 0.1rem; }
  .window-note { margin: 0.75rem 0 0; font-size: 0.85rem; color: var(--ink-soft); }
  .window-note strong { color: var(--crimson); }
  .ref-note { font-size: 0.72rem; line-height: 1.5; margin-top: 0.6rem; }
  .head .sub { display: block; margin-top: 0.15rem; max-width: 46rem; line-height: 1.45; }
  .card {
    background: #131a26; border: 1px solid var(--rule);
    border-radius: 6px; padding: 0.9rem 1rem;
  }
  .card.warn { border-color: var(--sem-danger); }
  .num { font-size: 1.7rem; font-weight: 700; color: var(--crimson); }
  .card.warn .num { color: var(--sem-danger); }
  .lbl { font-size: 0.82rem; margin-top: 0.2rem; }
  .lbl .sub { display: block; }
  .signal {
    margin: 1rem 0 0; padding: 0.6rem 0.8rem; border-radius: 6px;
    background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.4);
    color: var(--sem-danger); font-size: 0.85rem;
  }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
  h3 { color: var(--crimson); font-size: 1rem; margin: 0 0 0.6rem; font-weight: 700; }
  .bar-row { display: grid; grid-template-columns: 9rem 1fr 2.5rem; align-items: center; gap: 0.5rem; margin: 0.3rem 0; font-size: 0.8rem; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { background: var(--paperblend); border-radius: 3px; height: 14px; overflow: hidden; }
  .fill { height: 100%; background: var(--crimson); }
  .fill.alt { background: var(--sem-warn); }
  .fill.ref { background: var(--sem-info); }
  .fill.dev { background: #c084fc; }
  .bar-n { text-align: right; color: var(--ink-soft); }
  code { background: var(--paperblend); padding: 0 0.3rem; border-radius: 3px; }

  /* Sessions-per-day chart */
  .daily { margin-top: 1.5rem; }
  .daily-chart {
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
    overflow-x: auto;
    overflow-y: hidden;          /* kill the phantom vertical scrollbar from overflow-x + fixed height */
    padding-bottom: 0.9rem;      /* room for the rotated day labels */
  }
  .day-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    min-width: 26px;
    flex: 1 1 26px;
  }
  .day-n { font-size: 0.68rem; color: var(--ink-soft); }
  /* Fixed bar-area height (was flex:1 tied to the container's fixed height) so the
     chart sizes to its content and never overflows vertically. */
  .day-bar-track { height: 110px; width: 60%; display: flex; align-items: flex-end; }
  .day-bar {
    position: relative;
    width: 100%;
    background: var(--paperblend);
    border-radius: 3px 3px 0 0;
    min-height: 3px;
  }
  .day-bar-booted {
    position: absolute;
    bottom: 0; left: 0;
    width: 100%;
    background: var(--crimson);
    border-radius: 0 0 3px 3px;
  }
  .day-lbl {
    font-size: 0.62rem;
    color: var(--ink-soft);
    white-space: nowrap;
    transform: rotate(-45deg);
    transform-origin: center;
    margin-top: 0.2rem;
    height: 1.2em;
  }

  /* Milestone progression funnel */
  .milestone-funnel { margin-top: 1.5rem; }
  .sc-head { margin-top: 1.4rem; }
  /* Verdict rows: the healthy outcome and the "worked, they left" outcome read
     differently from a technical failure, because they call for different work. */
  .sc-label.good { color: var(--engine-accent, #a7f3d0); }
  .sc-label.bounce { color: #fbbf24; }
  .mf-bar.good { background: var(--engine-accent, #a7f3d0); }
  .mf-bar.bounce { background: #fbbf24; }
  .mf-row {
    display: grid;
    grid-template-columns: 11rem 1fr 9rem;
    align-items: center;
    gap: 0.6rem;
    margin: 0.35rem 0;
    font-size: 0.82rem;
  }
  .mf-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mf-track { background: rgba(251, 191, 36, 0.08); border-radius: 3px; height: 16px; }
  .mf-bar {
    height: 100%;
    background: var(--sem-warn);
    border-radius: 3px;
    min-width: 2px;
    transition: width 0.3s ease;
  }
  .mf-stat { text-align: right; color: var(--ink-soft); font-size: 0.78rem; white-space: nowrap; }
  .mf-kept { color: var(--ink-soft); }
  .mf-row.worst .mf-bar { background: var(--sem-danger); }
  .mf-row.worst .mf-label { color: var(--sem-danger); }
  .mf-row.worst .mf-kept { color: var(--sem-danger); }
  .mf-note { font-size: 0.72rem; margin-top: 0.6rem; line-height: 1.5; }
  .mf-note .worst-key { color: var(--sem-danger); font-weight: 700; }

  /* Engagement-by-device graph */
  .device-engagement { margin-top: 1.5rem; }
  .de-legend { display: flex; gap: 1.1rem; font-size: 0.72rem; color: var(--ink-soft); margin-bottom: 0.55rem; }
  .de-legend i.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 0.3rem; vertical-align: middle; }
  .de-legend i.all { background: rgba(192, 132, 252, 0.22); }
  .de-legend i.boot { background: #8b5cf6; }
  .de-legend i.past { background: var(--crimson); }
  .de-row { display: grid; grid-template-columns: 10rem 1fr 13rem; align-items: center; gap: 0.5rem; margin: 0.35rem 0; font-size: 0.8rem; }
  .de-row.flag .bar-label { color: var(--sem-danger); }
  .de-track { background: rgba(255, 255, 255, 0.04); border-radius: 3px; height: 16px; }
  .de-bar { position: relative; height: 100%; background: rgba(192, 132, 252, 0.22); border-radius: 3px; min-width: 2px; }
  .de-seg { position: absolute; left: 0; top: 0; height: 100%; border-radius: 3px; }
  .de-seg.boot { background: #8b5cf6; }
  .de-seg.past { background: var(--crimson); }
  .de-stat { text-align: right; color: var(--ink-soft); font-size: 0.74rem; }
  .de-sub { color: var(--ink-soft); }
  .de-note { font-size: 0.72rem; margin-top: 0.6rem; line-height: 1.5; }
</style>
