<script lang="ts">
  import type { TestingRoadmap, Milestone } from "../lib/testingRoadmap";
  import type { TicketsFile, EpicsFile } from "../lib/ticketTypes";
  import { effectivePhase } from "../lib/ticketTypes";
  import { fetchRoadmap, fetchTickets, fetchEpics } from "../lib/testDataSource";
  import { onMount } from "svelte";

  interface Props {
    /** Optional pre-fetched roadmap. If omitted, the badge fetches it itself on mount. */
    roadmap?: TestingRoadmap | null;
  }

  let { roadmap: initialRoadmap = null }: Props = $props();

  let roadmap = $state<TestingRoadmap | null>(initialRoadmap);
  let tickets = $state<TicketsFile | null>(null);
  let epics = $state<EpicsFile | null>(null);

  onMount(() => {
    if (!roadmap) {
      fetchRoadmap().then((r) => { roadmap = r; }).catch(() => {});
    }
    // Fetch live ticket data so we can compute real progress instead of the
    // stale `percent_complete` in test_roadmap.json (that number didn't
    // update after the ticket schema expanded).
    fetchTickets().then((t) => { tickets = t; }).catch(() => {});
    fetchEpics().then((e) => { epics = e; }).catch(() => {});
  });

  // Pick the "current" milestone: first in_progress, else first planned, else first.
  let current = $derived<Milestone | null>(
    roadmap?.milestones.find((m) => m.status === "in_progress") ??
      roadmap?.milestones.find((m) => m.status === "planned") ??
      roadmap?.milestones[0] ??
      null
  );

  // Compute weighted completion from tickets+epics for the current milestone.
  // done=100%, testing=75%, in_progress=50%, else 0. Falls back to the
  // roadmap's percent_complete if ticket data isn't available.
  let weightedPct = $derived.by<number>(() => {
    if (!current || !tickets || !epics) return current?.percent_complete ?? 0;
    const epicIds = new Set(
      epics.epics.filter((e) => e && e.milestone === current.id).map((e) => e.id)
    );
    if (epicIds.size === 0) return current.percent_complete;
    // Collect all ticket IDs under those epics (from both epic.ticketIds and
    // ticket.epic back-ref, matching TicketsApp/ConsoleOverview logic).
    const milestoneTicketIds = new Set<string>();
    for (const e of epics.epics) {
      if (!e || !epicIds.has(e.id)) continue;
      for (const tid of e.ticketIds ?? []) milestoneTicketIds.add(tid);
    }
    for (const t of tickets.tickets) {
      if (t.epic && epicIds.has(t.epic)) milestoneTicketIds.add(t.id);
    }
    if (milestoneTicketIds.size === 0) return current.percent_complete;
    let total = 0;
    let weighted = 0;
    for (const tid of milestoneTicketIds) {
      const t = tickets.tickets.find((x) => x.id === tid);
      if (!t) continue;
      total++;
      const p = effectivePhase(t);
      if (p === "done") weighted += 1;
      else if (p === "testing") weighted += 0.75;
      else if (p === "in_progress") weighted += 0.5;
    }
    return total > 0 ? Math.round((weighted / total) * 100) : current.percent_complete;
  });

  function statusLabel(s: Milestone["status"]): string {
    switch (s) {
      case "in_progress":
        return "IN PROGRESS";
      case "done":
        return "DONE";
      case "planned":
        return "PLANNED";
      case "blocked":
        return "BLOCKED";
    }
  }

  function shortName(label: string): string {
    // "Pre-Alpha" stays intact; "Alpha — Laria village + Waterways" → "Alpha".
    // Only split on em-dash / en-dash / " - " with spaces, NOT on the internal
    // hyphen inside "Pre-Alpha".
    const split = label.split(/\s+[—–-]\s+/)[0];
    return split.toUpperCase();
  }
</script>

{#if current}
  <a
    class="milestone-badge status-{current.status}"
    href="/test/milestones/view/?id={current.id}&from=home"
    title="{current.label} — {statusLabel(current.status)} — {weightedPct}%"
    onclick={(e) => e.stopPropagation()}
  >
    <div class="row row-top">
      <span class="dot" aria-hidden="true"></span>
      <span class="name">{shortName(current.label)}</span>
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
