<script lang="ts">
  import type { LeafNode, RunnerTier, TestEntry, StatusClass } from "../lib/testIndex";
  import { statusClass } from "../lib/testIndex";
  import TestRow from "./TestRow.svelte";
  import Self from "./TestLeafNode.svelte";

  interface Props {
    node: LeafNode;
    tier: RunnerTier;
    runningIds: Set<string>;
    statusFilter: Set<string>;
    search: string;
    /** True if this node is the top-level domain in the current column. */
    topLevel?: boolean;
  }

  let { node, tier, runningIds, statusFilter, search, topLevel = false }: Props = $props();

  // Filter direct tests to those matching this column's tier and current filters.
  let directTests = $derived(
    node.tests.filter((t) => {
      if (t.tier !== tier) return false;
      if (statusFilter.size > 0) {
        // status chip filter: match on status OR "running" when applicable
        const isRunning = runningIds.has(t.id);
        const ok =
          (isRunning && statusFilter.has("running")) || statusFilter.has(t.status);
        if (!ok) return false;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!t.id.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) {
          return false;
        }
      }
      return true;
    })
  );

  // Recursively count visible tests (this leaf + descendants) for the current tier + filters.
  function countVisible(n: LeafNode): number {
    let c = 0;
    for (const t of n.tests) {
      if (t.tier !== tier) continue;
      if (statusFilter.size > 0) {
        const isRunning = runningIds.has(t.id);
        if (!((isRunning && statusFilter.has("running")) || statusFilter.has(t.status))) continue;
      }
      if (search) {
        const q = search.toLowerCase();
        if (!t.id.toLowerCase().includes(q) && !t.name.toLowerCase().includes(q)) continue;
      }
      c++;
    }
    for (const child of n.children) c += countVisible(child);
    return c;
  }

  let visibleCount = $derived(countVisible(node));
  let ownTierTests = $derived(node.tests.filter((t) => t.tier === tier).length);
  let hasDescendantTests = $derived(
    node.children.some((c) => {
      const walk = (x: LeafNode): boolean => {
        if (x.tests.some((t) => t.tier === tier)) return true;
        return x.children.some(walk);
      };
      return walk(c);
    })
  );
  let isEmptyForTier = $derived(ownTierTests === 0 && !hasDescendantTests);

  // Aggregate status rollup across THIS leaf's subtree for the current tier.
  // Ignores the filter chips and search — the rollup always reflects the real
  // state of the section so a glance at the header row reveals attention-worthy
  // leaves regardless of what's currently filtered.
  interface Rollup {
    pass: number;
    fail: number;
    xfail: number;
    skip: number;
    unknown: number;
    running: number;
    total: number;
  }

  function rollup(n: LeafNode): Rollup {
    const r: Rollup = { pass: 0, fail: 0, xfail: 0, skip: 0, unknown: 0, running: 0, total: 0 };
    for (const t of n.tests) {
      if (t.tier !== tier) continue;
      r.total++;
      if (runningIds.has(t.id)) {
        r.running++;
        continue;
      }
      const cls = statusClass(t.status);
      if (cls in r) (r as any)[cls]++;
    }
    for (const c of n.children) {
      const child = rollup(c);
      r.pass += child.pass;
      r.fail += child.fail;
      r.xfail += child.xfail;
      r.skip += child.skip;
      r.unknown += child.unknown;
      r.running += child.running;
      r.total += child.total;
    }
    return r;
  }

  let rollupData = $derived(rollup(node));

  /** Worst-case dot color that represents the section's overall health. */
  function worstClass(r: Rollup): StatusClass {
    if (r.running > 0) return "running";
    if (r.fail > 0) return "fail";
    if (r.xfail > 0) return "xfail";
    if (r.pass > 0 && r.fail === 0) return "pass";
    if (r.total === 0) return "unknown";
    if (r.skip > 0 && r.pass === 0) return "skip";
    return "unknown";
  }

  let headerClass = $derived(worstClass(rollupData));

  function priorityTooltip(p: string): string {
    switch (p) {
      case "P0":
        return "Priority 0 — critical. Core gameplay must work.";
      case "P1":
        return "Priority 1 — high. Important feature, not critical path.";
      case "B":
        return "Backlog — lower priority. Valuable coverage, not blocking ship.";
      default:
        return `Priority: ${p}`;
    }
  }

  // Coverage bar numbers come from leaves[] meta (total across all tiers).
  let covered = $derived(node.meta?.covered ?? 0);
  let planned = $derived(node.meta?.planned ?? 0);
  let blocked = $derived(node.meta?.blocked ?? 0);
  let total = $derived(Math.max(covered + planned + blocked, 1));
  let coveredPct = $derived((covered / total) * 100);
  let blockedPct = $derived((blocked / total) * 100);
