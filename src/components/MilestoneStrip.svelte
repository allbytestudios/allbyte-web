<script lang="ts">
  import type { TestingRoadmap, Milestone, GateRollup } from "../lib/testingRoadmap";
  import type { TestIndex } from "../lib/testIndex";
  import { milestoneGateRefs, checkGate, rollupGate } from "../lib/testingRoadmap";

  interface Props {
    roadmap: TestingRoadmap | null;
    index: TestIndex | null;
  }

  let { roadmap, index }: Props = $props();

  function gateRollupFor(m: Milestone): GateRollup {
    const refs = milestoneGateRefs(m);
    const results = checkGate(refs, index);
    return rollupGate(results);
  }

  function href(m: Milestone): string {
    return `/test/milestones/view/?id=${m.id}&from=test`;
  }

  function hoursLabel(m: Milestone): string {
    if (m.est_hours_total === 0) return "—";
    return `${m.actual_hours}h / ${m.est_hours_total}h`;
  }

  function gateTooltip(m: Milestone, g: GateRollup): string {
    const refs = milestoneGateRefs(m);
    const refCount = refs.length;
    switch (g) {
      case "pass":
        return `Release gate: all ${refCount} referenced tests passing`;
      case "fail":
        return `Release gate: at least one referenced test is failing`;
      case "xfail":
        return `Release gate: passing where possible, with ${refCount} xfails documented`;
      case "missing":
        return `Release gate: referenced test(s) not yet in the index`;
      case "unknown":
        if (refCount === 0) {
          return `Release gate: narrative milestone (no test references to cross-check)`;
        }
        return `Release gate: referenced tests exist but have not been run yet`;
    }
  }

  function statusLabel(status: Milestone["status"]): string {
    switch (status) {
      case "done":
        return "DONE";
      case "in_progress":
        return "IN PROGRESS";
      case "planned":
        return "PLANNED";
      case "blocked":
        return "BLOCKED";
    }
  }
</script>

{#if roadmap}
  <div class="milestone-strip" role="list" aria-label="Release milestones">
    {#each roadmap.milestones as m (m.id)}
      {@const gate = gateRollupFor(m)}
      <a class="mcard status-{m.status}" role="listitem" href={href(m)} aria-label="{m.label}, {m.percent_complete}% complete">
        <div class="mcard-header">
          <span class="mstatus mstatus-{m.status}">{statusLabel(m.status)}</span>
          <span class="gate-dot gate-{gate}" title={gateTooltip(m, gate)} aria-label="Release gate status: {gate}"></span>
        </div>
        <div class="mlabel">{m.label}</div>
        <div class="mscope" title={m.scope}>{m.scope}</div>
        <div class="mprogress">
          <div class="mprogress-bar" aria-hidden="true">
            <div class="mprogress-fill" style="width: {m.percent_complete}%"></div>
          </div>
          <div class="mprogress-text">
            <span class="mpct">{m.percent_complete}%</span>
            <span class="mhours" title="actual hours / estimated hours">{hoursLabel(m)}</span>
          </div>
        </div>
      </a>
    {/each}
  </div>
{/if}

<style>
  .milestone-strip {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(280px, 100%), 1fr));
    gap: 0.75rem;
    margin-bottom: 0.75rem;
  }
  .mcard {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
    padding: 0.75rem 0.9rem;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 6px;
    text-decoration: none;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
    transition: border-color 0.15s, background 0.15s;
  }
  .mcard:hover {
    border-color: rgba(167, 243, 208, 0.45);
    background: #151a23;
  }
  .mcard.status-in_progress {
    border-color: rgba(167, 243, 208, 0.35);
    box-shadow: 0 0 10px rgba(167, 243, 208, 0.08);
  }
  .mcard.status-blocked {
    border-color: rgba(248, 113, 113, 0.4);
  }
  .mcard-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .mstatus {
    font-size: 0.7rem;
    font-weight: 700;
    letter-spacing: 0.1em;
    padding: 0.1rem 0.4rem;
    border-radius: 3px;
  }
  .mstatus-done { color: #a7f3d0; background: rgba(167, 243, 208, 0.12); }
  .mstatus-in_progress { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
  .mstatus-planned { color: #9ca3af; background: rgba(156, 163, 175, 0.1); }
  .mstatus-blocked { color: #fca5a5; background: rgba(248, 113, 113, 0.12); }
  .gate-dot {
    margin-left: auto;
    width: 11px;
    height: 11px;
    border-radius: 50%;
    display: inline-block;
    cursor: help;
  }
  .gate-pass { background: #a7f3d0; box-shadow: 0 0 4px rgba(167, 243, 208, 0.5); }
  .gate-fail { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.6); }
  .gate-xfail { background: transparent; border: 2px solid #fbbf24; }
  .gate-missing { background: transparent; border: 2px dashed rgba(252, 165, 165, 0.5); }
  .gate-unknown { background: transparent; border: 2px dashed rgba(156, 163, 175, 0.4); }
  .mlabel {
    font-size: 1rem;
    font-weight: 700;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .mscope {
    font-size: 0.72rem;
    color: #9ca3af;
    line-height: 1.3;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .mprogress {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 0.2rem;
  }
  .mprogress-bar {
    height: 5px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    overflow: hidden;
  }
  .mprogress-fill {
    height: 100%;
    background: linear-gradient(90deg, #86efac, #a7f3d0);
    transition: width 0.3s ease-out;
  }
  .mprogress-text {
    display: flex;
    justify-content: space-between;
    font-size: 0.75rem;
  }
  .mpct { color: #a7f3d0; font-weight: 700; }
  .mhours { color: #9ca3af; }
</style>
