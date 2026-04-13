<script lang="ts">
  import type { ChatMessage, TicketsFile, Ticket } from "../lib/ticketTypes";
  import { EXPERT_META, effectivePhase, phaseColor } from "../lib/ticketTypes";
  import { fetchAgentChat, fetchTickets, submitDecision } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "legend"));

  let allMessages = $state<ChatMessage[]>([]);
  let ticketsData = $state<TicketsFile | null>(null);
  let loadError = $state<string | null>(null);
  let submitting = $state<string | null>(null);
  let replyOpen = $state<string | null>(null);
  let replyText = $state("");
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function handleDecision(decisionId: string, choice: string) {
    submitting = decisionId;
    try {
      await submitDecision(decisionId, choice);
      await load(); // Refresh to show updated status
    } catch (err: any) {
      loadError = `Failed to submit: ${err?.message ?? err}`;
    }
    submitting = null;
  }

  async function load() {
    try {
      const [chat, tix] = await Promise.all([fetchAgentChat(), fetchTickets()]);
      allMessages = chat;
      ticketsData = tix;
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  onMount(() => {
    load();
    pollTimer = setInterval(load, 5000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  interface Decision {
    msg: ChatMessage;
    id: string;
    options: string[];
    defaultOption: string;
    status: string;
    tickets: string[];
    agents: string[];
  }

  // Extract decisions from owner-targeted messages
  let decisions = $derived.by<Decision[]>(() => {
    return allMessages
      .filter((m: any) => m.to === "Owner" && m.decision)
      .map((m: any) => ({
        msg: m,
        id: m.decision.id,
        options: m.decision.options,
        defaultOption: m.decision.default,
        status: m.decision.status,
        tickets: m.refs?.tickets ?? [],
        agents: m.refs?.agents ?? [],
      }));
  });

  let pending = $derived(decisions.filter((d) => d.status === "pending"));
  let resolved = $derived(decisions.filter((d) => d.status !== "pending"));

  // Tickets awaiting owner input
  let awaitingTickets = $derived.by<Ticket[]>(() => {
    if (!ticketsData) return [];
    return ticketsData.tickets.filter((t) => t.awaitingOwner && effectivePhase(t) !== "done");
  });

  // Context messages (to Owner, no decision — just info)
  let context = $derived(
    allMessages.filter((m: any) => m.to === "Owner" && !m.decision)
  );

  function relativeDate(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }
</script>

<div class="decisions-page">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Legend tier required</h2>
      <p>Decision queue is a <strong>Legend</strong> tier perk.</p>
      <p><a href="/subscribe/">View subscription tiers →</a></p>
    </div>
  {:else}
  {#if loadError}
    <div class="error-banner">{loadError}</div>
  {/if}

  {#if pending.length > 0}
    <div class="queue-header">
      <h2 class="section-title">{pending.length} Pending Decisions</h2>
      <span class="queue-hint">Lead recommendations shown as default. Approve or override each.</span>
    </div>
    <div class="decision-list">
      {#each pending as d (d.id)}
        {@const fromMeta = EXPERT_META[d.msg.from.toLowerCase()]}
        <div class="decision-card">
          <div class="dec-header">
            <span class="dec-id">{d.id}</span>
            <span class="dec-from" style="color: {fromMeta?.color ?? '#9ca3af'}">{fromMeta?.label ?? d.msg.from}</span>
            {#each d.tickets as tid}
              <a href="/test/tickets/#ticket-{tid}" class="dec-ticket">{tid}</a>
            {/each}
            <span class="dec-time">{relativeDate(d.msg.timestamp)}</span>
          </div>
          <p class="dec-body">{d.msg.message}</p>
          <div class="dec-actions">
            {#each d.options as opt}
              <button
                class="dec-btn"
                class:dec-recommended={opt === d.defaultOption}
                disabled={submitting === d.id}
                title={opt === d.defaultOption ? "Lead recommendation" : ""}
                onclick={() => handleDecision(d.id, opt)}
              >
                {#if submitting === d.id}
                  …
                {:else}
                  {opt}
                  {#if opt === d.defaultOption}
                    <span class="rec-badge">recommended</span>
                  {/if}
                {/if}
              </button>
            {/each}
            <button
              class="dec-btn dec-reply-toggle"
              onclick={() => { replyOpen = replyOpen === d.id ? null : d.id; replyText = ""; }}
            >Reply with note</button>
          </div>
          {#if replyOpen === d.id}
            <div class="dec-reply">
              <textarea
                class="dec-reply-input"
                placeholder="Your response to Arc..."
                bind:value={replyText}
                rows="2"
              ></textarea>
              <button
                class="dec-btn dec-reply-send"
                disabled={!replyText.trim() || submitting === d.id}
                onclick={() => handleDecision(d.id, replyText.trim())}
              >
                {submitting === d.id ? "…" : "Send"}
              </button>
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <div class="queue-empty">
      <h2 class="section-title">Decision Queue</h2>
      <p class="empty">No pending decisions. You're caught up.</p>
    </div>
  {/if}

  {#if awaitingTickets.length > 0}
    <h2 class="section-title awaiting-title">Awaiting Your Input ({awaitingTickets.length})</h2>
    <div class="decision-list">
      {#each awaitingTickets as t (t.id)}
        {@const expertMeta = EXPERT_META[t.ownerExpert] ?? EXPERT_META[t.ownerExpert?.toLowerCase?.()] }
        <div class="decision-card awaiting-card">
          <div class="dec-header">
            <span class="awaiting-badge">AWAITING YOU</span>
            <a href="/test/tickets/#ticket-{t.id}" class="dec-ticket">{t.id}</a>
            {#if expertMeta}
              <span class="dec-from" style="color: {expertMeta.color}">{expertMeta.label}</span>
            {/if}
            <span class="dec-phase" style="color: {phaseColor(effectivePhase(t))}">{effectivePhase(t).replace(/_/g, " ")}</span>
          </div>
          <h3 class="awaiting-title-text">{t.title}</h3>
          <p class="dec-body">{t.description}</p>
          {#if t.lastUpdate}
            <p class="awaiting-update">{t.lastUpdate}</p>
          {/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if context.length > 0}
    <h2 class="section-title context-title">Context from Arc</h2>
    <div class="context-list">
      {#each context as msg (msg.timestamp + msg.message.slice(0, 20))}
        {@const meta = EXPERT_META[msg.from.toLowerCase()]}
        <div class="context-msg" style="--msg-color: {meta?.color ?? '#9ca3af'}">
          <div class="ctx-header">
            <span class="ctx-from" style="color: {meta?.color ?? '#9ca3af'}">{meta?.label ?? msg.from}</span>
            <span class="ctx-channel">#{msg.channel}</span>
            <span class="ctx-time">{relativeDate(msg.timestamp)}</span>
          </div>
          <p class="ctx-body">{msg.message}</p>
        </div>
      {/each}
    </div>
  {/if}

  {#if resolved.length > 0}
    <h2 class="section-title resolved-title">Resolved ({resolved.length})</h2>
    <div class="resolved-list">
      {#each resolved as d (d.id)}
        <div class="resolved-row">
          <span class="dec-id">{d.id}</span>
          <span class="resolved-status">{d.status}</span>
          <span class="resolved-text">{d.msg.message.slice(0, 80)}…</span>
        </div>
      {/each}
    </div>
  {/if}
  {/if}
</div>

<style>
  .decisions-page {
    max-width: 900px;
    margin: 0 auto;
    padding: 0.75rem 1rem 3rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
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
  .empty { color: #6b7280; font-style: italic; }

  .section-title {
    font-size: 0.9rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 1rem 0 0.5rem;
  }
  .queue-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .queue-hint {
    font-size: 0.75rem;
    color: #6b7280;
  }

  /* Decision cards */
  .decision-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .decision-card {
    background: #12161e;
    border: 1px solid rgba(251, 191, 36, 0.2);
    border-left: 3px solid #fbbf24;
    border-radius: 4px;
    padding: 0.85rem 1rem;
  }
  .dec-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 0.4rem;
    flex-wrap: wrap;
  }
  .dec-id {
    font-size: 0.72rem;
    font-weight: 700;
    color: #fbbf24;
    padding: 0.05rem 0.3rem;
    background: rgba(251, 191, 36, 0.1);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 2px;
  }
  .dec-from { font-weight: 700; font-size: 0.82rem; }
  .dec-ticket {
    font-size: 0.72rem;
    font-weight: 600;
    color: #a7f3d0;
    text-decoration: none;
    padding: 0.05rem 0.3rem;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 2px;
  }
  .dec-ticket:hover { text-decoration: underline; }
  .dec-time { margin-left: auto; font-size: 0.68rem; color: #4b5563; }
  .dec-body {
    font-size: 0.85rem;
    color: #d1d5db;
    margin: 0 0 0.6rem;
    line-height: 1.5;
  }
  .dec-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .dec-btn {
    background: #0d1117;
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 4px;
    color: #d1d5db;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.4rem 0.75rem;
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 0.4rem;
    transition: all 0.15s;
  }
  .dec-btn:hover { border-color: rgba(167, 243, 208, 0.5); color: #e5e7eb; }
  .dec-btn.dec-recommended {
    border-color: #a7f3d0;
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.06);
  }
  .dec-btn.dec-recommended:hover {
    background: rgba(167, 243, 208, 0.12);
  }
  .rec-badge {
    font-size: 0.6rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: #a7f3d0;
    opacity: 0.7;
  }

  /* Awaiting owner tickets */
  .awaiting-title { color: #fbbf24; }
  .awaiting-card {
    border-color: rgba(251, 191, 36, 0.2) !important;
    border-left-color: #fbbf24 !important;
  }
  .awaiting-badge {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    background: rgba(251, 191, 36, 0.15);
    border: 1px solid rgba(251, 191, 36, 0.5);
    border-radius: 2px;
    color: #fbbf24;
    letter-spacing: 0.08em;
    font-weight: 700;
  }
  .awaiting-title-text {
    font-size: 0.9rem;
    color: #e5e7eb;
    margin: 0.3rem 0 0.2rem;
    font-weight: 600;
  }
  .dec-phase {
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-left: auto;
  }
  .awaiting-update {
    font-size: 0.78rem;
    color: #6b7280;
    margin: 0.3rem 0 0;
    font-style: italic;
  }

  /* Reply input */
  .dec-reply-toggle {
    color: #6b7280 !important;
    border-color: rgba(156, 163, 175, 0.2) !important;
    background: none !important;
  }
  .dec-reply-toggle:hover { color: #d1d5db !important; }
  .dec-reply {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    align-items: flex-end;
  }
  .dec-reply-input {
    flex: 1;
    background: #0d1117;
    color: #d1d5db;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 4px;
    padding: 0.5rem 0.6rem;
    font-family: inherit;
    font-size: 0.82rem;
    resize: vertical;
    min-height: 2.5rem;
  }
  .dec-reply-input::placeholder { color: #4b5563; }
  .dec-reply-input:focus { outline: none; border-color: #a7f3d0; }
  .dec-reply-send {
    flex-shrink: 0;
    background: rgba(167, 243, 208, 0.08) !important;
    border-color: #a7f3d0 !important;
    color: #a7f3d0 !important;
  }
  .dec-reply-send:hover:not(:disabled) { background: rgba(167, 243, 208, 0.15) !important; }
  .dec-reply-send:disabled { opacity: 0.4; cursor: not-allowed; }

  /* Context messages */
  .context-title { color: #c084fc; }
  .context-list {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }
  .context-msg {
    padding: 0.5rem 0.75rem;
    border-left: 2px solid var(--msg-color);
    background: rgba(255, 255, 255, 0.02);
    border-radius: 0 3px 3px 0;
  }
  .ctx-header {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    margin-bottom: 0.2rem;
  }
  .ctx-from { font-weight: 700; font-size: 0.82rem; }
  .ctx-channel {
    font-size: 0.68rem;
    color: #4b5563;
    padding: 0.05rem 0.3rem;
    background: rgba(255, 255, 255, 0.03);
    border: 1px solid rgba(255, 255, 255, 0.06);
    border-radius: 2px;
  }
  .ctx-time { margin-left: auto; font-size: 0.68rem; color: #4b5563; }
  .ctx-body {
    font-size: 0.82rem;
    color: #d1d5db;
    margin: 0;
    line-height: 1.5;
  }

  /* Resolved */
  .resolved-title { color: #6b7280; }
  .resolved-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .resolved-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0;
    font-size: 0.78rem;
    color: #6b7280;
    border-bottom: 1px solid rgba(255, 255, 255, 0.03);
  }
  .resolved-status {
    color: #a7f3d0;
    font-size: 0.72rem;
    text-transform: uppercase;
  }
  .resolved-text { color: #4b5563; }

  .queue-empty { text-align: center; padding: 2rem 0; }
</style>
