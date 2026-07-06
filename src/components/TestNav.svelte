<script lang="ts">
  import { fetchIndex, fetchOwnerQuestions } from "../lib/testDataSource";
  import { fetchBeadsIssues } from "../lib/beadsSource";
  import { epicsOnly, isOpen, isClosed } from "../lib/beadsTypes";
  import { subscribeToFile } from "../lib/testEvents";
  import { onMount, onDestroy } from "svelte";

  interface Props {
    active: "roadmap" | "tickets" | "tests" | "decisions" | "marketing" | "players" | "scenarios";
  }
  let { active }: Props = $props();

  let testCount = $state<number | null>(null);
  // Tickets tab (leads to /test/tickets/, which surfaces bd epics): grey = open count.
  let epicsOpenCount = $state<number | null>(null);
  let epicsDoneCount = $state<number | null>(null);
  // Owner Questions: yellow=pending, grey=total
  let questionsTotal = $state<number | null>(null);
  let questionsPending = $state<number | null>(null);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function refresh() {
    const [idx, bd, oq] = await Promise.all([
      fetchIndex().catch(() => null),
      fetchBeadsIssues().catch(() => []),
      fetchOwnerQuestions().catch(() => null),
    ]);
    testCount = idx?.summary?.total_tests ?? null;

    const epics = epicsOnly(bd);
    const open = epics.filter(isOpen).length;
    const closed = epics.filter(isClosed).length;
    epicsOpenCount = open > 0 ? open : null;
    epicsDoneCount = closed > 0 ? closed : null;

    if (oq && Array.isArray(oq.questions)) {
      const pending = oq.questions.filter((q: any) => q.status === "pending").length;
      const total = oq.questions.length;
      questionsPending = pending > 0 ? pending : null;
      questionsTotal = total > 0 ? total : null;
    } else {
      questionsPending = null;
      questionsTotal = null;
    }
  }

  const WATCHED = [
    "tickets/owner_questions.json",
    ".beads/issues.jsonl",
    "test_index.json",
  ];
  let unsubs: Array<() => void> = [];

  onMount(() => {
    refresh();
    pollTimer = setInterval(refresh, 15000);
    unsubs = WATCHED.map((p) => subscribeToFile(p, refresh));
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    for (const u of unsubs) u();
    unsubs = [];
  });
</script>

<nav class="test-nav">
  <a href="/test/" class="nav-tab" class:active={active === "roadmap"}>
    Console
  </a>
  <a href="/test/decisions/" class="nav-tab" class:active={active === "decisions"}>
    Questions
    <span class="nav-count nav-yellow">{questionsPending ?? 0}</span>
    <span class="nav-count nav-grey">{questionsTotal ?? 0}</span>
  </a>
  <a href="/test/tickets/" class="nav-tab" class:active={active === "tickets"}>
    Tickets
    <span class="nav-count nav-grey">{epicsOpenCount ?? 0}</span>
    {#if epicsDoneCount}
      <span class="nav-count nav-green">{epicsDoneCount}</span>
    {/if}
  </a>
  <a href="/test/tests/" class="nav-tab" class:active={active === "tests"}>
    Tests
    <span class="nav-count nav-green">0</span>
    <span class="nav-count nav-red">0</span>
    <span class="nav-count nav-grey">{testCount ?? 0}</span>
  </a>
  <a href="/test/marketing-queue/" class="nav-tab" class:active={active === "marketing"}>
    Marketing
  </a>
  <a href="/test/play-funnel/" class="nav-tab" class:active={active === "players"}>
    Players
  </a>
  <a href="/test/scenarios/" class="nav-tab" class:active={active === "scenarios"}>
    Scenarios
  </a>
</nav>

<style>
  .test-nav {
    display: flex;
    flex-wrap: wrap;
    gap: 0;
    max-width: 1600px;
    margin: 0 auto;
    padding: 0.5rem 0.5rem 0;
    border-bottom: 1px solid rgba(167, 243, 208, 0.12);
  }
  .nav-tab {
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    color: #6b7280;
    text-decoration: none;
    padding: 0.55rem 0.75rem;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .nav-tab:hover {
    color: #d1d5db;
  }
  .nav-tab.active {
    color: #a7f3d0;
    border-bottom-color: #a7f3d0;
  }
  .nav-count {
    font-size: 0.75rem;
    color: #4b5563;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.15);
    padding: 0.08rem 0.35rem;
    border-radius: 3px;
  }
  .nav-tab.active .nav-count {
    color: #a7f3d0;
    border-color: rgba(167, 243, 208, 0.3);
  }
  .nav-green {
    color: #34d399 !important;
    background: rgba(52, 211, 153, 0.15) !important;
    border-color: rgba(52, 211, 153, 0.5) !important;
    font-weight: 700;
  }
  .nav-yellow {
    color: #fbbf24 !important;
    background: rgba(251, 191, 36, 0.15) !important;
    border-color: rgba(251, 191, 36, 0.4) !important;
    font-weight: 700;
  }
  .nav-grey {
    color: #6b7280 !important;
    background: rgba(107, 114, 128, 0.08) !important;
    border-color: rgba(107, 114, 128, 0.2) !important;
  }
  .nav-red {
    color: #f87171 !important;
    background: rgba(248, 113, 113, 0.15) !important;
    border-color: rgba(248, 113, 113, 0.4) !important;
    font-weight: 700;
  }

  @media (max-width: 640px) {
    .test-nav {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 0.25rem;
      padding: 0.5rem;
    }
    .nav-tab {
      padding: 0.5rem 0.35rem;
      font-size: 0.78rem;
      border: 1px solid rgba(167, 243, 208, 0.1);
      border-radius: 4px;
      min-height: 52px;
      flex-wrap: wrap;
      gap: 0.2rem;
    }
    .nav-tab.active {
      border-color: #a7f3d0;
      border-bottom-color: #a7f3d0;
      background: rgba(167, 243, 208, 0.06);
    }
    .nav-count {
      font-size: 0.7rem;
      padding: 0.02rem 0.2rem;
    }
  }
</style>