</script>

<details class="leaf" class:top={topLevel} class:empty={isEmptyForTier} open={topLevel}>
  <summary>
    <span class="arrow" aria-hidden="true"></span>
    <span class="header-dot dot-{headerClass}" aria-hidden="true">
      {#if headerClass === "running"}<span class="header-spinner"></span>{/if}
    </span>
    <span class="leaf-name">{topLevel ? node.segment : node.path.split(".").slice(-1)[0]}</span>
    {#if node.meta?.priority}
      <span
        class="priority priority-{node.meta.priority.toLowerCase()}"
        title={priorityTooltip(node.meta.priority)}
      >{node.meta.priority}</span>
    {/if}
    <span class="rollup">
      {#if rollupData.pass > 0}<span class="r-pass" title="{rollupData.pass} passing">✓{rollupData.pass}</span>{/if}
      {#if rollupData.fail > 0}<span class="r-fail" title="{rollupData.fail} failing">✗{rollupData.fail}</span>{/if}
      {#if rollupData.xfail > 0}<span class="r-xfail" title="{rollupData.xfail} expected failure (xfail/xpass — documented known issue)">◉{rollupData.xfail}</span>{/if}
      {#if rollupData.skip > 0}<span class="r-skip" title="{rollupData.skip} skipped">◌{rollupData.skip}</span>{/if}
      {#if rollupData.unknown > 0}<span class="r-unknown" title="{rollupData.unknown} never run in a tracked session">?{rollupData.unknown}</span>{/if}
      {#if rollupData.running > 0}<span class="r-running" title="{rollupData.running} currently running">●{rollupData.running}</span>{/if}
    </span>
    {#if visibleCount !== rollupData.total}
      <span class="filtered-count" title="visible after filters">({visibleCount})</span>
    {/if}
    {#if node.meta && (covered + planned + blocked > 0)}
      <span class="bar" title="{covered} covered, {planned} planned, {blocked} blocked">
        <span class="bar-covered" style="width: {coveredPct}%"></span>
        <span class="bar-blocked" style="width: {blockedPct}%"></span>
      </span>
    {/if}
  </summary>
  {#if node.meta?.description}
    <div class="desc">{node.meta.description}</div>
  {/if}
  <div class="tests">
    {#each directTests as test, i (test.id + "|" + i)}
      <TestRow {test} isRunning={runningIds.has(test.id)} />
    {/each}
    {#if directTests.length === 0 && ownTierTests === 0 && !hasDescendantTests}
      <div class="empty-leaf">(no tests at this tier)</div>
    {/if}
  </div>
  {#if node.children.length > 0}
    <div class="children">
      {#each node.children as child (child.path)}
        <Self node={child} {tier} {runningIds} {statusFilter} {search} />
      {/each}
    </div>
  {/if}
</details>

<style>
  .leaf {
    border-left: 2px solid rgba(167, 243, 208, 0.12);
    margin: 0.2rem 0 0.2rem 0.3rem;
    padding-left: 0.55rem;
  }
  .leaf.top {
    border-left: 3px solid rgba(167, 243, 208, 0.35);
    margin-left: 0;
    padding: 0.4rem 0 0.4rem 0.65rem;
  }
  .leaf.empty > summary .leaf-name { color: #6b7280; }
  summary {
    list-style: none;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.3rem 0.25rem;
    cursor: pointer;
    font-family: "Courier New", monospace;
    color: #e5e7eb;
    border-radius: 3px;
    user-select: none;
  }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: rgba(167, 243, 208, 0.04); }
  .arrow::before {
    content: "▸";
    color: #a7f3d0;
    font-size: 0.75rem;
    display: inline-block;
    transition: transform 0.15s;
  }
  .leaf[open] > summary .arrow::before { transform: rotate(90deg); }
  .leaf-name {
    font-weight: 600;
    font-size: 0.9rem;
  }
  .leaf.top > summary .leaf-name {
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: #a7f3d0;
  }
  .priority {
    font-size: 0.65rem;
    font-weight: 700;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    cursor: help;
  }
  .priority-p0 { background: rgba(248, 113, 113, 0.18); color: #fca5a5; border: 1px solid rgba(248, 113, 113, 0.4); }
  .priority-p1 { background: rgba(251, 191, 36, 0.18); color: #fcd34d; border: 1px solid rgba(251, 191, 36, 0.4); }
  .priority-b { background: rgba(96, 165, 250, 0.18); color: #93c5fd; border: 1px solid rgba(96, 165, 250, 0.4); }
  .header-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    display: inline-block;
    position: relative;
    flex-shrink: 0;
  }
  .header-dot.dot-pass { background: #a7f3d0; }
  .header-dot.dot-fail { background: #f87171; box-shadow: 0 0 6px rgba(248, 113, 113, 0.6); }
  .header-dot.dot-xfail { background: transparent; border: 1.5px solid #fbbf24; }
  .header-dot.dot-skip { background: transparent; border: 1.5px solid #6b7280; }
  .header-dot.dot-unknown { background: transparent; border: 1.5px dashed rgba(255, 255, 255, 0.22); }
  .header-dot.dot-running { background: transparent; border: 1.5px solid #a7f3d0; }
  .header-spinner {
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: #a7f3d0;
    animation: header-spin 0.9s linear infinite;
  }
  @keyframes header-spin { to { transform: rotate(360deg); } }

  .rollup {
    display: inline-flex;
    gap: 0.35rem;
    font-size: 0.68rem;
    margin-left: auto;
    font-family: "Courier New", monospace;
    white-space: nowrap;
  }
  .rollup span { padding: 0.05rem 0.25rem; border-radius: 2px; cursor: help; }
  .r-pass { color: #a7f3d0; background: rgba(167, 243, 208, 0.08); }
  .r-fail { color: #fca5a5; background: rgba(248, 113, 113, 0.12); font-weight: 700; }
  .r-xfail { color: #fcd34d; background: rgba(251, 191, 36, 0.08); }
  .r-skip { color: #9ca3af; background: rgba(156, 163, 175, 0.06); }
  .r-unknown { color: #6b7280; }
  .r-running { color: #a7f3d0; background: rgba(167, 243, 208, 0.15); font-weight: 700; }
  .filtered-count {
    font-size: 0.65rem;
    color: #6b7280;
    font-style: italic;
  }
  .bar {
    width: 60px;
    height: 4px;
    background: rgba(255, 255, 255, 0.06);
    border-radius: 3px;
    display: flex;
    overflow: hidden;
    flex-shrink: 0;
  }
  .bar-covered { background: #a7f3d0; }
  .bar-blocked { background: #f87171; }
  .desc {
    font-size: 0.72rem;
    color: #9ca3af;
    margin: 0.15rem 0 0.3rem 1.2rem;
    font-style: italic;
    line-height: 1.3;
  }
  .tests {
    padding: 0 0 0 1.2rem;
  }
  .empty-leaf {
    color: #4b5563;
    font-size: 0.72rem;
    font-style: italic;
    padding: 0.2rem 0.6rem;
  }
  .children {
    padding-left: 0.6rem;
  }
</style>
