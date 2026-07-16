<script lang="ts">
  import { onMount } from "svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { fetchBeadsIssues } from "../lib/beadsSource";
  import type { BdIssue } from "../lib/beadsTypes";
  import {
    fetchVerified,
    markVerified,
    unmarkVerified,
    type BeadVerifyRecord,
  } from "../lib/beadVerify";

  // Arc's 3-lane contract (CON_CLAUDE_BEADS_WEBAPP_3LANE.md): partition every
  // live bd issue — needs-verify label wins over the backlog fallback.
  let issues = $state<BdIssue[]>([]);
  let verified = $state<Map<string, BeadVerifyRecord>>(new Map());
  let loaded = $state(false);
  let showAllCompleted = $state(false);
  let busy = $state<Record<string, boolean>>({});

  const admin = $derived(isAdmin(auth.currentUser));

  // Live bd rows only — the merged historical Pre-Alpha epics use semantic
  // uppercase ids, bd rows are "ChroniclesOfNesis-<slug>".
  const live = $derived(issues.filter((i) => i.id.startsWith("ChroniclesOfNesis-")));

  function sorted(list: BdIssue[]): BdIssue[] {
    return [...list].sort(
      (a, b) => a.priority - b.priority || b.updated_at.localeCompare(a.updated_at),
    );
  }
  const completed = $derived(sorted(live.filter((i) => i.status === "closed")));
  const needsVerify = $derived(
    sorted(live.filter((i) => i.status !== "closed" && i.labels?.includes("needs-verify"))),
  );
  const backlog = $derived(
    sorted(live.filter((i) => i.status !== "closed" && !i.labels?.includes("needs-verify"))),
  );

  onMount(async () => {
    try {
      issues = await fetchBeadsIssues();
    } catch {
      /* lane view degrades to empty; TicketsApp below has its own errors */
    }
    loaded = true;
    if (isAdmin(auth.currentUser)) {
      try {
        verified = await fetchVerified();
      } catch {
        /* non-admin token or endpoint hiccup — buttons still work per-click */
      }
    }
  });

  function slug(id: string): string {
    return id.replace(/^ChroniclesOfNesis-/, "");
  }

  async function verify(id: string) {
    busy = { ...busy, [id]: true };
    try {
      await markVerified(id);
      const next = new Map(verified);
      next.set(id, {
        beadId: id,
        verified_at: new Date().toISOString(),
        verified_by: auth.currentUser?.username ?? "admin",
        processed: false,
      });
      verified = next;
    } catch (e) {
      console.warn(`[bead-verify] mark failed for ${id}: ${e}`);
    }
    busy = { ...busy, [id]: false };
  }

  async function unverify(id: string) {
    busy = { ...busy, [id]: true };
    try {
      await unmarkVerified(id);
      const next = new Map(verified);
      next.delete(id);
      verified = next;
    } catch (e) {
      console.warn(`[bead-verify] unmark failed for ${id}: ${e}`);
    }
    busy = { ...busy, [id]: false };
  }
</script>

