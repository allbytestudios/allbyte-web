<script lang="ts">
  import type {
    TestingRoadmap,
    Milestone,
    Scene,
    MilestonePart,
    GateCheckResult,
    GateRollup,
  } from "../lib/testingRoadmap";
  import type { TestIndex, TestEntry } from "../lib/testIndex";
  import {
    milestoneGateRefs,
    checkGate,
    rollupGate,
    testsForScene,
    summarizeBlockers,
  } from "../lib/testingRoadmap";
  import { fetchRoadmap, fetchIndex } from "../lib/testDataSource";
  import { statusClass } from "../lib/testIndex";
  import { onMount } from "svelte";

  let roadmap = $state<TestingRoadmap | null>(null);
  let index = $state<TestIndex | null>(null);
  let error = $state<string | null>(null);
  let milestoneId = $state("");
  let cameFrom = $state<"home" | "test">("test");

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    milestoneId = params.get("id") ?? "";
    const from = params.get("from");
    cameFrom = from === "home" ? "home" : "test";
    if (!milestoneId) {
      error = "Missing ?id=<milestone-id> in URL.";
      return;
    }
    try {
      [roadmap, index] = await Promise.all([fetchRoadmap(), fetchIndex()]);
      if (!roadmap) {
        error = "test_roadmap.json is not available.";
      }
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
  });

  let backHref = $derived(cameFrom === "home" ? "/" : "/test/");
  let backLabel = $derived(cameFrom === "home" ? "Home" : "Test Suite");

  let milestone = $derived<Milestone | null>(
    roadmap?.milestones.find((m) => m.id === milestoneId) ?? null
  );

  let gateRefs = $derived(milestone ? milestoneGateRefs(milestone) : []);
  let gateResults = $derived(checkGate(gateRefs, index));
  let gateRollup: GateRollup = $derived(rollupGate(gateResults));

  // Blockers affecting this milestone's scenes
  let milestoneBlockers = $derived.by(() => {
    if (!roadmap || !milestone) return [];
    const allBlockers = summarizeBlockers(roadmap);
    const myScenes = new Set<string>();
    for (const p of milestone.parts) {
      for (const s of p.scenes) {
        myScenes.add(s.id);
      }
    }
    return allBlockers
      .map((b) => ({
        ...b,
        scenes: b.scenes.filter((s) => myScenes.has(s.id)),
      }))
      .filter((b) => b.scenes.length > 0);
  });

  function sceneDot(s: Scene): string {
    switch (s.status) {
      case "done":
        return "pass";
      case "partial":
      case "in_progress":
        return "xfail";
      case "blocked":
        return "fail";
      case "planned":
      default:
        return "unknown";
    }
  }

  function liveTestsForScene(s: Scene): TestEntry[] {
    return testsForScene(s, index);
  }

  function livePassingForScene(s: Scene): number {
    return liveTestsForScene(s).filter(
      (t) => statusClass(t.status) === "pass"
    ).length;
  }
</script>

