<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import {
    saveCatalogue as cat,
    catalogueActs,
    catalogueJumpUrl,
    type CatalogueNode,
  } from "../lib/saveCatalogue";

  // Same gate as the save-state tree below it: these links boot the debug surface.
  const gated = $derived(
    !(isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend")),
  );

  const acts = catalogueActs(cat);
  // An empty `frontier: {}` means the export has no autoplay run to report —
  // treat it as absent rather than rendering "L?".
  const f = cat.frontier && (cat.frontier.reached_level != null || cat.frontier.reached_scene) ? cat.frontier : null;
  const pct = cat.savable_total ? Math.round((100 * cat.covered) / cat.savable_total) : 0;
  const gaps = cat.nodes.filter((n) => n.status === "gap");
  const skips = cat.nodes.filter((n) => n.status === "skip").length;
  const covered = cat.nodes.filter((n) => n.status === "covered");
  const unpromoted = covered.filter((n) => !catalogueJumpUrl(n));

  // Display state: covered splits on whether the save can actually be loaded.
  type Kind = "jump" | "held" | "next" | "future" | "skip";
  function kind(n: CatalogueNode): Kind {
    if (n.status === "covered") return catalogueJumpUrl(n) ? "jump" : "held";
    if (n.status === "skip") return "skip";
    return n.tier === "next" ? "next" : "future";
  }
  const STATE_LABEL: Record<Kind, string> = {
    jump: "jump ↗",
    held: "captured",
    next: "next",
    future: "later",
    skip: "no save",
  };

  // The frontier ring goes on the grind node autoplay has reached. The
  // catalogue reports a level + scene, not a cond, so match on level within
  // the grind — that's the only act where level varies.
  const grind = acts.find((a) => a.key === "grind");
  const frontierNode =
    f?.reached_level != null ? grind?.nodes.find((n) => n.level === f.reached_level) : undefined;

  function tip(n: CatalogueNode): string {
    const parts = [`cond ${n.cond} · L${n.level}`, n.note];
    if (n.jump) parts.push(`save: ${n.jump.id}${n.jump.scene ? ` (${n.jump.scene})` : ""}`);
    if (kind(n) === "held") parts.push("captured, but not promoted into the shared save tree yet — not loadable on the site");
    return parts.filter(Boolean).join("\n");
  }
</script>

<div class="cat">
  <h2 class="cat-title">{cat.title}</h2>
  <p class="cat-lede">
    Where autoplay has got to on the chain-legal Episode One save chain, and what it is driving toward.
    Click a green node to jump into the game at that save.
  </p>

  {#if gated}
    <p class="cat-note">The save catalogue is <strong>admin / Legend only</strong>.</p>
  {:else if cat.nodes.length === 0}
    <p class="cat-note">No catalogue yet. Run <code>npm run sync:catalogue</code> once Quinn publishes it.</p>
  {:else}
    <div class="cat-summary">
      <span class="cat-big">{cat.covered}</span>
      <span class="cat-den">/ {cat.savable_total} savable nodes captured</span>
      <span class="cat-bar" aria-hidden="true"><i style:width="{pct}%"></i></span>
    </div>

    <div class="cat-legend">
      <span><i class="sw sw-jump"></i> captured · click to jump</span>
      {#if unpromoted.length}<span><i class="sw sw-held"></i> captured · not promoted yet</span>{/if}
      <span><i class="sw sw-next"></i> next target</span>
      <span><i class="sw sw-future"></i> later</span>
      {#if skips}<span><i class="sw sw-skip"></i> save-disabled</span>{/if}
      {#if frontierNode}<span><i class="sw sw-ring"></i> autoplay frontier</span>{/if}
    </div>

    <div class="cat-rail" role="group" aria-label="Episode One save coverage">
      {#each acts as act (act.key)}
        <div class="cat-act">
          <h3>{act.label}</h3>
          <div class="cat-actsub">{act.sub}</div>

          {#if act.key === "story"}
            <div class="cat-strip">
              {#each act.nodes as n (`${n.cond}-${n.level}`)}
                {@const url = catalogueJumpUrl(n)}
                {#if url}
                  <a class="dot k-{kind(n)}" href={url} target="_blank" rel="noopener" title={tip(n)}>
                    <b></b><em>c{n.cond}</em>
                  </a>
                {:else}
                  <span class="dot k-{kind(n)}" title={tip(n)} tabindex="0"><b></b><em>c{n.cond}</em></span>
                {/if}
              {/each}
            </div>
          {:else}
            <div class={act.key === "grind" ? "cat-col" : "cat-row"}>
              {#each act.nodes as n, i (`${n.cond}-${n.level}`)}
                {@const url = catalogueJumpUrl(n)}
                {@const k = kind(n)}
                {#if act.key === "boss" && i > 0}<span class="cat-arrow" aria-hidden="true">→</span>{/if}
                <svelte:element
                  this={url ? "a" : "div"}
                  class="node k-{k}"
                  class:frontier={n === frontierNode}
                  href={url ?? undefined}
                  target={url ? "_blank" : undefined}
                  rel={url ? "noopener" : undefined}
                  title={tip(n)}
                  role={url ? undefined : "note"}
                >
                  <span class="node-tag">c{n.cond} · L{n.level}</span>
                  <span class="node-note">{n.note}</span>
                  <span class="node-state">{STATE_LABEL[k]}</span>
                  {#if n === frontierNode}<span class="node-reached">● autoplay reached here</span>{/if}
                </svelte:element>
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <div class="cat-panels">
      <div class="cat-card">
        <h4>Next to capture</h4>
        {#if gaps.length === 0}
          <p class="cat-muted">Nothing left — every savable node is captured.</p>
        {:else}
          <ul class="cat-list">
            {#each gaps as n (`${n.cond}-${n.level}`)}
              <li>
                <span class="pill k-{kind(n)}">{n.tier === "next" ? "NEXT" : "LATER"}</span>
                <span>c{n.cond} · L{n.level}<small>{n.note}</small></span>
              </li>
            {/each}
          </ul>
        {/if}
      </div>

      {#if f}
        <div class="cat-card">
          <h4>Autoplay frontier</h4>
          <div class="cat-where">L{f.reached_level ?? "?"}</div>
          <div class="cat-wsub">
            {f.reached_scene ?? "—"}{#if f.reached_depth_bfs != null} · BFS depth {f.reached_depth_bfs}{/if}{#if f.status} · {f.status}{/if}
          </div>
          {#if f.note}<p class="cat-fnote">{f.note}</p>{/if}
        </div>
      {/if}

      <div class="cat-card">
        <h4>At a glance</h4>
        <div class="cat-stats">
          <div><b>{cat.covered}</b><span>captured</span></div>
          <div><b>{covered.length - unpromoted.length}</b><span>jumpable</span></div>
          <div><b>{gaps.length}</b><span>gaps</span></div>
          {#if skips}<div><b>{skips}</b><span>save-disabled</span></div>{/if}
        </div>
        {#if unpromoted.length}
          <p class="cat-muted">
            {unpromoted.length} captured save{unpromoted.length === 1 ? " isn't" : "s aren't"} in the shared
            save tree yet, so the site can't load {unpromoted.length === 1 ? "it" : "them"}. Arc promotes them
            into <code>save_tree_manifest.json</code>; they turn clickable on the next <code>sync:scenarios</code>.
          </p>
        {/if}
      </div>
    </div>

    <p class="cat-foot">
      From Quinn's <code>save_catalogue.json</code>{#if cat.as_of} (as of {cat.as_of}){/if} · synced
      {new Date(cat.synced_at).toLocaleString()} · <code>npm run sync:catalogue</code>
    </p>
  {/if}
</div>

<style>
  .cat {
    /* Status colours, local to the panel. The console's own tokens carry the ink. */
    --c-jump: #2f9e58;
    --c-jump-bg: color-mix(in srgb, #2f9e58 14%, var(--panel));
    --c-held: #6f9e80;
    --c-held-bg: color-mix(in srgb, #6f9e80 10%, var(--panel));
    --c-next: #d98a16;
    --c-next-bg: color-mix(in srgb, #d98a16 16%, var(--panel));
    --c-future: #b98a3a;
    --c-future-bg: color-mix(in srgb, #b98a3a 9%, var(--panel));
    --c-skip: #9aa6a3;
    --c-skip-bg: color-mix(in srgb, #9aa6a3 12%, var(--panel));
    --c-frontier: #c6453d;

    max-width: 1100px;
    margin: 2.5rem auto 0;
    padding: 0 1rem;
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  .cat-title {
    font-size: 1rem;
    border-top: 1px solid var(--rule);
    padding-top: 1.5rem;
    margin: 0 0 0.25rem;
  }
  .cat-lede, .cat-muted {
    font-size: 0.85rem;
    color: var(--ink-soft);
    line-height: 1.5;
    margin: 0.25rem 0 1rem;
  }
  .cat code {
    color: var(--crimson);
    background: var(--paperblend);
    padding: 0 0.25rem;
    border-radius: 3px;
  }
  .cat-note {
    background: var(--panel);
    border: 1px solid var(--rule);
    border-radius: 5px;
    padding: 1rem;
    font-size: 0.85rem;
    color: var(--ink-soft);
  }

  .cat-summary { display: flex; align-items: baseline; gap: 0.5rem 0.75rem; flex-wrap: wrap; }
  .cat-big { font-size: 1.8rem; font-weight: 700; line-height: 1; font-variant-numeric: tabular-nums; }
  .cat-den { color: var(--ink-soft); font-size: 0.9rem; }
  .cat-bar {
    flex: 1; min-width: 160px; height: 8px; align-self: center;
    border-radius: 5px; border: 1px solid var(--rule); background: var(--c-skip-bg); overflow: hidden;
  }
  .cat-bar i { display: block; height: 100%; background: var(--c-jump); }

  .cat-legend {
    display: flex; flex-wrap: wrap; gap: 0.35rem 1rem; margin: 0.8rem 0 0;
    font-size: 0.78rem; color: var(--ink-soft);
  }
  .cat-legend span { display: inline-flex; align-items: center; gap: 0.4rem; }
  .sw { width: 12px; height: 12px; border-radius: 3px; flex: none; }
  .sw-jump { background: var(--c-jump); }
  .sw-held { background: var(--c-held-bg); border: 1.5px solid var(--c-held); }
  .sw-next { background: var(--c-next); }
  .sw-future { background: var(--c-future-bg); border: 1.5px dashed var(--c-future); }
  .sw-skip { background: var(--c-skip-bg); border: 1px dashed var(--c-skip); }
  .sw-ring { border: 2px solid var(--c-frontier); border-radius: 50%; }

  .cat-rail {
    margin-top: 1rem; display: flex; overflow-x: auto;
    padding: 1.1rem 0.5rem; background: var(--panel);
    border: 1px solid var(--rule); border-radius: 8px;
  }
  .cat-act { display: flex; flex-direction: column; gap: 0.5rem; padding: 0 0.9rem; min-width: max-content; }
  .cat-act + .cat-act { border-left: 1px dashed var(--rule); }
  .cat-act h3 {
    margin: 0; font-size: 0.68rem; letter-spacing: 0.14em; text-transform: uppercase; color: var(--ink-soft);
  }
  .cat-actsub { font-size: 0.68rem; color: var(--ink-soft); margin-top: -0.4rem; }

  .cat-strip { display: flex; align-items: flex-end; gap: 0.2rem; margin-top: auto; }
  .dot {
    display: flex; flex-direction: column; align-items: center; gap: 0.3rem;
    color: inherit; text-decoration: none; border-radius: 4px; padding: 2px;
  }
  .dot b { width: 18px; height: 18px; border-radius: 50%; display: block; }
  .dot em { font-size: 0.62rem; color: var(--ink-soft); font-style: normal; }
  .dot.k-jump b { background: var(--c-jump); }
  .dot.k-held b { background: var(--c-held-bg); border: 2px solid var(--c-held); }
  .dot.k-skip b { background: var(--c-skip-bg); border: 1px dashed var(--c-skip); }
  .dot.k-next b { background: var(--c-next); }
  .dot.k-future b { background: var(--c-future-bg); border: 1.5px dashed var(--c-future); }
  a.dot:hover b, a.dot:focus-visible b { box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-jump) 35%, transparent); }
  a.dot:hover em { color: var(--ink); }

  .cat-col { display: flex; flex-direction: column-reverse; gap: 0.45rem; } /* L1 at the bottom, climbing */
  .cat-row { display: flex; align-items: center; gap: 0.3rem; margin-top: auto; }
  .cat-arrow { color: var(--ink-soft); }
  .node {
    position: relative; min-width: 132px; max-width: 158px;
    display: flex; flex-direction: column; gap: 1px;
    padding: 0.5rem 0.65rem; border-radius: 7px; border: 1px solid var(--rule);
    background: var(--panel); color: inherit; text-decoration: none;
  }
  .node-tag { font-size: 0.7rem; font-weight: 700; padding-right: 3.6rem; }
  .node-note { font-size: 0.72rem; color: var(--ink-soft); line-height: 1.35; }
  .node-state {
    position: absolute; top: 0.5rem; right: 0.6rem;
    font-size: 0.58rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase;
  }
  .node.k-jump { background: var(--c-jump-bg); border-color: var(--c-jump); }
  .node.k-jump .node-state { color: var(--c-jump); }
  a.node.k-jump:hover, a.node.k-jump:focus-visible {
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-jump) 30%, transparent);
  }
  .node.k-held { background: var(--c-held-bg); border-color: var(--c-held); }
  .node.k-held .node-state { color: var(--c-held); }
  .node.k-next {
    background: var(--c-next-bg); border: 1.5px solid var(--c-next);
    box-shadow: 0 0 0 3px color-mix(in srgb, var(--c-next) 18%, transparent);
  }
  .node.k-next .node-state { color: var(--c-next); }
  .node.k-future { background: var(--c-future-bg); border: 1.5px dashed var(--c-future); }
  .node.k-future .node-state { color: var(--c-future); }
  .node.k-skip { background: var(--c-skip-bg); border: 1px dashed var(--c-skip); }
  .node.frontier { outline: 2px solid var(--c-frontier); outline-offset: 3px; }
  /* Inside the node, not hung off its side: a side label widened the grind
     column enough to push the boss row out of the rail. */
  .node-reached { color: var(--c-frontier); font-size: 0.66rem; font-weight: 700; margin-top: 2px; }
  @media (prefers-reduced-motion: no-preference) {
    .node.frontier { animation: cat-pulse 2.4s ease-in-out infinite; }
    @keyframes cat-pulse {
      50% { outline-color: color-mix(in srgb, var(--c-frontier) 35%, transparent); }
    }
  }

  .cat-panels {
    display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 0.9rem; margin-top: 1rem;
  }
  .cat-card { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; padding: 0.9rem 1rem; }
  .cat-card h4 {
    margin: 0 0 0.6rem; font-size: 0.72rem; letter-spacing: 0.1em; text-transform: uppercase; color: var(--crimson);
  }
  .cat-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.5rem; }
  .cat-list li { display: flex; gap: 0.6rem; align-items: baseline; font-size: 0.85rem; }
  .cat-list small { display: block; color: var(--ink-soft); font-size: 0.75rem; }
  .pill {
    flex: none; font-size: 0.64rem; font-weight: 700; padding: 1px 6px; border-radius: 999px; border: 1px solid;
  }
  .pill.k-next { color: var(--c-next); border-color: var(--c-next); background: var(--c-next-bg); }
  .pill.k-future { color: var(--c-future); border-color: var(--c-future); background: var(--c-future-bg); }
  .cat-where { font-size: 1.4rem; font-weight: 700; color: var(--c-frontier); line-height: 1.1; }
  .cat-wsub { color: var(--ink-soft); font-size: 0.8rem; margin: 0.15rem 0 0.5rem; }
  .cat-fnote { margin: 0; font-size: 0.82rem; line-height: 1.45; }
  .cat-stats { display: flex; gap: 1.1rem; flex-wrap: wrap; }
  .cat-stats b { display: block; font-size: 1.35rem; line-height: 1; font-variant-numeric: tabular-nums; }
  .cat-stats span { font-size: 0.72rem; color: var(--ink-soft); }
  .cat-foot { margin-top: 0.9rem; font-size: 0.72rem; color: var(--ink-soft); }
</style>
