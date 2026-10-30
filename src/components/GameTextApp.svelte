<script lang="ts">
  // Game Text store (bead mak7p): every editable line of game text in its
  // CURRENT in-game state, with a propose → review → apply loop. Replaces the
  // Dialogue, Vignettes and Cards tabs once Arc's real export lands. Contract +
  // status rules live in src/lib/gameText.ts.
  import { onMount } from "svelte";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import gameVersion from "../data/game-version.json";
  import {
    cardEntries, normaliseEntry, parseNdjson, resolveProposals, textHash,
    contextLine, groupTitle, KIND_LABEL, OWNING_LEAD, STATUS_LABEL,
    type TextEntry, type TextKind, type Proposal, type Review, type ResolvedProposal,
    type GameTextExport,
  } from "../lib/gameText";

  const DEV = import.meta.env.DEV;
  // Dev reads Arc's tools/ straight off the Chronicles mount. The sample is the
  // fixture we build against until extract_game_text.py ships the real export.
  const EXPORT_URLS = ["/test-data/tools/game_text.json", "/test-data/tools/game_text.sample.json"];
  const PROPOSALS_URL = "/test-data/tools/game_text_proposals.ndjson";
  const REVIEWS_URL = "/test-data/tools/game_text_reviews.ndjson";
  const WRITE_URL = "/api/game-text/";

  const allowed = $derived(isAdmin(auth.currentUser) || DEV);

  let entries = $state<TextEntry[]>([]);
  let resolved = $state<ResolvedProposal[]>([]);
  let exportSource = $state<string>("");
  let exportVersion = $state<string>("");
  let loading = $state(true);
  let error = $state<string | null>(null);

  let kind = $state<"all" | TextKind>("all");
  let query = $state("");
  let onlyProposed = $state(false);
  let editing = $state<string | null>(null);
  let draft = $state("");
  let busy = $state(false);

  async function fetchText(url: string): Promise<string | null> {
    try {
      const r = await fetch(url, { cache: "no-store" });
      // The dev proxy and the prod SPA fallback both answer a missing file with
      // HTML; never parse that as data.
      if (!r.ok || (r.headers.get("content-type") ?? "").includes("text/html")) return null;
      return await r.text();
    } catch { return null; }
  }

  async function load() {
    loading = true;
    error = null;
    try {
      let exp: GameTextExport | null = null;
      if (DEV) {
        for (const u of EXPORT_URLS) {
          const raw = await fetchText(u);
          if (raw) { exp = JSON.parse(raw); exportSource = u.split("/").pop()!; break; }
        }
      }
      // Cards are App's half of the export, built from the shipping source.
      // Arc's export may carry a card stub; ours always wins.
      const game = (exp?.entries ?? []).filter((e) => e.kind !== "card").map(normaliseEntry);
      exportVersion = exp?.game_version ?? gameVersion.version ?? "";
      const cards = await cardEntries(exportVersion);
      entries = [...game, ...cards];
      const [pr, rv] = DEV ? await Promise.all([fetchText(PROPOSALS_URL), fetchText(REVIEWS_URL)]) : [null, null];
      resolved = await resolveProposals(entries, parseNdjson<Proposal>(pr ?? ""), parseNdjson<Review>(rv ?? ""));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function post(body: Record<string, unknown>) {
    busy = true;
    try {
      const r = await fetch(WRITE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
      await load();
      return true;
    } catch (e) {
      error = `Couldn't save: ${e instanceof Error ? e.message : e}`;
      return false;
    } finally {
      busy = false;
    }
  }

  async function propose(e: TextEntry) {
    if (!draft || draft === e.text) return;
    if (await post({ type: "proposal", text_id: e.id, base_hash: e.hash, proposed: draft, author: "owner" })) {
      editing = null;
      draft = "";
    }
  }

  function verdict(p: ResolvedProposal, v: "approve" | "change" | "reject") {
    const note = v === "approve" ? "" : (prompt(v === "reject" ? "Why reject?" : "What should change?") ?? "");
    return post({ type: "review", proposal_id: p.proposal_id, reviewer: "owner", verdict: v, note });
  }

  // ---- view model -----------------------------------------------------------
  const byEntry = $derived.by(() => {
    const m = new Map<string, ResolvedProposal[]>();
    for (const p of resolved) {
      if (!p.entry || p.status === "stale") continue;
      (m.get(p.entry.id) ?? m.set(p.entry.id, []).get(p.entry.id)!).push(p);
    }
    for (const list of m.values()) list.sort((a, b) => b.ts.localeCompare(a.ts));
    return m;
  });
  const stale = $derived(resolved.filter((p) => p.status === "stale"));
  const openCount = $derived(resolved.filter((p) => ["pending", "changes", "approved"].includes(p.status)).length);
  const kindCounts = $derived.by(() => {
    const c: Record<string, number> = { all: entries.length };
    for (const e of entries) c[e.kind] = (c[e.kind] ?? 0) + 1;
    return c;
  });

  const groups = $derived.by(() => {
    const q = query.trim().toLowerCase();
    const keep = entries.filter((e) =>
      (kind === "all" || e.kind === kind) &&
      (!onlyProposed || byEntry.has(e.id)) &&
      (!q || e.text.toLowerCase().includes(q) || groupTitle(e).toLowerCase().includes(q)),
    );
    const m = new Map<string, TextEntry[]>();
    for (const e of keep) (m.get(e.group) ?? m.set(e.group, []).get(e.group)!).push(e);
    return [...m.values()].map((es) => es.sort((a, b) => a.order - b.order));
  });

  const KINDS: ("all" | TextKind)[] = ["all", "dialogue", "ambient", "vignette", "card"];
  const fmt = (ts: string) => new Date(ts).toLocaleString();
</script>

<div class="gt">
  <h1 class="gt-title">Game Text</h1>
  <p class="gt-lede">
    Every editable line of game text, as it currently reads in the game. Propose an edit on any line;
    it is reviewed by Arc, App, Quinn or Rowan, and the line's owner applies it — Arc for dialogue,
    ambient and vignettes, App for loading cards. A proposal closes itself once the game carries the new text.
  </p>

  {#if !allowed}
    <p class="gt-note">Game Text is <strong>admin only</strong>.</p>
  {:else if loading && entries.length === 0}
    <p class="gt-note">Loading…</p>
  {:else}
    {#if error}<p class="gt-err" role="alert">{error}</p>{/if}
    {#if !DEV}
      <p class="gt-note">
        On the live site this tab shows loading cards only, read-only. Game lines and proposals arrive
        once Arc's export is synced to the dialogue-overlay store; until then edit from the local console.
      </p>
    {:else if exportSource === "game_text.sample.json"}
      <p class="gt-note">
        Showing Arc's <strong>sample</strong> export — <code>tools/game_text.json</code> isn't generated yet.
      </p>
    {:else if !exportSource}
      <p class="gt-note">No game export found in <code>tools/</code> — showing loading cards only.</p>
    {/if}

    <div class="gt-tools">
      <div class="gt-kinds" role="group" aria-label="Text kind">
        {#each KINDS as k (k)}
          {#if k === "all" || kindCounts[k]}
            <button class="gt-kind" class:active={kind === k} onclick={() => (kind = k)}>
              {k === "all" ? "All" : KIND_LABEL[k]} <span>{kindCounts[k] ?? 0}</span>
            </button>
          {/if}
        {/each}
      </div>
      <input class="gt-search" type="search" placeholder="Search text or speaker…" bind:value={query} aria-label="Search" />
      <label class="gt-check"><input type="checkbox" bind:checked={onlyProposed} /> With proposals</label>
      <span class="gt-meta">
        {openCount} open proposal{openCount === 1 ? "" : "s"}{#if exportVersion} · game v{exportVersion}{/if}
      </span>
    </div>

    {#if stale.length}
      <section class="gt-stale">
        <h2>Stale proposals ({stale.length})</h2>
        <p class="gt-muted">The line changed in the game after these were written, so they won't be applied. Re-propose against the current text if still wanted.</p>
        {#each stale as p (p.proposal_id)}
          <div class="gt-prop k-stale">
            <code>{p.text_id}</code>
            <div class="gt-new">{p.proposed}</div>
            <span class="gt-by">{p.author} · {fmt(p.ts)}</span>
          </div>
        {/each}
      </section>
    {/if}

    {#if groups.length === 0}
      <p class="gt-note">Nothing matches.</p>
    {/if}

    {#each groups as g (g[0].group)}
      <section class="gt-group">
        <h2 class="gt-gh">
          <span class="gt-kchip k-{g[0].kind}">{KIND_LABEL[g[0].kind]}</span>
          {groupTitle(g[0])}
        </h2>
        {#each g as e (e.id)}
          {@const props = byEntry.get(e.id) ?? []}
          <div class="gt-line">
            <div class="gt-row">
              <div class="gt-text">
                <p>{e.text}</p>
                <span class="gt-ctx">{contextLine(e)}</span>
              </div>
              {#if DEV && editing !== e.id}
                <button class="gt-btn" onclick={() => { editing = e.id; draft = e.text; }}>Propose edit</button>
              {/if}
            </div>

            {#if editing === e.id}
              <div class="gt-edit">
                <textarea bind:value={draft} rows="3" aria-label="Proposed text"></textarea>
                <div class="gt-edit-bar">
                  <span class="gt-muted">Reviewed, then applied by {OWNING_LEAD[e.kind] === "app" ? "App" : "Arc"}.</span>
                  <button class="gt-btn" onclick={() => (editing = null)} disabled={busy}>Cancel</button>
                  <button class="gt-btn primary" onclick={() => propose(e)} disabled={busy || !draft || draft === e.text}>Submit proposal</button>
                </div>
              </div>
            {/if}

            {#each props as p (p.proposal_id)}
              <div class="gt-prop k-{p.status}">
                <div class="gt-prop-head">
                  <span class="gt-status">{STATUS_LABEL[p.status]}</span>
                  <span class="gt-by">{p.author} · {fmt(p.ts)}{#if p.reanchored} · followed the line after a reorder{/if}</span>
                </div>
                {#if p.status !== "applied"}<div class="gt-new">{p.proposed}</div>{/if}
                {#each p.reviews as r (r.ts + r.reviewer)}
                  <div class="gt-review"><b>{r.reviewer}</b> {r.verdict}{#if r.note} — {r.note}{/if}</div>
                {/each}
                {#if DEV && ["pending", "changes"].includes(p.status)}
                  <div class="gt-prop-bar">
                    <button class="gt-btn" onclick={() => verdict(p, "approve")} disabled={busy}>Approve</button>
                    <button class="gt-btn" onclick={() => verdict(p, "change")} disabled={busy}>Request changes</button>
                    <button class="gt-btn" onclick={() => verdict(p, "reject")} disabled={busy}>Reject</button>
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/each}
      </section>
    {/each}
  {/if}
</div>

<style>
  .gt {
    max-width: 960px;
    margin: 0 auto;
    padding: 1.25rem 1rem 3rem;
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  .gt-title { font-size: 1.3rem; margin: 0 0 0.3rem; }
  .gt-lede, .gt-muted { font-size: 0.85rem; color: var(--ink-soft); line-height: 1.5; margin: 0 0 1rem; }
  .gt code { color: var(--crimson); background: var(--paperblend); padding: 0 0.25rem; border-radius: 3px; font-size: 0.8em; }
  .gt-note, .gt-err {
    background: var(--panel); border: 1px solid var(--rule); border-radius: 5px;
    padding: 0.7rem 0.9rem; font-size: 0.85rem; color: var(--ink-soft); margin: 0 0 1rem;
  }
  .gt-err { color: var(--crimson); border-color: var(--crimson); }

  .gt-tools { display: flex; flex-wrap: wrap; align-items: center; gap: 0.5rem 0.75rem; margin: 0 0 1.25rem; }
  .gt-kinds { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .gt-kind, .gt-btn {
    background: none; border: 1px solid var(--rule); color: var(--ink-soft); border-radius: 4px;
    padding: 0.25rem 0.6rem; font: inherit; font-size: 0.78rem; cursor: pointer;
  }
  .gt-kind span { opacity: 0.7; margin-left: 0.2rem; font-variant-numeric: tabular-nums; }
  .gt-kind.active { background: var(--paperblend); color: var(--crimson); font-weight: 700; }
  .gt-btn:hover:not(:disabled), .gt-kind:hover { color: var(--ink); }
  .gt-btn:disabled { opacity: 0.5; cursor: default; }
  .gt-btn.primary { color: var(--crimson); border-color: var(--crimson); font-weight: 700; }
  .gt-search {
    flex: 1; min-width: 160px; font: inherit; font-size: 0.85rem; padding: 0.3rem 0.5rem;
    border: 1px solid var(--rule); border-radius: 4px; background: var(--panel); color: var(--ink);
  }
  .gt-check { font-size: 0.8rem; color: var(--ink-soft); display: inline-flex; gap: 0.3rem; align-items: center; }
  .gt-meta { font-size: 0.78rem; color: var(--ink-soft); }

  .gt-group { margin: 0 0 1.4rem; }
  .gt-gh {
    font-size: 0.9rem; margin: 0 0 0.5rem; padding-bottom: 0.3rem; border-bottom: 1px solid var(--rule);
    display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap;
  }
  .gt-kchip {
    font-size: 0.62rem; letter-spacing: 0.06em; text-transform: uppercase; font-weight: 700;
    padding: 1px 6px; border-radius: 999px; border: 1px solid var(--rule); color: var(--ink-soft);
  }
  .gt-line { padding: 0.45rem 0; border-bottom: 1px dashed var(--rule); }
  .gt-row { display: flex; gap: 0.75rem; align-items: flex-start; }
  .gt-text { flex: 1; min-width: 0; }
  .gt-text p { margin: 0; font-size: 0.92rem; line-height: 1.45; overflow-wrap: anywhere; }
  .gt-ctx { font-size: 0.72rem; color: var(--ink-soft); }

  .gt-edit { margin: 0.5rem 0 0.2rem; }
  .gt-edit textarea {
    width: 100%; box-sizing: border-box; font: inherit; font-size: 0.9rem; padding: 0.45rem;
    border: 1px solid var(--crimson); border-radius: 4px; background: var(--panel); color: var(--ink);
  }
  .gt-edit-bar, .gt-prop-bar { display: flex; gap: 0.4rem; align-items: center; justify-content: flex-end; flex-wrap: wrap; margin-top: 0.35rem; }
  .gt-edit-bar .gt-muted { margin: 0 auto 0 0; font-size: 0.75rem; }

  .gt-prop {
    margin: 0.45rem 0 0 1rem; padding: 0.45rem 0.65rem; border-left: 3px solid var(--rule);
    background: var(--panel); border-radius: 0 4px 4px 0; font-size: 0.82rem;
  }
  .gt-prop-head { display: flex; gap: 0.6rem; flex-wrap: wrap; align-items: baseline; }
  .gt-status { font-size: 0.66rem; font-weight: 700; letter-spacing: 0.06em; text-transform: uppercase; }
  .gt-by { font-size: 0.72rem; color: var(--ink-soft); }
  .gt-new { margin: 0.25rem 0; font-size: 0.9rem; overflow-wrap: anywhere; }
  .gt-new::before { content: "→ "; color: var(--ink-soft); }
  .gt-review { font-size: 0.76rem; color: var(--ink-soft); }
  .k-pending { border-left-color: #d98a16; } .k-pending .gt-status { color: #b8730f; }
  .k-changes { border-left-color: #c6453d; } .k-changes .gt-status { color: #c6453d; }
  .k-approved { border-left-color: #2f9e58; } .k-approved .gt-status { color: #2f9e58; }
  .k-applied { border-left-color: #2f9e58; opacity: 0.75; } .k-applied .gt-status { color: #2f9e58; }
  .k-rejected, .k-stale { border-left-color: #9aa6a3; opacity: 0.75; } .k-rejected .gt-status { color: var(--ink-soft); }
  .gt-stale { margin: 0 0 1.5rem; }
  .gt-stale h2 { font-size: 0.9rem; margin: 0 0 0.3rem; }
  .gt-stale .gt-prop { margin-left: 0; }
</style>
