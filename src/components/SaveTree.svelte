<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import { difficulties, spineOutline, jumpUrl, type SaveTreeNode } from "../lib/saveTree";
  import { SvelteSet } from "svelte/reactivity";

  const gated = $derived(
    !(isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend")),
  );

  const diffs = difficulties();
  // Difficulty is a FILTER across the whole outline, never a grouping level.
  // The build is pinned to Medium (difficulty track dormant), so default the
  // view there rather than "all". This is a VIEW default only — dormancy is
  // decided by launcher_status in saveTree.ts, never inferred from difficulty.
  const DEFAULT_DIFFICULTY = difficulties().includes("medium") ? "medium" : "all";
  let difficulty = $state(DEFAULT_DIFFICULTY);
  // "Approved only" prunes to Quinn-verified nodes, keeping the section shells.
  let approvedOnly = $state(false);

  const diffLabel = (d: string) =>
    d === "all"
      ? "All"
      : d === "med" || d === "medium"
        ? "Med"
        : d.charAt(0).toUpperCase() + d.slice(1);

  const outline = $derived.by(() => {
    const o = spineOutline(difficulty);
    if (!approvedOnly) return o;
    return o.map((ch) => ({
      ...ch,
      sections: ch.sections.map((s) => ({
        ...s,
        nodes: s.nodes.filter((n) => n.approval === "approved"),
      })),
    }));
  });

  // Section-level collapse, default COLLAPSED — the tree opens as a clean set of
  // beat headers. Section keys are spine-fixed, so seed from the full outline.
  const allSectionKeys = spineOutline("all").flatMap((ch) => ch.sections.map((s) => s.key));
  const collapsedSections = new SvelteSet<string>(allSectionKeys);
  function toggleSection(k: string) {
    if (collapsedSections.has(k)) collapsedSections.delete(k);
    else collapsedSections.add(k);
  }
  function collapseAll() {
    outline.forEach((ch) => ch.sections.forEach((s) => collapsedSections.add(s.key)));
  }
  function expandAll() {
    collapsedSections.clear();
  }

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

<div class="tre">
  <h2 class="tre-title">Save-State Tree</h2>
  <p class="tre-lede">
    Chain-legal saves grouped by story beat — the same chapters and sections as the
    <a href="/walkthrough/">walkthrough</a>. Difficulty is a filter; Jump loads the node's
    save into the <code>develop</code> build.
  </p>

  {#if gated}
    <p class="tre-note">The save-state tree is <strong>admin / Legend only</strong>.</p>
  {:else if outline.length === 0}
    <p class="tre-note">
      No nodes yet. Arc commits the tagged <code>save_tree_manifest.json</code>; run
      <code>npm run sync:tree</code> to mirror it here.
    </p>
  {:else}
    <div class="tre-tools">
      <div class="tre-diff" role="group" aria-label="Difficulty filter">
        <span class="tre-diff-label">Difficulty</span>
        {#each ["all", ...diffs] as d (d)}
          <button
            class="tre-diffbtn"
            class:active={difficulty === d}
            onclick={() => (difficulty = d)}
          >{diffLabel(d)}</button>
        {/each}
      </div>
      <button class="tre-tool" onclick={collapseAll}>⊟ Collapse</button>
      <button class="tre-tool" onclick={expandAll}>⊞ Expand</button>
      <label class="tre-appr-toggle">
        <input type="checkbox" bind:checked={approvedOnly} />
        Approved only
      </label>
    </div>

    {#each outline as chapter (chapter.key)}
      <h3 class="tre-chapter">{chapter.label}</h3>
      {#each chapter.sections as section (section.key)}
        {@const sClosed = collapsedSections.has(section.key)}
        <section class="tre-section">
          <button
            class="tre-h"
            onclick={() => toggleSection(section.key)}
            aria-expanded={!sClosed}
          >
            <span class="tre-h-caret">{sClosed ? "▸" : "▾"}</span>
            <span class="tre-h-name">{section.label}</span>
            <span class="tre-h-count">{section.nodes.length} save{section.nodes.length === 1 ? "" : "s"}</span>
          </button>
          {#if !sClosed}
            <div class="tre-rows">
              {#if section.nodes.length === 0}
                <p class="tre-empty">
                  {approvedOnly ? "No approved saves here yet." : "No saves captured yet — this beat is still ahead."}
                </p>
              {:else}
                {#each section.nodes as n (n.id)}
                  <div class="tre-row" class:leaf={n.is_leaf}>
                    <div class="tre-info">
                      <span class="tre-line">
                        <span class={`tre-dchip d-${n.difficulty}`}>{diffLabel(n.difficulty)}</span>
                        <span class="tre-label">{n.label}</span>
                        {#if n.is_leaf}<span class="tre-boss">★ boss</span>{/if}
                        {#if n.approval === "approved"}
                          <span class="tre-badge appr" title="Quinn verified this node loads correctly">✓ approved</span>
                        {:else if n.approval === "unapproved"}
                          <span class="tre-badge unappr" title="known broken / superseded — not ready for review">✗ unapproved</span>
                        {:else}
                          <span class="tre-badge unver" title="not yet triaged by Quinn">· unverified</span>
                        {/if}
                      </span>
                      {#if n.decision}<span class="tre-decision">↳ {n.decision}</span>{/if}
                      <span class="tre-meta">
                        {chips(n)}{#if n.web_version} · v{n.web_version}{/if}{#if n.tags?.length} · {n.tags.join(", ")}{/if}
                      </span>
                      {#if n.summary}<span class="tre-summary">{n.summary}</span>{/if}
                    </div>
                    <a class="tre-jump" href={jumpUrl(n)} target="_blank" rel="noopener">Jump ↗</a>
                  </div>
                {/each}
              {/if}
            </div>
          {/if}
        </section>
      {/each}
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
  .tre-lede a { color: #a7f3d0; }
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

  .tre-tools {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    margin: 0 0 1.25rem;
  }
  .tre-diff {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
  }
  .tre-diff-label {
    font-size: 0.72rem;
    color: #6b7280;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-right: 0.15rem;
  }
  .tre-diffbtn {
    background: none;
    border: 1px solid rgba(167, 243, 208, 0.2);
    color: #9ca3af;
    border-radius: 4px;
    padding: 0.2rem 0.55rem;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .tre-diffbtn:hover {
    border-color: rgba(167, 243, 208, 0.45);
    color: #d1d5db;
  }
  .tre-diffbtn.active {
    background: rgba(167, 243, 208, 0.12);
    border-color: rgba(167, 243, 208, 0.55);
    color: #a7f3d0;
    font-weight: 700;
  }
  .tre-tool {
    background: none;
    border: 1px solid rgba(167, 243, 208, 0.25);
    color: #a7f3d0;
    border-radius: 4px;
    padding: 0.25rem 0.6rem;
    font-family: inherit;
    font-size: 0.75rem;
    cursor: pointer;
  }
  .tre-tool:hover {
    background: rgba(167, 243, 208, 0.1);
    border-color: rgba(167, 243, 208, 0.5);
  }
  .tre-appr-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.75rem;
    color: #9ca3af;
    cursor: pointer;
    margin-left: auto;
  }
  .tre-appr-toggle input {
    cursor: pointer;
    accent-color: #34d399;
  }

  .tre-chapter {
    font-size: 0.9rem;
    color: #e5e7eb;
    margin: 1.5rem 0 0.75rem;
    letter-spacing: 0.02em;
  }
  .tre-section {
    margin-bottom: 1.25rem;
  }
  .tre-h {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    border-bottom: 1px solid rgba(167, 243, 208, 0.12);
    color: #a7f3d0;
    font-family: inherit;
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    padding: 0 0 0.35rem;
    margin: 0 0 0.6rem;
    cursor: pointer;
  }
  .tre-h:hover {
    border-bottom-color: rgba(167, 243, 208, 0.4);
  }
  .tre-h-caret {
    color: #6b7280;
  }
  .tre-h-count {
    margin-left: auto;
    color: #6b7280;
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.72rem;
  }
  .tre-rows {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .tre-empty {
    font-size: 0.8rem;
    color: #6b7280;
    font-style: italic;
    padding: 0.3rem 0;
    margin: 0;
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
  .tre-line {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.15rem 0.4rem;
  }
  .tre-dchip {
    font-size: 0.62rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    padding: 0.05rem 0.35rem;
    border-radius: 3px;
    border: 1px solid transparent;
    font-weight: 700;
  }
  .tre-dchip.d-easy {
    color: #34d399;
    background: rgba(52, 211, 153, 0.12);
    border-color: rgba(52, 211, 153, 0.35);
  }
  .tre-dchip.d-med,
  .tre-dchip.d-medium {
    color: #fbbf24;
    background: rgba(251, 191, 36, 0.12);
    border-color: rgba(251, 191, 36, 0.35);
  }
  .tre-dchip.d-hard {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
    border-color: rgba(248, 113, 113, 0.35);
  }
  .tre-label {
    font-size: 0.88rem;
    color: #e5e7eb;
    font-weight: 600;
  }
  .tre-boss {
    color: #fbbf24;
    font-size: 0.72rem;
  }
  .tre-badge {
    font-size: 0.68rem;
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    white-space: nowrap;
    border: 1px solid transparent;
  }
  .tre-badge.appr {
    color: #34d399;
    background: rgba(52, 211, 153, 0.12);
    border-color: rgba(52, 211, 153, 0.4);
  }
  .tre-badge.unappr {
    color: #f87171;
    background: rgba(248, 113, 113, 0.12);
    border-color: rgba(248, 113, 113, 0.4);
  }
  .tre-badge.unver {
    color: #6b7280;
    background: rgba(107, 114, 128, 0.1);
    border-color: rgba(107, 114, 128, 0.25);
  }
  .tre-decision {
    color: #9ca3af;
    font-style: italic;
    font-size: 0.78rem;
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
</style>
