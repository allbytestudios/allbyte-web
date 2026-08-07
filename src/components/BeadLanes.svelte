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
    <span class="bl-title"
      >{i.title}
      <span class="bl-meta" title="{i.issue_type} · updated {i.updated_at.slice(0, 10)}"
        >{slug(i.id)}</span
      ></span
    >
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
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    color: var(--ink);
  }
  .bl-lanes {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
  }
  .bl-lane {
    background: var(--panel);
    border: 1px solid var(--rule);
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
    color: var(--crimson);
    margin: 0 0 0.6rem;
    display: flex;
    justify-content: space-between;
    position: sticky;
    top: 0;
    background: var(--panel);
    padding-bottom: 0.35rem;
    border-bottom: 1px solid var(--rule);
  }
  .bl-count {
    color: var(--ink-soft);
  }
  .bl-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.5rem;
    border-radius: 4px;
    background: var(--panel);
    border: 1px solid var(--rule);
    margin-bottom: 0.3rem;
  }
  .bl-pri {
    font-size: 0.68rem;
    font-weight: 700;
    padding: 0.1rem 0.3rem;
    border-radius: 3px;
    flex-shrink: 0;
  }
  .bl-pri.p0 { color: var(--sem-danger); background: rgba(248, 113, 113, 0.18); }
  .bl-pri.p1 { color: var(--sem-danger); background: rgba(252, 165, 165, 0.12); }
  .bl-pri.p2 { color: var(--sem-warn); background: rgba(251, 191, 36, 0.12); }
  .bl-pri.p3 { color: var(--ink-soft); background: var(--paperblend); }
  .bl-title {
    font-size: 0.8rem;
    color: var(--ink);
    flex: 1;
    min-width: 0;
    line-height: 1.35;
    /* full title always readable — wrap, never ellipsize */
    overflow-wrap: break-word;
  }
  .bl-meta {
    font-size: 0.66rem;
    color: var(--ink-soft);
    white-space: nowrap;
  }
  .bl-verify {
    font-size: 0.72rem;
    color: var(--crimson);
    background: none;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 0.25rem 0.55rem;
    cursor: pointer;
    font-family: inherit;
    flex-shrink: 0;
  }
  .bl-verify:hover:not(:disabled) {
    background: var(--paperblend);
  }
  .bl-verify:disabled { opacity: 0.5; }
  .bl-state {
    font-size: 0.7rem;
    flex-shrink: 0;
    font-family: inherit;
  }
  .bl-state.done { color: var(--ink-soft); }
  .bl-state.queued {
    color: var(--sem-warn);
    background: none;
    border: 1px solid rgba(251, 191, 36, 0.3);
    border-radius: 4px;
    padding: 0.25rem 0.45rem;
    cursor: pointer;
  }
  .bl-more {
    width: 100%;
    font-size: 0.72rem;
    color: var(--ink-soft);
    background: none;
    border: 1px dashed var(--rule);
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
