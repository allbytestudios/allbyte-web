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
    movedSessions: number;
    bootedNoMove: number;
    sceneCounts: Record<string, number>;
    referrers: Record<string, number>;
    devices?: Record<string, number>;
    deviceEngagement?: Record<
      string,
      { sessions: number; booted: number; moved: number; past: number; medianDur: number }
    >;
    daily?: { date: string; sessions: number; booted: number; bots?: number }[];
    medianDurationSec: number;
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

  // Split sceneCounts into location scenes vs "m:" milestones.
  let locations = $derived(
    data
      ? Object.entries(data.sceneCounts)
          .filter(([k]) => !k.startsWith("m:"))
          .sort((a, b) => b[1] - a[1])
      : []
  );
  let milestones = $derived(
    data
      ? Object.entries(data.sceneCounts)
          .filter(([k]) => k.startsWith("m:"))
          .sort((a, b) => b[1] - a[1])
      : []
  );
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
  function dayLabel(iso: string): string {
    // "2026-07-01" → "Jul 1"
    const [y, m, d] = iso.split("-").map(Number);
    const mo = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"][m - 1] ?? "";
    return `${mo} ${d}`;
  }

  function milestoneLabel(k: string): string {
    if (k === "m:moved") return "First move";
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
      <span class="muted">Anonymous, aggregate. Updated {new Date(data.generatedAt * 1000).toLocaleString()}</span>
      <button class="btn" onclick={load}>Refresh</button>
    </div>

    <!-- Top-line funnel: arrived -> booted -> moved -->
    <div class="cards">
      <div class="card">
        <div class="num">{data.totalSessions}</div>
        <div class="lbl">Arrived <span class="sub">opened /play/</span></div>
      </div>
      <div class="card">
        <div class="num">{data.bootedSessions}</div>
        <div class="lbl">Booted <span class="sub">{pct(data.bootedSessions, data.totalSessions)}% of arrivals</span></div>
      </div>
      <div class="card">
        <div class="num">{fmtDuration(data.medianDurationSec)}</div>
        <div class="lbl">Median session</div>
      </div>
    </div>
    {#if data.botSessions}
      <p class="bot-note">
        🤖 {data.botSessions} datacenter bot session{data.botSessions === 1 ? "" : "s"} excluded
        <span class="sub">flagged server-side by cloud IP (AWS/Azure/GCP) — never counted above</span>
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
            <div class="day-col" title="{d.date}: {d.sessions} session{d.sessions === 1 ? '' : 's'}, {d.booted} booted{d.bots ? ` (+${d.bots} bot excluded)` : ''}">
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

      <!-- Milestones -->
      <section>
        <h3>Milestones <span class="sub">(distinct sessions)</span></h3>
        {#if milestones.length === 0}
          <p class="muted">No milestones yet.</p>
        {:else}
          {#each milestones as [k, n]}
            <div class="bar-row">
              <span class="bar-label">{milestoneLabel(k)}</span>
              <div class="bar"><div class="fill alt" style="width:{pct(n, data.totalSessions)}%"></div></div>
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
              <span class="bar-label">{host}</span>
              <div class="bar"><div class="fill ref" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
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
    background: #0a0e17;
    color: #e0e7ff;
    font-family: "Courier New", monospace;
    padding: 1.25rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .muted { color: rgba(224, 231, 255, 0.55); }
  .err { color: #f87171; }
  .sub { color: rgba(224, 231, 255, 0.45); font-weight: normal; font-size: 0.78rem; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .btn {
    background: transparent; color: #a7f3d0; border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 4px; padding: 0.3rem 0.7rem; font-family: inherit; cursor: pointer;
  }
  .btn:hover { background: rgba(167, 243, 208, 0.1); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
  .bot-note { margin: 0.5rem 0 0; font-size: 0.82rem; color: rgba(224, 231, 255, 0.6); }
  .bot-note .sub { display: block; margin-top: 0.1rem; }
  .card {
    background: #131a26; border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 6px; padding: 0.9rem 1rem;
  }
  .card.warn { border-color: rgba(248, 113, 113, 0.5); }
  .num { font-size: 1.7rem; font-weight: 700; color: #a7f3d0; }
  .card.warn .num { color: #f87171; }
  .lbl { font-size: 0.82rem; margin-top: 0.2rem; }
  .lbl .sub { display: block; }
  .signal {
    margin: 1rem 0 0; padding: 0.6rem 0.8rem; border-radius: 6px;
    background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.4);
    color: #fca5a5; font-size: 0.85rem;
  }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
  h3 { color: #a7f3d0; font-size: 1rem; margin: 0 0 0.6rem; font-weight: 700; }
  .bar-row { display: grid; grid-template-columns: 9rem 1fr 2.5rem; align-items: center; gap: 0.5rem; margin: 0.3rem 0; font-size: 0.8rem; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { background: rgba(167, 243, 208, 0.08); border-radius: 3px; height: 14px; overflow: hidden; }
  .fill { height: 100%; background: #a7f3d0; }
  .fill.alt { background: #fbbf24; }
  .fill.ref { background: #60a5fa; }
  .fill.dev { background: #c084fc; }
  .bar-n { text-align: right; color: rgba(224, 231, 255, 0.7); }
  code { background: rgba(167, 243, 208, 0.1); padding: 0 0.3rem; border-radius: 3px; }

  /* Sessions-per-day chart */
  .daily { margin-top: 1.5rem; }
  .daily-chart {
    display: flex;
    align-items: flex-end;
    gap: 0.35rem;
    height: 140px;
    overflow-x: auto;
    padding-bottom: 0.2rem;
  }
  .day-col {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: flex-end;
    gap: 0.25rem;
    min-width: 26px;
    height: 100%;
    flex: 1 1 26px;
  }
  .day-n { font-size: 0.68rem; color: rgba(224, 231, 255, 0.7); }
  .day-bar-track { flex: 1; width: 60%; display: flex; align-items: flex-end; }
  .day-bar {
    position: relative;
    width: 100%;
    background: rgba(167, 243, 208, 0.25);
    border-radius: 3px 3px 0 0;
    min-height: 3px;
  }
  .day-bar-booted {
    position: absolute;
    bottom: 0; left: 0;
    width: 100%;
    background: #a7f3d0;
    border-radius: 0 0 3px 3px;
  }
  .day-lbl {
    font-size: 0.62rem;
    color: rgba(224, 231, 255, 0.5);
    white-space: nowrap;
    transform: rotate(-45deg);
    transform-origin: center;
    margin-top: 0.2rem;
    height: 1.2em;
  }

  /* Engagement-by-device graph */
  .device-engagement { margin-top: 1.5rem; }
  .de-legend { display: flex; gap: 1.1rem; font-size: 0.72rem; color: rgba(224, 231, 255, 0.6); margin-bottom: 0.55rem; }
  .de-legend i.sw { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 0.3rem; vertical-align: middle; }
  .de-legend i.all { background: rgba(192, 132, 252, 0.22); }
  .de-legend i.boot { background: #8b5cf6; }
  .de-legend i.past { background: #a7f3d0; }
  .de-row { display: grid; grid-template-columns: 10rem 1fr 13rem; align-items: center; gap: 0.5rem; margin: 0.35rem 0; font-size: 0.8rem; }
  .de-row.flag .bar-label { color: #fca5a5; }
  .de-track { background: rgba(255, 255, 255, 0.04); border-radius: 3px; height: 16px; }
  .de-bar { position: relative; height: 100%; background: rgba(192, 132, 252, 0.22); border-radius: 3px; min-width: 2px; }
  .de-seg { position: absolute; left: 0; top: 0; height: 100%; border-radius: 3px; }
  .de-seg.boot { background: #8b5cf6; }
  .de-seg.past { background: #a7f3d0; }
  .de-stat { text-align: right; color: rgba(224, 231, 255, 0.75); font-size: 0.74rem; }
  .de-sub { color: rgba(224, 231, 255, 0.5); }
  .de-note { font-size: 0.72rem; margin-top: 0.6rem; line-height: 1.5; }
</style>
