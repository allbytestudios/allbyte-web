<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import { difficulties, treeFor, jumpUrl, type TreeEntry, type SaveTreeNode } from "../lib/saveTree";

  const diffs = difficulties();
  const gated = $derived(
    !(isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend")),
  );

  function chips(n: SaveTreeNode): string {
    const b = n.build;
    const parts: string[] = [];
    if (b?.level != null) parts.push(`Lv${b.level}`);
    if (b?.maxHP != null) parts.push(`${b.maxHP}HP`);
    if (b?.skills?.length) parts.push(b.skills.join("/"));
    if (n.inventory?.sen != null) parts.push(`${n.inventory.sen} sen`);
    if (n.scene) parts.push(n.scene);
    return parts.join(" · ");
  }
</script>

{#snippet row(e: TreeEntry)}
  <div class="tre-row" class:leaf={e.node.is_leaf} style={`--depth:${e.depth}`}>
    <div class="tre-info">
      <span class="tre-line">
        {#if e.depth > 0}<span class="tre-branch">└─</span>{/if}
        {#if e.node.decision && e.depth > 0}<span class="tre-decision">{e.node.decision}</span>
          <span class="tre-arrow">→</span>{/if}
        <span class="tre-label">{e.node.label}</span>
        {#if e.node.is_leaf}<span class="tre-boss">★ boss</span>{/if}
      </span>
      <span class="tre-meta">
        {chips(e.node)}{#if e.node.web_version} · v{e.node.web_version}{/if}
        {#if e.node.tags?.length} · {e.node.tags.join(", ")}{/if}
      </span>
      {#if e.node.summary}<span class="tre-summary">{e.node.summary}</span>{/if}
    </div>
    <a class="tre-jump" href={jumpUrl(e.node)} target="_blank" rel="noopener">Jump ↗</a>
  </div>
  {#each e.children as c (c.node.id)}
    {@render row(c)}
  {/each}
{/snippet}

<div class="tre">
  <h2 class="tre-title">Save-State Tree</h2>
  <p class="tre-lede">
    Branching chain-legal saves — root → decision edges → boss leaves. Jump loads the node's
    save into the <code>develop</code> build, same mechanism as the scenarios above.
  </p>

  {#if gated}
    <p class="tre-note">The save-state tree is <strong>admin / Legend only</strong>.</p>
  {:else if diffs.length === 0}
    <p class="tre-note">
      No nodes yet. Arc commits <code>save_tree_manifest.json</code> + blobs; run
      <code>npm run sync:tree</code> to mirror them here.
    </p>
  {:else}
    {#each diffs as d (d)}
      <section class="tre-section">
        <h3 class="tre-h">{d}</h3>
        <div class="tre-rows">
          {#each treeFor(d) as e (e.node.id)}
            {@render row(e)}
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .tre {
    max-width: 1100px;
    margin: 2.5rem auto 0;
    padding: 0 1rem 2rem;
    color: #d1d5db;
    font-family: "Courier New", monospace;
  }
  .tre-title {
    font-size: 1rem;
    color: #e5e7eb;
    border-top: 1px solid rgba(167, 243, 208, 0.15);
    padding-top: 1.5rem;
    margin: 0 0 0.25rem;
  }
  .tre-lede {
    font-size: 0.85rem;
    color: #9ca3af;
    line-height: 1.5;
    margin: 0.25rem 0 1.25rem;
  }
  .tre code {
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.08);
    padding: 0 0.25rem;
    border-radius: 3px;
  }
  .tre-note {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 5px;
    padding: 1rem;
    font-size: 0.85rem;
    color: #9ca3af;
  }
  .tre-section {
    margin-bottom: 1.75rem;
  }
  .tre-h {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #a7f3d0;
    border-bottom: 1px solid rgba(167, 243, 208, 0.12);
    padding-bottom: 0.35rem;
    margin: 0 0 0.6rem;
  }
  .tre-rows {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .tre-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.08);
    border-radius: 5px;
    padding: 0.45rem 0.75rem;
    margin-left: calc(var(--depth, 0) * 1.5rem);
  }
  .tre-row:hover {
    border-color: rgba(167, 243, 208, 0.22);
  }
  .tre-row.leaf {
    border-color: rgba(251, 191, 36, 0.25);
  }
  .tre-row.leaf:hover {
    border-color: rgba(251, 191, 36, 0.5);
  }
  .tre-info {
    display: flex;
    flex-direction: column;
    gap: 0.1rem;
    min-width: 0;
  }
  .tre-branch {
    color: #4b5563;
  }
  .tre-decision {
    color: #9ca3af;
    font-style: italic;
    font-size: 0.82rem;
  }
  .tre-arrow {
    color: #4b5563;
  }
  .tre-label {
    font-size: 0.88rem;
    color: #e5e7eb;
    font-weight: 600;
  }
  .tre-boss {
    color: #fbbf24;
    font-size: 0.72rem;
    margin-left: 0.35rem;
  }
  .tre-meta {
    font-size: 0.72rem;
    color: #6b7280;
  }
  .tre-summary {
    font-size: 0.78rem;
    color: #9ca3af;
  }
  .tre-jump {
    font-size: 0.8rem;
    color: #a7f3d0;
    text-decoration: none;
    padding: 0.3rem 0.65rem;
    border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 4px;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .tre-jump:hover {
    background: rgba(167, 243, 208, 0.1);
    border-color: rgba(167, 243, 208, 0.6);
  }
  @media (max-width: 600px) {
    .tre-row {
      margin-left: calc(var(--depth, 0) * 0.75rem);
    }
  }
</style>
