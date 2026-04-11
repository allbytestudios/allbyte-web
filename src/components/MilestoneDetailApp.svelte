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
    color: #e5e7eb;
    font-family: "Courier New", monospace;
  }
  .loading,
  .error {
    text-align: center;
    padding: 3rem;
    color: #9ca3af;
  }
  .error h2 { color: #fca5a5; }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: #9ca3af;
    margin-bottom: 0.4rem;
  }
  .breadcrumb a { color: #a7f3d0; text-decoration: none; }
  .breadcrumb a:hover { text-decoration: underline; }
  .sep { color: #4b5563; }
  .crumb { color: #9ca3af; }
  .milestone-name {
    font-size: 1.5rem;
    color: #a7f3d0;
    margin: 0.3rem 0 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    padding: 0.5rem 0.8rem;
    background: #12161e;
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
  .mstatus-done { color: #a7f3d0; background: rgba(167, 243, 208, 0.15); }
  .mstatus-in_progress { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
  .mstatus-planned { color: #9ca3af; background: rgba(156, 163, 175, 0.1); }
  .mstatus-blocked { color: #fca5a5; background: rgba(248, 113, 113, 0.15); }
  .pct { color: #a7f3d0; font-weight: 700; }
  .hours, .hoursleft { color: #9ca3af; font-size: 0.8rem; }
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
    background: linear-gradient(90deg, #86efac, #a7f3d0);
    transition: width 0.3s ease-out;
  }
  .scope {
    color: #9ca3af;
    font-style: italic;
    font-size: 0.85rem;
    margin: 0.25rem 0 1rem;
  }
  .section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid rgba(167, 243, 208, 0.1);
  }
  .section h2 {
    font-size: 0.85rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.6rem;
  }
  .gate-prose {
    color: #d1d5db;
    font-size: 0.85rem;
    margin: 0.25rem 0 0.5rem;
    line-height: 1.5;
  }
  .gate-rollup {
    font-size: 0.78rem;
    color: #9ca3af;
    padding: 0.3rem 0.6rem;
    border-radius: 3px;
    background: rgba(255, 255, 255, 0.02);
  }
  .gate-rollup.gate-pass { color: #a7f3d0; border-left: 3px solid #a7f3d0; }
  .gate-rollup.gate-fail { color: #fca5a5; border-left: 3px solid #f87171; }
  .gate-rollup.gate-xfail { color: #fcd34d; border-left: 3px solid #fbbf24; }
  .gate-rollup.gate-missing { color: #fca5a5; border-left: 3px dashed #fca5a5; }
  .gate-rollup.gate-unknown { color: #9ca3af; border-left: 3px dashed #6b7280; }
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
  .gate-pass .gcb { color: #a7f3d0; }
  .gate-fail .gcb { color: #fca5a5; }
  .gate-xfail .gcb { color: #fcd34d; }
  .gate-missing .gcb { color: #fca5a5; }
  .gate-unknown .gcb { color: #6b7280; }
  .gate-list code {
    flex: 1;
    color: #d1d5db;
    background: rgba(255, 255, 255, 0.03);
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
  }
  .gstatus {
    font-size: 0.7rem;
    color: #9ca3af;
    text-transform: uppercase;
  }
  .empty { color: #6b7280; font-style: italic; font-size: 0.8rem; }

  .blocker-list { list-style: none; padding: 0; margin: 0; }
  .blocker-list li {
    padding: 0.5rem 0.7rem;
    background: rgba(248, 113, 113, 0.05);
    border-left: 3px solid rgba(248, 113, 113, 0.55);
    border-radius: 3px;
    margin-bottom: 0.4rem;
  }
  .blocker-list strong { color: #fca5a5; }
  .blocker-list .sub { color: #9ca3af; font-size: 0.72rem; margin-left: 0.6rem; }
  .sub-impact { color: #d1d5db; font-size: 0.78rem; margin-top: 0.2rem; }

  .part { margin-top: 1rem; }
  .part-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
    padding: 0.4rem 0;
    border-bottom: 1px solid rgba(167, 243, 208, 0.08);
  }
  .part-label {
    color: #a7f3d0;
    font-weight: 700;
    font-size: 0.9rem;
  }
  .part-stats { color: #9ca3af; font-size: 0.72rem; margin-left: auto; }

  table.scenes {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.78rem;
    margin-top: 0.3rem;
  }
  table.scenes th {
    color: #6b7280;
    font-weight: 400;
    text-align: left;
    padding: 0.35rem 0.45rem;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    border-bottom: 1px solid rgba(167, 243, 208, 0.1);
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
  .dot-pass { background: #a7f3d0; }
  .dot-fail { background: #f87171; }
  .dot-xfail { background: transparent; border: 1.5px solid #fbbf24; }
  .dot-unknown { background: transparent; border: 1.5px dashed rgba(255, 255, 255, 0.22); }
  .cell-name { max-width: 260px; }
  .scene-label { color: #e5e7eb; font-weight: 600; }
  .scene-path {
    color: #6b7280;
    font-size: 0.7rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .cell-size { color: #9ca3af; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.05em; }
  .cell-tests { color: #e5e7eb; white-space: nowrap; }
  .xfail-marker { color: #fbbf24; font-size: 0.7rem; margin-left: 0.3rem; }
  .cell-live { color: #a7f3d0; white-space: nowrap; }
  .cell-hours { color: #9ca3af; white-space: nowrap; }
  .cell-notes { color: #9ca3af; font-size: 0.75rem; max-width: 280px; }
  .blocker-note { color: #fca5a5; }
  .scene-row.status-blocked { background: rgba(248, 113, 113, 0.03); }
  .scene-row.status-done { background: rgba(167, 243, 208, 0.02); }
</style>
