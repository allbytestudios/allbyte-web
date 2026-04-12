<script lang="ts">
  interface Props {
    active: "tests" | "agents" | "tickets";
  }
  let { active }: Props = $props();
</script>

<nav class="test-nav">
  <a href="/test/" class="nav-tab" class:active={active === "tests"}>Tests</a>
  <a href="/test/agents/" class="nav-tab" class:active={active === "agents"}>Agents</a>
  <a href="/test/tickets/" class="nav-tab" class:active={active === "tickets"}>Tickets</a>
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
  }
  .nav-tab:hover {
    color: #d1d5db;
  }
  .nav-tab.active {
    color: #a7f3d0;
    border-bottom-color: #a7f3d0;
  }
</style>
