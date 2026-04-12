<script lang="ts">
  import { fetchIndex, fetchDashboard, fetchTickets } from "../lib/testDataSource";
  import { onMount } from "svelte";

  interface Props {
    active: "console" | "tests" | "agents" | "tickets";
  }
  let { active }: Props = $props();

  let testCount = $state<number | null>(null);
  let agentCount = $state<number | null>(null);
  let ticketCount = $state<number | null>(null);

  onMount(async () => {
    const [idx, dash, tix] = await Promise.all([
      fetchIndex().catch(() => null),
      fetchDashboard().catch(() => null),
      fetchTickets().catch(() => null),
    ]);
    testCount = idx?.summary?.total_tests ?? null;
    agentCount = dash ? Object.keys(dash.experts).length : null;
    ticketCount = tix ? tix.tickets.filter(t => t.status !== "done" && t.status !== "deferred").length : null;
  });
</script>

<nav class="test-nav">
  <a href="/test/" class="nav-tab" class:active={active === "console"}>
    Console
  </a>
  <a href="/test/tests/" class="nav-tab" class:active={active === "tests"}>
    Tests
    {#if testCount != null}<span class="nav-count">{testCount}</span>{/if}
  </a>
  <a href="/test/agents/" class="nav-tab" class:active={active === "agents"}>
    Agents
    {#if agentCount != null}<span class="nav-count">{agentCount}</span>{/if}
  </a>
  <a href="/test/tickets/" class="nav-tab" class:active={active === "tickets"}>
    Tickets
    {#if ticketCount != null}<span class="nav-count">{ticketCount}</span>{/if}
  </a>
</nav>

<style>
  .test-nav {
    display: flex;
    gap: 0;
    max-width: 1600px;
    margin: 0 auto;
    padding: 0.5rem 1rem 0;
    border-bottom: 1px solid rgba(167, 243, 208, 0.12);
  }
  .nav-tab {
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    color: #6b7280;
    text-decoration: none;
    padding: 0.55rem 1.1rem;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .nav-tab:hover {
    color: #d1d5db;
  }
  .nav-tab.active {
    color: #a7f3d0;
    border-bottom-color: #a7f3d0;
  }
  .nav-count {
    font-size: 0.72rem;
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
</style>
