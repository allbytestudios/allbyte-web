<script lang="ts">
  import type { ChatMessage } from "../lib/ticketTypes";
  import { EXPERT_META } from "../lib/ticketTypes";
  import { fetchAgentChat } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy, tick } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));

  let messages = $state<ChatMessage[]>([]);
  let loadError = $state<string | null>(null);
  let filterAgent = $state<string | null>(null);
  let feedEl = $state<HTMLDivElement | null>(null);
  let prevCount = $state(0);
  let autoScroll = $state(true);

  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    try {
      messages = await fetchAgentChat();
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  onMount(async () => {
    await load();
    prevCount = messages.length;
    await tick();
    scrollToBottom();
    pollTimer = setInterval(async () => {
      await load();
      if (messages.length > prevCount && autoScroll) {
        prevCount = messages.length;
        await tick();
        scrollToBottom();
      }
      prevCount = messages.length;
    }, 5000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  function scrollToBottom() {
    if (feedEl) feedEl.scrollTop = feedEl.scrollHeight;
  }

  function handleScroll() {
    if (!feedEl) return;
    const atBottom = feedEl.scrollHeight - feedEl.scrollTop - feedEl.clientHeight < 50;
    autoScroll = atBottom;
  }

  let filtered = $derived.by<ChatMessage[]>(() => {
    if (!filterAgent) return messages;
    return messages.filter((m) => m.from.toLowerCase() === filterAgent);
  });

  let agents = $derived.by<string[]>(() => {
    const seen = new Set<string>();
    for (const m of messages) seen.add(m.from.toLowerCase());
    return [...seen].sort();
  });

  function relativeDate(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }
</script>

<div class="chat-page">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Hero tier required</h2>
      <p>Agent chat feed is a <strong>Hero</strong> tier perk.</p>
      <p><a href="/subscribe/">View subscription tiers →</a></p>
    </div>
  {:else}
  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  <!-- Agent filter buttons -->
  <div class="agent-filters">
    <button class="agent-btn" class:agent-active={!filterAgent} onclick={() => { filterAgent = null; }}>
      All <span class="agent-count">{messages.length}</span>
    </button>
    {#each agents as a (a)}
      {@const meta = EXPERT_META[a]}
      <button
        class="agent-btn"
        class:agent-active={filterAgent === a}
        style="--agent-color: {meta?.color ?? '#9ca3af'}"
        onclick={() => { filterAgent = filterAgent === a ? null : a; }}
      >
        {meta?.label ?? a}
        <span class="agent-count">{messages.filter(m => m.from.toLowerCase() === a).length}</span>
      </button>
    {/each}
  </div>

  <!-- Chat feed -->
  <div class="chat-feed" bind:this={feedEl} onscroll={handleScroll}>
    {#if filtered.length === 0}
      <div class="chat-empty">No agent messages yet.</div>
    {:else}
      {#each filtered as msg, i (msg.timestamp + msg.from + i)}
        {@const meta = EXPERT_META[msg.from.toLowerCase()]}
        {@const toMeta = msg.to !== "all" ? EXPERT_META[msg.to.toLowerCase()] : null}
        <div class="chat-msg" style="--msg-color: {meta?.color ?? '#9ca3af'}">
          <div class="msg-header">
            <a href="/test/agents/#agent-{msg.from.toLowerCase()}" class="msg-author" style="color: {meta?.color ?? '#9ca3af'}">
              {meta?.label ?? msg.from}
            </a>
            <span class="msg-to">
              → {#if toMeta}
                <a href="/test/agents/#agent-{msg.to.toLowerCase()}" class="msg-to-link" style="color: {toMeta.color}">{toMeta.label}</a>
              {:else}
                {msg.to}
              {/if}
            </span>
            <span class="msg-channel">#{msg.channel}</span>
            <span class="msg-time">{relativeDate(msg.timestamp)}</span>
          </div>
          <p class="msg-body">{msg.message}</p>
        </div>
      {/each}
    {/if}
  </div>

  {#if !autoScroll && messages.length > 0}
    <button class="scroll-btn" onclick={() => { autoScroll = true; scrollToBottom(); }}>
      ↓ New messages
    </button>
  {/if}
  {/if}
</div>

<style>
  .chat-page {
    max-width: 900px;
    margin: 0 auto;
    padding: 0.75rem 1rem 1rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
    display: flex;
    flex-direction: column;
    height: calc(100vh - 200px);
    position: relative;
  }
  .error-banner {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.4);
    border-radius: 4px;
    padding: 0.75rem 1rem;
    margin-bottom: 0.5rem;
    color: #fca5a5;
    font-size: 0.85rem;
  }
  .loading, .gate { text-align: center; padding: 3rem; color: #9ca3af; }
  .gate h2 { color: #fbbf24; text-transform: uppercase; letter-spacing: 0.08em; font-size: 1.05rem; }
  .gate strong { color: #fbbf24; }
  .gate a { color: #a7f3d0; text-decoration: none; }

  .agent-filters {
    display: flex;
    gap: 0.35rem;
    padding: 0.5rem 0;
    flex-shrink: 0;
    flex-wrap: wrap;
    border-bottom: 1px solid rgba(167, 243, 208, 0.1);
    margin-bottom: 0.5rem;
  }
  .agent-btn {
    background: #0d1117;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 3px;
    color: #6b7280;
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 600;
    padding: 0.3rem 0.6rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.3rem;
    transition: all 0.15s;
  }
  .agent-btn:hover { color: #d1d5db; border-color: rgba(167, 243, 208, 0.25); }
  .agent-btn.agent-active {
    color: var(--agent-color, #a7f3d0);
    border-color: var(--agent-color, #a7f3d0);
    background: rgba(167, 243, 208, 0.06);
  }
  .agent-count { font-size: 0.68rem; opacity: 0.7; }

  .chat-feed {
    flex: 1;
    overflow-y: auto;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding: 0.5rem 0;
  }
  .chat-empty {
    text-align: center;
    padding: 3rem;
    color: #6b7280;
  }
  .chat-msg {
    padding: 0.6rem 0.85rem;
    border-left: 3px solid var(--msg-color);
    background: rgba(255, 255, 255, 0.02);
    border-radius: 0 4px 4px 0;
  }
  .msg-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.3rem;
    flex-wrap: wrap;
  }
  .msg-author {
    font-weight: 700;
    font-size: 0.85rem;
    text-decoration: none;
  }
  .msg-author:hover { text-decoration: underline; }
  .msg-to {
    font-size: 0.72rem;
    color: #6b7280;
  }
  .msg-to-link {
    text-decoration: none;
    font-weight: 600;
  }
  .msg-to-link:hover { text-decoration: underline; }
  .msg-channel {
    font-size: 0.68rem;
    color: #4b5563;
    padding: 0.05rem 0.3rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 2px;
  }
  .msg-time {
    margin-left: auto;
    font-size: 0.68rem;
    color: #4b5563;
  }
  .msg-body {
    font-size: 0.85rem;
    color: #d1d5db;
    margin: 0;
    line-height: 1.55;
    white-space: pre-wrap;
  }

  .scroll-btn {
    position: absolute;
    bottom: 1rem;
    left: 50%;
    transform: translateX(-50%);
    background: #a7f3d0;
    color: #0a0e17;
    border: none;
    border-radius: 4px;
    padding: 0.35rem 0.75rem;
    font-family: inherit;
    font-size: 0.78rem;
    font-weight: 700;
    cursor: pointer;
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.4);
  }
  .scroll-btn:hover { background: #6ee7b7; }
</style>
