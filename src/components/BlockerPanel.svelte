<script lang="ts">
  import type { TestingRoadmap } from "../lib/testingRoadmap";
  import { summarizeBlockers } from "../lib/testingRoadmap";

  interface Props {
    roadmap: TestingRoadmap | null;
  }

  let { roadmap }: Props = $props();

  let summaries = $derived(roadmap ? summarizeBlockers(roadmap) : []);
  let total = $derived(summaries.reduce((n, s) => n + s.scenes.length, 0));
</script>

{#if roadmap && roadmap.known_blockers.length > 0}
  <details class="blocker-panel" open={total > 0}>
    <summary>
      <span class="arrow" aria-hidden="true"></span>
      <span class="title">Blockers</span>
      <span class="count">{roadmap.known_blockers.length} known · {total} scene{total === 1 ? "" : "s"} gated</span>
    </summary>
    <div class="blocker-list">
      {#each summaries as s (s.blocker.id)}
        <div class="blocker">
          <div class="b-header">
            <span class="b-label">{s.blocker.label}</span>
            <span class="b-hours" title="Estimated hours to unblock"
              >{s.blocker.est_hours_to_unblock}h to unblock</span>
          </div>
          <div class="b-impact">{s.blocker.impact}</div>
          {#if s.scenes.length > 0}
            <div class="b-scenes">
              <span class="b-scenes-label">
                {s.scenes.length} scene{s.scenes.length === 1 ? "" : "s"} ·
                {s.tests_blocked} test{s.tests_blocked === 1 ? "" : "s"} blocked ·
                ~{Math.round(s.hours_unlocked)}h unlocked
              </span>
              <div class="scene-chips">
                {#each s.scenes as scene (scene.id)}
                  <span class="scene-chip" title={scene.path}>{scene.label}</span>
                {/each}
              </div>
            </div>
          {:else}
            <div class="b-scenes empty">No scenes in the roadmap reference this blocker yet.</div>
          {/if}
        </div>
      {/each}
    </div>
  </details>
{/if}

<style>
  .blocker-panel {
    background: #12161e;
    border: 1px solid rgba(248, 113, 113, 0.25);
    border-radius: 6px;
    padding: 0.6rem 0.85rem;
    margin-bottom: 0.75rem;
    font-family: "Courier New", monospace;
  }
  summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.6rem;
    cursor: pointer;
    user-select: none;
  }
  summary::-webkit-details-marker { display: none; }
  .arrow::before {
    content: "▸";
    color: #fca5a5;
    font-size: 0.8rem;
    transition: transform 0.15s;
    display: inline-block;
  }
  .blocker-panel[open] > summary .arrow::before { transform: rotate(90deg); }
  .title {
    color: #fca5a5;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    font-size: 0.8rem;
  }
  .count { color: #9ca3af; font-size: 0.75rem; margin-left: auto; }
  .blocker-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px solid rgba(248, 113, 113, 0.15);
  }
  .blocker {
    padding: 0.55rem 0.7rem;
    background: rgba(248, 113, 113, 0.05);
    border-left: 3px solid rgba(248, 113, 113, 0.55);
    border-radius: 3px;
  }
  .b-header {
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }
  .b-label {
    color: #fca5a5;
    font-weight: 700;
    font-size: 0.9rem;
  }
  .b-hours {
    color: #9ca3af;
    font-size: 0.72rem;
    margin-left: auto;
    cursor: help;
  }
  .b-impact {
    color: #d1d5db;
    font-size: 0.8rem;
    margin: 0.25rem 0 0.4rem;
    line-height: 1.4;
  }
  .b-scenes {
    font-size: 0.72rem;
    color: #9ca3af;
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }
  .b-scenes.empty { color: #6b7280; font-style: italic; }
  .b-scenes-label { font-size: 0.7rem; }
  .scene-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.3rem;
  }
  .scene-chip {
    padding: 0.1rem 0.45rem;
    background: rgba(255, 255, 255, 0.04);
    color: #e5e7eb;
    border-radius: 2px;
    font-size: 0.7rem;
    cursor: help;
  }
</style>