<div class="detail">
  {#if error}
    <div class="error">
      <h2>Milestone not available</h2>
      <p>{error}</p>
      <p><a href={backHref}>← Back to {backLabel}</a></p>
    </div>
  {:else if !roadmap || !milestone}
    <div class="loading">Loading milestone…</div>
  {:else}
    <nav class="breadcrumb">
      <a href={backHref}>← {backLabel}</a>
      <span class="sep">/</span>
      <span class="crumb">Milestones</span>
      <span class="sep">/</span>
      <span class="crumb">{milestone.label}</span>
    </nav>
    <h1 class="milestone-name">{milestone.label}</h1>

    <div class="status-row">
      <span class="mstatus mstatus-{milestone.status}">{milestone.status.replace("_", " ")}</span>
      <span class="pct">{milestone.percent_complete}%</span>
      <span class="hours" title="actual / estimated">
        {milestone.actual_hours}h / {milestone.est_hours_total}h
      </span>
      <span class="hoursleft">
        {Math.max(0, milestone.est_hours_total - milestone.actual_hours)}h remaining
      </span>
    </div>

    <div class="progress-bar"><div class="fill" style="width: {milestone.percent_complete}%"></div></div>

    <p class="scope">{milestone.scope}</p>

    <section class="section">
      <h2>Release gate</h2>
      <p class="gate-prose">{milestone.release_gate}</p>
      {#if gateResults.length > 0}
        <div class="gate-rollup gate-{gateRollup}">
          Gate: <strong>{gateRollup}</strong> · {gateResults.length} test{gateResults.length === 1 ? "" : "s"} referenced
        </div>
        <ul class="gate-list">
          {#each gateResults as g (g.ref.name + (g.ref.file ?? ""))}
            <li class="gate-{g.status}">
              <span class="gcb" aria-hidden="true">
                {#if g.status === "pass"}✓
                {:else if g.status === "fail"}✗
                {:else if g.status === "xfail"}◉
                {:else if g.status === "missing"}—
                {:else}?
                {/if}
              </span>
              <code>
                {#if g.ref.file}{g.ref.file}::{/if}{g.ref.name}
              </code>
              <span class="gstatus">{g.status}</span>
            </li>
          {/each}
        </ul>
      {:else}
        <p class="empty">Narrative milestone — no test IDs referenced in the gate.</p>
      {/if}
    </section>

    {#if milestoneBlockers.length > 0}
      <section class="section">
        <h2>Blockers affecting this milestone</h2>
        <ul class="blocker-list">
          {#each milestoneBlockers as b (b.blocker.id)}
            <li>
              <strong>{b.blocker.label}</strong>
              <span class="sub">
                {b.scenes.length} scene{b.scenes.length === 1 ? "" : "s"} · {b.blocker.est_hours_to_unblock}h to unblock
              </span>
              <div class="sub-impact">{b.blocker.impact}</div>
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <section class="section">
      <h2>Parts</h2>
      {#each milestone.parts as part (part.id)}
        <div class="part">
          <div class="part-header">
            <span class="part-label">{part.label}</span>
            <span class="part-stats">
              {part.scenes_done} / {part.scenes_total} scenes done ·
              {part.tests_done ?? 0} / {part.tests_planned ?? 0} tests ·
              {part.actual_hours}h / {part.est_hours}h
            </span>
          </div>
          <table class="scenes">
            <thead>
              <tr>
                <th></th>
                <th>Scene</th>
                <th>Size</th>
                <th>Tests</th>
                <th>Live</th>
                <th>Hours</th>
                <th>Notes</th>
              </tr>
            </thead>
            <tbody>
              {#each part.scenes as scene (scene.id)}
                {@const dot = sceneDot(scene)}
                {@const liveCount = liveTestsForScene(scene).length}
                {@const livePass = livePassingForScene(scene)}
                <tr class="scene-row status-{scene.status}">
                  <td class="cell-dot">
                    <span class="dot dot-{dot}" title={scene.status}></span>
                  </td>
                  <td class="cell-name">
                    <div class="scene-label">{scene.label}</div>
                    <div class="scene-path" title={scene.path}>{scene.path}</div>
                  </td>
                  <td class="cell-size">{scene.size}</td>
                  <td class="cell-tests">
                    {scene.tests_done} / {scene.tests_planned}
                    {#if scene.tests_xfail}<span class="xfail-marker" title="{scene.tests_xfail} xfailed">+{scene.tests_xfail}⚠</span>{/if}
                  </td>
                  <td class="cell-live" title="Live test count from test_index.json cross-reference">
                    {#if liveCount > 0}
                      {livePass}/{liveCount}
                    {:else}
                      —
                    {/if}
                  </td>
                  <td class="cell-hours">{scene.est_hours}h</td>
                  <td class="cell-notes">
                    {#if scene.blocker}
                      <span class="blocker-note">⊘ {scene.blocker}</span>
                    {:else if scene.notes}
                      <span class="notes">{scene.notes}</span>
                    {/if}
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      {/each}
    </section>
  {/if}
</div>

<style>
  .detail {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1rem 1.25rem 3rem;
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  .loading,
  .error {
    text-align: center;
    padding: 3rem;
    color: var(--ink-soft);
  }
  .error h2 { color: var(--sem-danger); }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: var(--ink-soft);
    margin-bottom: 0.4rem;
  }
  .breadcrumb a { color: var(--crimson); text-decoration: none; }
  .breadcrumb a:hover { text-decoration: underline; }
  .sep { color: var(--ink-soft); }
  .crumb { color: var(--ink-soft); }
  .milestone-name {
    font-size: 1.5rem;
    color: var(--crimson);
    margin: 0.3rem 0 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    padding: 0.5rem 0.8rem;
    background: var(--panel);
    border-radius: 4px;
    font-size: 0.85rem;
    flex-wrap: wrap;
  }
  .mstatus {
    text-transform: uppercase;
    font-weight: 700;
    font-size: 0.7rem;
    letter-spacing: 0.1em;
    padding: 0.15rem 0.45rem;
    border-radius: 3px;
  }
  .mstatus-done { color: var(--crimson); background: var(--paperblend); }
  .mstatus-in_progress { color: var(--sem-warn); background: rgba(251, 191, 36, 0.12); }
  .mstatus-planned { color: var(--ink-soft); background: var(--paperblend); }
  .mstatus-blocked { color: var(--sem-danger); background: rgba(248, 113, 113, 0.15); }
  .pct { color: var(--crimson); font-weight: 700; }
  .hours, .hoursleft { color: var(--ink-soft); font-size: 0.8rem; }
  .hoursleft { margin-left: auto; }
  .progress-bar {
    height: 6px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    overflow: hidden;
    margin: 0.5rem 0;
  }
  .fill {
    height: 100%;
    background: linear-gradient(90deg, var(--sem-ok), var(--crimson));
    transition: width 0.3s ease-out;
  }
  .scope {
    color: var(--ink-soft);
    font-style: italic;
    font-size: 0.85rem;
    margin: 0.25rem 0 1rem;
  }
  .section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid var(--rule);
  }
  .section h2 {
    font-size: 0.85rem;
    color: var(--crimson);
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.6rem;
  }
  .gate-prose {
    color: var(--ink);
    font-size: 0.85rem;
    margin: 0.25rem 0 0.5rem;
    line-height: 1.5;
  }
  .gate-rollup {
    font-size: 0.78rem;
    color: var(--ink-soft);
    padding: 0.3rem 0.6rem;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.02);
  }
  .gate-rollup.gate-pass { color: var(--crimson); border-left: 3px solid var(--crimson); }
  .gate-rollup.gate-fail { color: var(--sem-danger); border-left: 3px solid var(--sem-danger); }
  .gate-rollup.gate-xfail { color: var(--sem-warn); border-left: 3px solid var(--sem-warn); }
  .gate-rollup.gate-missing { color: var(--sem-danger); border-left: 3px dashed var(--sem-danger); }
  .gate-rollup.gate-unknown { color: var(--ink-soft); border-left: 3px dashed var(--ink-soft); }
  .gate-rollup strong { text-transform: uppercase; letter-spacing: 0.08em; }
  .gate-list {
    list-style: none;
    padding: 0;
    margin: 0.5rem 0 0;
  }
  .gate-list li {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.25rem 0.4rem;
    font-size: 0.78rem;
  }
  .gcb {
    width: 1.2rem;
    text-align: center;
    font-weight: 700;
  }
  .gate-pass .gcb { color: var(--crimson); }
  .gate-fail .gcb { color: var(--sem-danger); }
  .gate-xfail .gcb { color: var(--sem-warn); }
  .gate-missing .gcb { color: var(--sem-danger); }
  .gate-unknown .gcb { color: var(--ink-soft); }
  .gate-list code {
    flex: 1;
    color: var(--ink);
    background: rgba(255, 255, 255, 0.03);
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
  }
  .gstatus {
    font-size: 0.7rem;
    color: var(--ink-soft);
    text-transform: uppercase;
  }
  .empty { color: var(--ink-soft); font-style: italic; font-size: 0.8rem; }

  .blocker-list { list-style: none; padding: 0; margin: 0; }
  .blocker-list li {
    padding: 0.5rem 0.7rem;
    background: rgba(248, 113, 113, 0.05);
    border-left: 3px solid rgba(248, 113, 113, 0.55);
    border-radius: 3px;
    margin-bottom: 0.4rem;
  }
  .blocker-list strong { color: var(--sem-danger); }
  .blocker-list .sub { color: var(--ink-soft); font-size: 0.72rem; margin-left: 0.6rem; }
  .sub-impact { color: var(--ink); font-size: 0.78rem; margin-top: 0.2rem; }

  .part { margin-top: 1rem; }
  .part-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid var(--rule);
  }
  .part-label {
    color: var(--crimson);
    font-weight: 700;
    font-size: 0.9rem;
  }
  .part-stats { color: var(--ink-soft); font-size: 0.72rem; margin-left: auto; }

  table.scenes {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
    margin-top: 0.3rem;
  }
  table.scenes th {
    color: var(--ink-soft);
    font-weight: 400;
    text-align: left;
    padding: 0.35rem 0.45rem;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-bottom: 1px solid var(--rule);
  }
  table.scenes td {
    padding: 0.4rem 0.45rem;
    border-bottom: 1px solid rgba(255, 255, 255, 0.02);
    vertical-align: top;
  }
  .cell-dot { width: 1.2rem; }
  .cell-dot .dot {
    display: inline-block;
    width: 10px;
    height: 10px;
    border-radius: 50%;
  }
  .dot-pass { background: var(--crimson); }
  .dot-fail { background: var(--sem-danger); }
  .dot-xfail { background: transparent; border: 1.5px solid var(--sem-warn); }
  .dot-unknown { background: transparent; border: 1.5px dashed rgba(255, 255, 255, 0.22); }
  .cell-name { max-width: 260px; }
  .scene-label { color: var(--ink); font-weight: 600; }
  .scene-path {
    color: var(--ink-soft);
    font-size: 0.7rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell-size { color: var(--ink-soft); text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.05em; }
  .cell-tests { color: var(--ink); white-space: nowrap; }
  .xfail-marker { color: var(--sem-warn); font-size: 0.7rem; margin-left: 0.3rem; }
  .cell-live { color: var(--crimson); white-space: nowrap; }
  .cell-hours { color: var(--ink-soft); white-space: nowrap; }
  .cell-notes { color: var(--ink-soft); font-size: 0.75rem; max-width: 280px; }
  .blocker-note { color: var(--sem-danger); }
  .scene-row.status-blocked { background: rgba(248, 113, 113, 0.03); }
  .scene-row.status-done { background: var(--paperblend); }
</style>
