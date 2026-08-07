<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount } from "svelte";
  import {
    fetchTraffic, SECTION_COLOR, SECTION_LABEL, type Traffic,
  } from "../lib/traffic";

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<Traffic | null>(null);

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
      data = await fetchTraffic(auth.authToken ?? "");
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  let maxPage = $derived(
    data ? Math.max(1, ...data.top_pages.map((p) => p[1])) : 1
  );
  let totalSectionPv = $derived(
    data ? data.section_totals.reduce((s, [, v]) => s + v, 0) : 0
  );
  function pageLabel(p: string): string {
    return p === "/" ? "/ (home)" : p;
  }
  function when(ts: number): string {
    return new Date(ts * 1000).toLocaleString();
  }
</script>

<div class="traffic">
  {#if loading}
    <p class="muted">Loading traffic…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to view site traffic.</p>
  {:else if error}
    <p class="err">Couldn’t load traffic: {error}</p>
    <button class="btn" onclick={load}>Retry</button>
  {:else if !data}
    <p class="muted">No aggregate yet — the daily job writes it from the CDN logs. Check back after the next run.</p>
    <button class="btn" onclick={load}>Refresh</button>
  {:else}
    <div class="head">
      <span class="muted">
        {data.meta.date_range[0]} → {data.meta.date_range[1]} ·
        bot &amp; crawler traffic removed ({data.meta.bot_pct}% of page requests) ·
        updated {when(data.meta.generatedAt)}
      </span>
      <button class="btn" onclick={load}>Refresh</button>
    </div>

    <div class="cards">
      <div class="card accent">
        <div class="num">{data.meta.n_sessions.toLocaleString()}</div>
        <div class="lbl">Sessions <span class="sub">unique visits</span></div>
      </div>
      <div class="card">
        <div class="num">{data.meta.human_pageviews.toLocaleString()}</div>
        <div class="lbl">Page views <span class="sub">humans only</span></div>
      </div>
      <div class="card">
        <div class="num">{data.meta.avg_pages}</div>
        <div class="lbl">Pages / session <span class="sub">bounce-leaning</span></div>
      </div>
      <div class="card">
        <div class="num">{data.meta.mobile_pct}<span class="pctsign">%</span></div>
        <div class="lbl">Mobile <span class="sub">{data.meta.desktop_pct}% desktop</span></div>
      </div>
    </div>

    <!-- Top pages -->
    <section>
      <h3>Pages hit most <span class="sub">(human page views · <code>/test/</code> is this console, not public)</span></h3>
      <div class="bars">
        {#each data.top_pages as [path, cnt, sec] (path)}
          <div class="bar-row">
            <span class="bar-label" title={path}>{pageLabel(path)}</span>
            <div class="bar">
              <div class="fill" style="width:{(cnt / maxPage) * 100}%;background:{SECTION_COLOR[sec] ?? 'var(--ink-soft)'}"></div>
            </div>
            <span class="bar-n">{cnt}</span>
          </div>
        {/each}
      </div>
      <div class="legend">
        {#each data.section_totals as [sec, v] (sec)}
          <span class="lg">
            <i style="background:{SECTION_COLOR[sec] ?? 'var(--ink-soft)'}"></i>
            {SECTION_LABEL[sec] ?? sec} <b>{v}</b>
            <span class="lgp">{totalSectionPv ? Math.round((v / totalSectionPv) * 100) : 0}%</span>
          </span>
        {/each}
      </div>
    </section>

    <!-- User-flow Sankey -->
    <section>
      <h3>How they move through the site</h3>
      <p class="cap">
        Each ribbon is sessions flowing <b>entry source → the page they landed on → where they went next</b>.
        Thin grey ribbons left after one page (most of them); coloured ribbons went deeper. Hover a ribbon for its count.
      </p>
      <div class="sankey-wrap">
        <svg viewBox={data.sankey.viewBox} width="100%" preserveAspectRatio="xMidYMid meet"
          role="img" aria-label="User flow from entry source to landing page to next page or exit">
          <g>
            {#each data.sankey.ribbons as r, i (i)}
              <path class="rib" d={r.d} fill={r.color} fill-opacity={r.op}><title>{r.tip}</title></path>
            {/each}
          </g>
          <g>
            {#each data.sankey.nodes as n, i (i)}
              <rect x={n.x} y={n.y} width={n.w} height={n.h} rx="2" fill={n.color}>
                <title>{n.label} — {n.val} sessions</title>
              </rect>
            {/each}
          </g>
          <g>
            {#each data.sankey.labels as l, i (i)}
              <text x={l.x} y={l.y} text-anchor={l.anchor} class={l.cls}>{l.text}{#if l.pct}<tspan class="nlp"> {l.pct}</tspan>{/if}</text>
            {/each}
          </g>
          {#each data.sankey.colheads as c, i (i)}
            <text x={c.x} y={data.sankey.h - 8} text-anchor={c.anchor} class="colhead">{c.text}</text>
          {/each}
        </svg>
      </div>
    </section>

    <!-- Acquisition -->
    <section>
      <h3>Where they came from</h3>
      <p class="cap">
        Most sessions report no referrer (browsers &amp; in-app links strip it), so “Direct” is inflated and named
        referrers <b>under-count</b> real reach — treat the list as a floor.
      </p>
      <div class="cols2">
        <table>
          <thead><tr><th>Entry source</th><th class="tnum">Sessions</th></tr></thead>
          <tbody>
            {#each data.entry_sources as [s, c] (s)}
              <tr><td>{s}</td><td class="tnum">{c}</td></tr>
            {/each}
          </tbody>
        </table>
        <table>
          <thead><tr><th>External referrer</th><th class="tnum">Hits</th></tr></thead>
          <tbody>
            {#each data.ext_referrers as [h, c] (h)}
              <tr><td>{h}</td><td class="tnum">{c}</td></tr>
            {/each}
          </tbody>
        </table>
      </div>
    </section>

    <p class="foot muted">
      Source: CloudFront access logs, rolling 14 days ({data.meta.n_files.toLocaleString()} files). Pages only
      (trailing-slash GET, 200/304); assets, packs and the game WASM excluded. Sessions = client IP + user-agent
      within a 30-min gap. Caveat: <code>/play/</code> counts include some automated boot-smoke / QA hits.
    </p>
  {/if}
</div>

<style>
  .traffic {
    background: var(--panel);
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    padding: 1.25rem;
    max-width: 1120px;
    margin: 0 auto;
  }
  .muted { color: var(--ink-soft); }
  .err { color: var(--sem-danger); }
  .sub { color: var(--ink-soft); font-weight: normal; font-size: 0.78rem; }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .btn {
    background: transparent; color: var(--crimson); border: 1px solid var(--rule);
    border-radius: 4px; padding: 0.3rem 0.7rem; font-family: inherit; cursor: pointer; white-space: nowrap;
  }
  .btn:hover { background: var(--paperblend); }

  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
  .card { background: #131a26; border: 1px solid var(--rule); border-radius: 6px; padding: 0.9rem 1rem; }
  .num { font-size: 1.7rem; font-weight: 700; color: var(--ink); font-variant-numeric: tabular-nums; }
  .card.accent .num { color: var(--crimson); }
  .pctsign { font-size: 1rem; }
  .lbl { font-size: 0.82rem; margin-top: 0.2rem; }
  .lbl .sub { display: block; }

  section { margin-top: 1.9rem; }
  h3 { color: var(--crimson); font-size: 1rem; margin: 0 0 0.6rem; font-weight: 700; }
  .cap { color: var(--ink-soft); font-size: 0.82rem; margin: 0 0 0.9rem; max-width: 78ch; line-height: 1.5; }
  .cap b, .foot b { color: var(--ink-soft); }
  code { background: var(--paperblend); padding: 0 0.3rem; border-radius: 3px; }

  .bars { display: flex; flex-direction: column; gap: 0.4rem; }
  .bar-row { display: grid; grid-template-columns: 13rem 1fr 3rem; align-items: center; gap: 0.6rem; font-size: 0.8rem; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { background: var(--paperblend); border-radius: 3px; height: 15px; overflow: hidden; }
  .fill { height: 100%; border-radius: 3px; opacity: 0.9; }
  .bar-n { text-align: right; color: var(--ink-soft); font-variant-numeric: tabular-nums; }
  .legend { display: flex; flex-wrap: wrap; gap: 1rem; margin-top: 1rem; padding-top: 0.9rem; border-top: 1px solid var(--rule); font-size: 0.76rem; color: var(--ink-soft); }
  .lg { display: inline-flex; align-items: center; gap: 0.4rem; }
  .lg i { width: 10px; height: 10px; border-radius: 2px; display: inline-block; }
  .lg b { color: var(--ink); }
  .lgp { color: var(--ink-soft); }

  .sankey-wrap { background: #0c1420; border: 1px solid var(--rule); border-radius: 8px; padding: 0.75rem; overflow-x: auto; }
  .sankey-wrap svg { display: block; min-width: 640px; }
  .rib { transition: fill-opacity 0.12s; }
  .sankey-wrap:hover .rib { fill-opacity: 0.1; }
  .rib:hover { fill-opacity: 0.75 !important; }
  :global(.traffic .colhead) { fill: var(--ink-soft); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; }
  :global(.traffic .nl) { fill: var(--ink); font-size: 11.5px; paint-order: stroke; stroke: #0c1420; stroke-width: 3px; }
  :global(.traffic .nlm) { fill: #cfe6ff; }
  :global(.traffic .nlp) { fill: var(--ink-soft); font-size: 10px; }

  .cols2 { display: grid; grid-template-columns: 1fr 1fr; gap: 1.25rem; }
  table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
  th { text-align: left; color: var(--ink-soft); font-weight: 600; font-size: 0.72rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0 0 0.5rem; border-bottom: 1px solid var(--rule); }
  td { padding: 0.35rem 0; border-bottom: 1px solid rgba(255, 255, 255, 0.05); }
  td.tnum, th.tnum { text-align: right; color: var(--ink-soft); font-variant-numeric: tabular-nums; }

  .foot { font-size: 0.72rem; margin-top: 1.6rem; line-height: 1.6; max-width: 90ch; }

  @media (max-width: 720px) {
    .bar-row { grid-template-columns: 9rem 1fr 2.5rem; }
    .cols2 { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) { .rib { transition: none; } }
</style>
