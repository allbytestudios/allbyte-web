<script lang="ts">
  import { fetchBeadsIssues } from "../lib/beadsSource";
  import { epicsOnly, isOpen, isClosed } from "../lib/beadsTypes";
  import { milestonesOrdered, milestoneIdFromLabels, type MilestoneMeta } from "../lib/milestones";
  import { onMount } from "svelte";

  // The badge surfaces the *current* milestone (per static metadata) and its
  // completion percentage derived from bd epic counts. Pre-Alpha "predates bd"
  // and reads as Complete; Alpha = current; Beta = planned.

  let bd = $state<import("../lib/beadsTypes").BdIssue[]>([]);

  onMount(() => {
    fetchBeadsIssues().then((issues) => { bd = issues; }).catch(() => {});
  });

  let current = $derived<MilestoneMeta | null>(
    milestonesOrdered().find((m) => m.status === "current") ??
      milestonesOrdered().find((m) => m.status === "planned") ??
      milestonesOrdered()[0] ??
      null
  );

  let weightedPct = $derived.by<number>(() => {
    if (!current) return 0;
    if (current.status === "complete") return 100;
    const epics = epicsOnly(bd).filter((e) => milestoneIdFromLabels(e.labels) === current.id);
    const open = epics.filter(isOpen).length;
    const closed = epics.filter(isClosed).length;
    const total = open + closed;
    if (total === 0) return 0;
    return Math.round((closed / total) * 100);
  });

  // Map MilestoneStatus → existing badge CSS classes (preserves visual treatment).
  let badgeStatusClass = $derived(
    current?.status === "complete" ? "status-done" :
    current?.status === "current"  ? "status-in_progress" :
                                     "status-planned"
  );

  function statusLabel(s: MilestoneMeta["status"] | undefined): string {
    switch (s) {
      case "current":  return "IN PROGRESS";
      case "complete": return "COMPLETE";
      case "planned":  return "PLANNED";
      default:         return "";
    }
  }
</script>

{#if current}
  <a
    class="milestone-badge {badgeStatusClass}"
    href="/test/"
    title="{current.label} — {statusLabel(current.status)} — {weightedPct}%"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="row row-top">
      <span class="dot" aria-hidden="true"></span>
      <span class="name">{current.label.toUpperCase()}</span>
      <span class="status">{statusLabel(current.status)}</span>
    </div>
    <div class="row row-bottom">
      <span class="pct">{weightedPct}%</span>
      <span class="progress" aria-hidden="true">
        <span class="fill" style="width: {weightedPct}%"></span>
      </span>
    </div>
  </a>
{/if}

<style>
  .milestone-badge {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.35rem;
    width: 220px;
    min-height: 58px;
    padding: 0.5rem 0.75rem;
    background: rgba(10, 14, 23, 0.92);
    border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 6px;
    text-decoration: none;
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
    color: #e5e7eb;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    transition: border-color 0.2s, background 0.2s, transform 0.15s;
    box-sizing: border-box;
  }
  .milestone-badge:hover {
    border-color: rgba(167, 243, 208, 0.75);
    background: rgba(10, 14, 23, 0.98);
    transform: translateY(-1px);
  }
  .milestone-badge.status-in_progress {
    border-color: rgba(251, 191, 36, 0.55);
    box-shadow: 0 0 12px rgba(251, 191, 36, 0.12);
  }
  .milestone-badge.status-done { border-color: rgba(167, 243, 208, 0.55); }
  .milestone-badge.status-blocked { border-color: rgba(248, 113, 113, 0.55); }

  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
  }
  .row-top { min-width: 0; }
  .row-bottom { gap: 0.5rem; }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #a7f3d0;
    flex-shrink: 0;
  }
  .status-in_progress .dot {
    background: #fbbf24;
    box-shadow: 0 0 8px rgba(251, 191, 36, 0.8);
    animation: badge-pulse 1.2s ease-in-out infinite;
  }
  .status-done .dot { background: #a7f3d0; box-shadow: 0 0 6px rgba(167, 243, 208, 0.5); }
  .status-planned .dot { background: transparent; border: 1.5px dashed rgba(156, 163, 175, 0.6); }
  .status-blocked .dot { background: #f87171; }
  @keyframes badge-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.5; transform: scale(0.7); }
  }

  .name {
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #a7f3d0;
    font-size: 0.82rem;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .status {
    color: #9ca3af;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-left: auto;
  }
  .status-in_progress .status { color: #fcd34d; }
  .status-done .status { color: #a7f3d0; }
  .status-blocked .status { color: #fca5a5; }

  /* On tight layouts the "IN PROGRESS" label is what runs out of room first.
     The pulsing dot + color already convey status, so hide the word on the
     two-up mobile layout. */
  @media (max-width: 900px) {
    .status { display: none; }
  }
  .pct {
    font-weight: 700;
    color: #e5e7eb;
    font-size: 0.85rem;
    min-width: 2.5rem;
  }
  .progress {
    flex: 1 1 auto;
    height: 5px;
    background: rgba(255, 255, 255, 0.08);
    border-radius: 2px;
    overflow: hidden;
  }
  .fill {
    display: block;
    height: 100%;
    background: linear-gradient(90deg, #86efac, #a7f3d0);
    transition: width 0.3s ease-out;
  }
  .status-in_progress .fill {
    background: linear-gradient(90deg, #fbbf24, #fcd34d);
  }
  .status-blocked .fill {
    background: linear-gradient(90deg, #f87171, #fca5a5);
  }
</style>
