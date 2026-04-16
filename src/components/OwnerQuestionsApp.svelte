<script lang="ts">
  import type { OwnerQuestion, OwnerQuestionsFile, OwnerQuestionAnswerType } from "../lib/ticketTypes";
  import { SOURCE_META, sortOwnerQuestions } from "../lib/ticketTypes";
  import { fetchOwnerQuestions, submitOwnerAnswer } from "../lib/testDataSource";
  import { subscribeToFile } from "../lib/testEvents";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "legend"));

  let file = $state<OwnerQuestionsFile | null>(null);
  let loadError = $state<string | null>(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  // Optimistic "just submitted" state — shows a spinner/ACK before the next
  // poll picks up Arc's resolution. Key = questionId, value = answer summary.
  let submitting = $state<Record<string, string>>({});

  // Per-question UI state (expanded issue note, freeText draft)
  let issueNoteOpen = $state<Record<string, boolean>>({});
  let issueNoteText = $state<Record<string, string>>({});
  let freeTextDraft = $state<Record<string, string>>({});

  async function load() {
    try {
      const f = await fetchOwnerQuestions();
      file = f;
      loadError = null;
    } catch (err: any) {
      loadError = err?.message ?? String(err);
    }
  }

  let unsubOQ: (() => void) | null = null;
  let unsubAnswers: (() => void) | null = null;

  onMount(() => {
    load();
    // SSE push for near-instant refresh when the daemon mutates state.
    // Polling stays as a fallback; interval relaxed since SSE covers the hot path.
    pollTimer = setInterval(load, 15000);
    unsubOQ = subscribeToFile("tickets/owner_questions.json", load);
    unsubAnswers = subscribeToFile("tickets/owner_answers.ndjson", load);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    unsubOQ?.();
    unsubAnswers?.();
  });

  async function answerChoice(q: OwnerQuestion, choice: string) {
    submitting[q.id] = `Submitted: ${choice}`;
    try {
      await submitOwnerAnswer({ questionId: q.id, answerType: "choice", choice });
      await load();
    } catch (err: any) {
      loadError = `Failed to submit ${q.id}: ${err?.message ?? err}`;
      delete submitting[q.id];
    }
  }

  async function answerVerification(q: OwnerQuestion, verified: boolean, issueNote?: string) {
    submitting[q.id] = verified ? "Verified ✓" : `Flagged issue${issueNote ? ": " + issueNote : ""}`;
    try {
      await submitOwnerAnswer({
        questionId: q.id,
        answerType: "verification",
        verified,
        issueNote: verified ? null : (issueNote ?? null),
      });
      await load();
      delete issueNoteOpen[q.id];
      delete issueNoteText[q.id];
    } catch (err: any) {
      loadError = `Failed to submit ${q.id}: ${err?.message ?? err}`;
      delete submitting[q.id];
    }
  }

  async function answerFreeText(q: OwnerQuestion) {
    const text = (freeTextDraft[q.id] ?? "").trim();
    if (!text) return;
    submitting[q.id] = `Sent: ${text.length > 40 ? text.slice(0, 40) + "…" : text}`;
    try {
      await submitOwnerAnswer({ questionId: q.id, answerType: "freeText", freeText: text });
      await load();
      delete freeTextDraft[q.id];
    } catch (err: any) {
      loadError = `Failed to submit ${q.id}: ${err?.message ?? err}`;
      delete submitting[q.id];
    }
  }

  function relativeDate(iso: string): string {
    const ms = Date.now() - Date.parse(iso);
    if (ms < 60_000) return "just now";
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    return `${Math.round(ms / 86_400_000)}d ago`;
  }

  function deepLinkFor(q: OwnerQuestion): string | null {
    // Synthesize a URL from sourceFile + sourceId when possible.
    if (q.ticket) return `/test/tickets/#ticket-${q.ticket}`;
    if (q.sourceFile === "agent_chat.ndjson" && q.sourceId) {
      return `/test/agent-chat/?msg=${encodeURIComponent(q.sourceId)}`;
    }
    return null;
  }

  let pending = $derived<OwnerQuestion[]>(() => {
    if (!file) return [];
    return sortOwnerQuestions(file.questions.filter((q) => q.status === "pending"));
  });

  let pendingByType = $derived.by<Record<OwnerQuestionAnswerType, number>>(() => {
    const counts: Record<OwnerQuestionAnswerType, number> = { choice: 0, verification: 0, freeText: 0 };
    for (const q of pending()) counts[q.answerType]++;
    return counts;
  });
</script>

<div class="questions-page">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Legend tier required</h2>
      <p>The unified owner-questions queue is a <strong>Legend</strong> tier perk.</p>
      <p><a href="/subscribe/">View subscription tiers →</a></p>
    </div>
  {:else}
    {#if loadError}
      <div class="error-banner">{loadError}</div>
    {/if}

    {#if file && pending().length === 0}
      <div class="empty-state">
        <h2>No pending questions</h2>
        <p>Nothing is waiting on you right now. Arc will populate this when leads need input.</p>
      </div>
    {/if}

    {#if pending().length > 0}
      <div class="queue-header">
        <h2 class="section-title">{pending().length} Pending</h2>
        <span class="queue-hint">
          {pendingByType.choice} decision{pendingByType.choice === 1 ? "" : "s"} ·
          {pendingByType.verification} verification{pendingByType.verification === 1 ? "" : "s"} ·
          {pendingByType.freeText} open
        </span>
      </div>

      <div class="question-list">
        {#each pending() as q (q.id)}
          {@const srcMeta = SOURCE_META[q.source] ?? { label: q.source ?? "Unknown", color: "#9ca3af" }}
          {@const link = deepLinkFor(q)}
          {@const subText = submitting[q.id]}
          <div class="question-card">
            <div class="q-header">
              <span class="q-id">{q.id}</span>
              <span class="q-source" style="color: {srcMeta.color}; border-color: {srcMeta.color}40;">
                {srcMeta.label}
              </span>
              {#if q.priority}
                <span class="q-priority q-priority-{q.priority}">{q.priority}</span>
              {/if}
              {#if q.ticket}
                <a href="/test/tickets/#ticket-{q.ticket}" class="q-ref">{q.ticket}</a>
              {/if}
              {#if q.epic && q.epic !== q.ticket}
                <span class="q-epic">{q.epic}</span>
              {/if}
              <span class="q-time" title={q.createdAt}>{relativeDate(q.createdAt)}</span>
            </div>

            <p class="q-text">{q.question}</p>

            {#if q.context}
              <p class="q-context">{q.context}</p>
            {/if}

            {#if q.relatedArtifacts && q.relatedArtifacts.length > 0}
              <div class="q-artifacts">
                {#each q.relatedArtifacts as art}
                  <span class="q-artifact">
                    <span class="art-type">{art.type}</span>
                    <code>{art.path}</code>
                  </span>
                {/each}
              </div>
            {/if}

            {#if subText}
              <div class="q-submitted">
                <span class="spinner" aria-hidden="true"></span>
                {subText} — awaiting Arc…
              </div>
            {:else if q.answerType === "choice" && q.options}
              <div class="q-actions">
                {#each q.options as opt}
                  <button
                    class="q-btn q-btn-choice"
                    class:q-btn-recommended={opt === q.default}
                    onclick={() => answerChoice(q, opt)}
                  >
                    {opt}
                    {#if opt === q.default}
                      <span class="rec-badge">Arc recommends</span>
                    {/if}
                  </button>
                {/each}
              </div>
            {:else if q.answerType === "verification"}
              <div class="q-actions">
                <button class="q-btn q-btn-verified" onclick={() => answerVerification(q, true)}>
                  ✓ Verified
                </button>
                <button
                  class="q-btn q-btn-issue"
                  onclick={() => { issueNoteOpen[q.id] = true; }}
                >
                  ✗ Found issue
                </button>
                {#if link}
                  <a href={link} class="q-btn q-btn-link">View source →</a>
                {/if}
              </div>
              {#if issueNoteOpen[q.id]}
                <div class="q-issue-note">
                  <textarea
                    class="q-note-input"
                    placeholder="What did you see? (optional but helpful)"
                    bind:value={issueNoteText[q.id]}
                    rows="3"
                  ></textarea>
                  <div class="q-note-actions">
                    <button
                      class="q-btn q-btn-issue-submit"
                      onclick={() => answerVerification(q, false, issueNoteText[q.id])}
                    >
                      Send issue report
                    </button>
                    <button
                      class="q-btn q-btn-cancel"
                      onclick={() => { delete issueNoteOpen[q.id]; delete issueNoteText[q.id]; }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              {/if}
            {:else if q.answerType === "freeText"}
              <div class="q-freetext">
                <textarea
                  class="q-note-input"
                  placeholder="Type your answer…"
                  bind:value={freeTextDraft[q.id]}
                  rows="3"
                ></textarea>
                <div class="q-note-actions">
                  <button
                    class="q-btn q-btn-send"
                    disabled={!(freeTextDraft[q.id] ?? "").trim()}
                    onclick={() => answerFreeText(q)}
                  >
                    Send
                  </button>
                </div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  .questions-page {
    max-width: 960px;
    margin: 1.5rem auto 3rem;
    padding: 0 1rem;
    font-family: "Courier New", monospace;
    color: #e0e7ff;
  }

  .loading, .empty-state {
    text-align: center;
    padding: 3rem 1rem;
    color: rgba(224, 231, 255, 0.6);
  }

  .empty-state h2 {
    color: #a7f3d0;
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.5rem;
    margin: 0 0 0.5rem;
  }

  .gate {
    text-align: center;
    padding: 3rem 1rem;
    border: 1px solid rgba(249, 115, 22, 0.25);
    background: rgba(249, 115, 22, 0.05);
    border-radius: 6px;
  }

  .gate h2 { color: #f97316; margin: 0 0 0.5rem; }
  .gate a { color: #fbbf24; }

  .error-banner {
    background: rgba(248, 113, 113, 0.12);
    border: 1px solid rgba(248, 113, 113, 0.4);
    color: #fca5a5;
    padding: 0.6rem 1rem;
    border-radius: 4px;
    margin-bottom: 1rem;
  }

  .queue-header {
    display: flex;
    align-items: baseline;
    gap: 1rem;
    margin-bottom: 1rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.15);
  }

  .section-title {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.4rem;
    color: #a7f3d0;
    margin: 0;
  }

  .queue-hint {
    font-size: 0.85rem;
    color: rgba(224, 231, 255, 0.5);
  }

  .question-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .question-card {
    background: #141b24;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 4px;
    padding: 0.85rem 1rem;
  }

  .q-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.6rem;
    font-size: 0.78rem;
    color: rgba(224, 231, 255, 0.7);
    margin-bottom: 0.5rem;
  }

  .q-id {
    font-weight: 700;
    color: #e0e7ff;
  }

  .q-source {
    border: 1px solid;
    border-radius: 2px;
    padding: 0.1rem 0.45rem;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
  }

  .q-priority {
    font-weight: 700;
    padding: 0.1rem 0.4rem;
    border-radius: 2px;
    font-size: 0.72rem;
  }
  .q-priority-P0 { background: rgba(248, 113, 113, 0.18); color: #fca5a5; }
  .q-priority-P1 { background: rgba(251, 191, 36, 0.18); color: #fcd34d; }
  .q-priority-P2 { background: rgba(96, 165, 250, 0.18); color: #93c5fd; }
  .q-priority-P3 { background: rgba(156, 163, 175, 0.18); color: #9ca3af; }

  .q-ref {
    font-family: "Courier New", monospace;
    color: #a7f3d0;
    text-decoration: none;
    border: 1px solid rgba(167, 243, 208, 0.3);
    padding: 0.1rem 0.4rem;
    border-radius: 2px;
  }
  .q-ref:hover { border-color: #a7f3d0; }

  .q-epic {
    color: rgba(196, 132, 252, 0.8);
    font-size: 0.75rem;
  }

  .q-time {
    margin-left: auto;
    font-size: 0.75rem;
    color: rgba(224, 231, 255, 0.5);
  }

  .q-text {
    font-size: 0.95rem;
    line-height: 1.5;
    color: #e0e7ff;
    margin: 0 0 0.5rem;
  }

  .q-context {
    font-size: 0.82rem;
    line-height: 1.5;
    color: rgba(224, 231, 255, 0.55);
    margin: 0 0 0.6rem;
    padding-left: 0.75rem;
    border-left: 2px solid rgba(167, 243, 208, 0.2);
  }

  .q-artifacts {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-bottom: 0.6rem;
  }

  .q-artifact {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: 0.75rem;
    background: rgba(167, 243, 208, 0.06);
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 2px;
    padding: 0.15rem 0.5rem;
  }
  .q-artifact .art-type {
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.68rem;
  }
  .q-artifact code {
    background: none;
    color: rgba(224, 231, 255, 0.75);
    font-size: 0.75rem;
  }

  .q-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }

  .q-btn {
    background: #1a2332;
    border: 1px solid rgba(167, 243, 208, 0.3);
    color: #e0e7ff;
    font-family: "Courier New", monospace;
    font-size: 0.82rem;
    padding: 0.4rem 0.75rem;
    border-radius: 3px;
    cursor: pointer;
    transition: all 0.15s;
    text-decoration: none;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }
  .q-btn:hover:not(:disabled) {
    background: #243044;
    border-color: rgba(167, 243, 208, 0.6);
  }
  .q-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .q-btn-recommended {
    border-color: rgba(167, 243, 208, 0.75);
    background: rgba(167, 243, 208, 0.1);
  }

  .rec-badge {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    background: rgba(167, 243, 208, 0.25);
    color: #a7f3d0;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .q-btn-verified {
    border-color: rgba(134, 239, 172, 0.5);
    color: #86efac;
  }
  .q-btn-verified:hover {
    background: rgba(134, 239, 172, 0.12);
    border-color: #86efac;
  }

  .q-btn-issue {
    border-color: rgba(248, 113, 113, 0.5);
    color: #fca5a5;
  }
  .q-btn-issue:hover {
    background: rgba(248, 113, 113, 0.1);
    border-color: #f87171;
  }

  .q-btn-issue-submit {
    border-color: rgba(251, 191, 36, 0.6);
    color: #fcd34d;
  }

  .q-btn-send {
    border-color: rgba(167, 243, 208, 0.5);
    color: #a7f3d0;
  }

  .q-btn-cancel {
    border-color: rgba(156, 163, 175, 0.3);
    color: rgba(224, 231, 255, 0.6);
  }

  .q-btn-link {
    border-color: rgba(96, 165, 250, 0.4);
    color: #93c5fd;
    margin-left: auto;
  }

  .q-issue-note, .q-freetext {
    margin-top: 0.6rem;
    padding-top: 0.6rem;
    border-top: 1px solid rgba(167, 243, 208, 0.1);
  }

  .q-note-input {
    width: 100%;
    background: #0d1117;
    border: 1px solid rgba(167, 243, 208, 0.2);
    color: #e0e7ff;
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    padding: 0.5rem 0.6rem;
    border-radius: 3px;
    resize: vertical;
    box-sizing: border-box;
  }
  .q-note-input:focus {
    outline: none;
    border-color: rgba(167, 243, 208, 0.5);
  }

  .q-note-actions {
    display: flex;
    gap: 0.5rem;
    margin-top: 0.5rem;
    justify-content: flex-end;
  }

  .q-submitted {
    padding: 0.5rem 0.75rem;
    background: rgba(251, 191, 36, 0.08);
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 3px;
    color: #fcd34d;
    font-size: 0.82rem;
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .spinner {
    display: inline-block;
    width: 10px;
    height: 10px;
    border: 2px solid rgba(251, 191, 36, 0.3);
    border-top-color: #fcd34d;
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
</style>