{#snippet row(i: BdIssue, lane: string)}
  <div class="bl-row">
    <span class="bl-pri p{i.priority}">P{i.priority}</span>
    <div class="bl-main">
      <span class="bl-title">{i.title}</span>
      <span class="bl-meta"
        >{slug(i.id)} · {i.issue_type} · {i.updated_at.slice(0, 10)}{#if lane === "verify" && i.status === "in_progress"}
          · in progress{/if}</span
      >
    </div>
    {#if lane === "verify" && admin}
      {@const rec = verified.get(i.id)}
      {#if rec?.processed}
        <span class="bl-state done">✓ closed</span>
      {:else if rec}
        <button
          class="bl-state queued"
          disabled={busy[i.id]}
          onclick={() => unverify(i.id)}
          title="Queued for Arc — click to undo">✓ queued (undo)</button
        >
      {:else}
        <button class="bl-verify" disabled={busy[i.id]} onclick={() => verify(i.id)}
          >Verified</button
        >
      {/if}
    {/if}
  </div>
{/snippet}

<div class="bl">
  <div class="bl-lanes">
    <section class="bl-lane">
      <h2 class="bl-h">Needs verified <span class="bl-count">{needsVerify.length}</span></h2>
      {#if !loaded}<p class="bl-empty">loading…</p>
      {:else if needsVerify.length === 0}<p class="bl-empty">nothing awaiting sign-off</p>
      {:else}
        {#each needsVerify as i (i.id)}{@render row(i, "verify")}{/each}
      {/if}
    </section>
    <section class="bl-lane">
      <h2 class="bl-h">Backlog <span class="bl-count">{backlog.length}</span></h2>
      {#if !loaded}<p class="bl-empty">loading…</p>
      {:else if backlog.length === 0}<p class="bl-empty">empty</p>
      {:else}
        {#each backlog as i (i.id)}{@render row(i, "backlog")}{/each}
      {/if}
    </section>
    <section class="bl-lane">
      <h2 class="bl-h">Completed <span class="bl-count">{completed.length}</span></h2>
      {#if !loaded}<p class="bl-empty">loading…</p>
      {:else}
        {#each showAllCompleted ? completed : completed.slice(0, 15) as i (i.id)}
          {@render row(i, "done")}
        {/each}
        {#if completed.length > 15}
          <button class="bl-more" onclick={() => (showAllCompleted = !showAllCompleted)}
            >{showAllCompleted ? "show recent only" : `show all ${completed.length}`}</button
          >
        {/if}
      {/if}
    </section>
  </div>
</div>

<style>
  .bl {
    max-width: 1400px;
    margin: 0 auto;
    padding: 0.5rem 1rem 1.5rem;
    font-family: "Courier New", monospace;
    color: #d1d5db;
  }
  .bl-lanes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  .bl-lane {
    background: #0d1220;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 6px;
    padding: 0.75rem;
    min-width: 0;
    max-height: 60vh;
    overflow-y: auto;
  }
  .bl-h {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #a7f3d0;
    margin: 0 0 0.6rem;
    display: flex;
    justify-content: space-between;
    position: sticky;
    top: 0;
    background: #0d1220;
    padding-bottom: 0.35rem;
    border-bottom: 1px solid rgba(167, 243, 208, 0.12);
  }
  .bl-count {
    color: #6b7280;
  }
  .bl-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.06);
    margin-bottom: 0.3rem;
  }
  .bl-pri {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .bl-pri.p1 { color: #fca5a5; background: rgba(252, 165, 165, 0.12); }
  .bl-pri.p2 { color: #fbbf24; background: rgba(251, 191, 36, 0.12); }
  .bl-pri.p3 { color: #9ca3af; background: rgba(156, 163, 175, 0.12); }
  .bl-main {
    display: flex;
    flex-direction: column;
    gap: 0.05rem;
    min-width: 0;
    flex: 1;
  }
  .bl-title {
    font-size: 0.8rem;
    color: #e5e7eb;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .bl-meta {
    font-size: 0.66rem;
    color: #6b7280;
  }
  .bl-verify {
    font-size: 0.72rem;
    color: #a7f3d0;
    background: none;
    border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 4px;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .bl-verify:hover:not(:disabled) {
    background: rgba(167, 243, 208, 0.1);
  }
  .bl-verify:disabled { opacity: 0.5; }
  .bl-state {
    font-size: 0.7rem;
    flex-shrink: 0;
    font-family: inherit;
  }
  .bl-state.done { color: #6b7280; }
  .bl-state.queued {
    color: #fbbf24;
    background: none;
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 4px;
    padding: 0.25rem 0.45rem;
    cursor: pointer;
  }
  .bl-more {
    width: 100%;
    font-size: 0.72rem;
    color: #9ca3af;
    background: none;
    border: 1px dashed rgba(167, 243, 208, 0.2);
    border-radius: 4px;
    padding: 0.3rem;
    cursor: pointer;
    font-family: inherit;
  }
  @media (max-width: 900px) {
    .bl-lanes { grid-template-columns: 1fr; }
    .bl-lane { max-height: none; }
  }
</style>
