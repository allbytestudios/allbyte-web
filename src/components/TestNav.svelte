<script lang="ts">
  import { fetchIndex, fetchDashboard, fetchTickets, fetchAgentChat, fetchEpics, fetchAgentActivity } from "../lib/testDataSource";
  import { effectivePhase } from "../lib/ticketTypes";
  import { onMount } from "svelte";

  interface Props {
    active: "roadmap" | "tickets" | "agents" | "tests" | "chat" | "decisions";
  }
  let { active }: Props = $props();

  let testCount = $state<number | null>(null);
  let commentCount = $state<number | null>(null);
  // Tickets: green=in_progress, yellow=awaiting owner, grey=total open
  let ticketsTotal = $state<number | null>(null);
  let ticketsActive = $state<number | null>(null);
  let ticketsWaiting = $state<number | null>(null);
  // Agents: green=active/working, yellow=waiting, grey=total
  let agentsTotal = $state<number | null>(null);
  let agentsActive = $state<number | null>(null);
  let agentsWaiting = $state<number | null>(null);
  // Agent Chat: green=new since last visit, grey=total
  let chatNew = $state<number | null>(null);
  let chatTotalDisplay = $state<string | null>(null);
  // Agent Questions: yellow=pending, grey=total
  let questionsTotal = $state<number | null>(null);
  let questionsPending = $state<number | null>(null);

  onMount(async () => {
    const [idx, dash, tix, chat, epics, agentAct] = await Promise.all([
      fetchIndex().catch(() => null),
      fetchDashboard().catch(() => null),
      fetchTickets().catch(() => null),
      fetchAgentChat().catch(() => []),
      fetchEpics().catch(() => null),
      fetchAgentActivity().catch(() => null),
    ]);
    testCount = idx?.summary?.total_tests ?? null;

    // Tickets: total open, active (in_progress/testing), waiting (awaitingOwner)
    if (tix) {
      const open = tix.tickets.filter(t => effectivePhase(t) !== "done" && effectivePhase(t) !== "deferred");
      ticketsTotal = open.length || null;
      const active = open.filter(t => effectivePhase(t) === "in_progress" || effectivePhase(t) === "testing").length;
      ticketsActive = active > 0 ? active : null;
      const waiting = open.filter(t => t.awaitingOwner).length;
      ticketsWaiting = waiting > 0 ? waiting : null;
      commentCount = null; // set from chat below
    }

    // Agents: always 4 total (Arc, Nix, Vera, Port), active/waiting from activity
    agentsTotal = 4;
    if (agentAct) {
      const active = agentAct.activeAgents.filter(a => a.status === "active" || a.status === "working").length;
      agentsActive = active;
      const waiting = agentAct.activeAgents.filter(a => a.status.startsWith("waiting")).length;
      agentsWaiting = waiting;
    }

    // Agent Chat: count from NDJSON, not ticket comments
    const totalChat = chat.length;
    commentCount = totalChat;
    const CHAT_SEEN_KEY = "agent-chat-seen";
    const lastSeen = parseInt(sessionStorage.getItem(CHAT_SEEN_KEY) ?? "0", 10);
    // Update seen count when chat tab is active
    if (active === "chat") sessionStorage.setItem(CHAT_SEEN_KEY, String(totalChat));
    chatNew = Math.max(0, totalChat - lastSeen);
    // Round to 3 significant digits
    if (totalChat >= 1000) {
      chatTotalDisplay = (totalChat / 1000).toFixed(1) + "k";
    } else {
      chatTotalDisplay = String(totalChat);
    }

    // Agent Questions: pending decisions + awaiting owner tickets
    const ownerNames = new Set(["Owner", "AllByte", "Drew", "owner", "allbyte"]);
    const ownerDecs = chat.filter((m: any) => ownerNames.has(m.to) && m.decision);
    const pendingDecs = ownerDecs.filter((m: any) => m.decision.status === "pending");
    const awaitingCount = tix ? tix.tickets.filter(t => t.awaitingOwner && effectivePhase(t) !== "done").length : 0;
    questionsPending = (pendingDecs.length + awaitingCount) || null;
    questionsTotal = (ownerDecs.length + awaitingCount) || null;
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
    <span class="nav-count nav-green">{ticketsActive ?? 0}</span>
    <span class="nav-count nav-yellow">{ticketsWaiting ?? 0}</span>
    <span class="nav-count nav-grey">{ticketsTotal ?? 0}</span>
  </a>
  <a href="/test/agents/" class="nav-tab" class:active={active === "agents"}>
    Agents
    <span class="nav-count nav-green">{agentsActive ?? 0}</span>
    <span class="nav-count nav-yellow">{agentsWaiting ?? 0}</span>
    <span class="nav-count nav-grey">{agentsTotal ?? 0}</span>
  </a>
  <a href="/test/tests/" class="nav-tab" class:active={active === "tests"}>
    Tests
    <span class="nav-count nav-green">0</span>
    <span class="nav-count nav-red">0</span>
    <span class="nav-count nav-grey">{testCount ?? 0}</span>
  </a>
  <a href="/test/agent-chat/" class="nav-tab" class:active={active === "chat"}>
    Agent Chat
    <span class="nav-count nav-green">{chatNew ?? 0}</span>
    <span class="nav-count nav-yellow">0</span>
    <span class="nav-count nav-grey">{chatTotalDisplay ?? 0}</span>
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
</style>
