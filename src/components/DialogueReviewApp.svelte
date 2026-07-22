<script lang="ts">
  // Dialogue review/edit UI (owner tool). Foldable Zone → NPC → dialogue; expand a
  // dialogue to edit its lines and Save. Reads Arc's dialogue_review.json live via
  // the dev chroniclesProxy; writes the edited lines into dialogue_overrides.json
  // (the overlay Arc applies to core_Dialogue.json — App never touches the core).
  // DEV-ONLY write: the POST endpoint exists only on the local :4321 server + CoN
  // mount, so in prod this page is read-only. Contract: CON_CLAUDE_DIALOGUE_REVIEW_UI.md.
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";

  // Env-aware. DEV: local proxy read + dev write middleware — edits land in the
  // local game repo Arc reads directly. PROD: the admin-gated cloud stack
  // (allbyte-studio-dialogue-overlay) — edits queue in S3, and App's
  // `npm run sync:dialogue` bridge pulls them into the local overlay for Arc.
  const DEV = import.meta.env.DEV;
  const API = "https://c4fuvlxdsj.execute-api.us-east-1.amazonaws.com";
  const REVIEW_URL = DEV ? "/test-data/tools/dialogue_review.json" : `${API}/review`;
  const OVERRIDES_URL = DEV ? "/test-data/tools/dialogue_overrides.json" : `${API}/overrides`;
  const AMBIENT_OVERRIDES_URL = DEV ? "/test-data/tools/ambient_overrides.json" : `${API}/ambient-overrides`;
  // Dev paths keep a trailing slash (trailingSlash:"always" 404s the bare path).
  const SAVE_URL = DEV ? "/api/dialogue-override/" : `${API}/override`;
  const AMBIENT_SAVE_URL = DEV ? "/api/ambient-override/" : `${API}/ambient-override`;
  function authHeaders(): Record<string, string> {
    return DEV ? {} : { Authorization: `Bearer ${auth.authToken}` };
  }

  interface Dialogue {
    id: number;
    scene?: string;
    npc?: string;
    context_label?: string;
    has_options?: boolean;
    lines?: string[];
    dialogue_raw?: string;
    // Source-file origin (Arc's extractor): owner = core_Dialogue.json,
    // arc = core_NpcAmbientDialogue.json (Claude-written ambient variants).
    origin?: "owner" | "arc";
    // Arc/ambient rows carry a different shape (situation -> variants); Phase 2
    // renders + edits them via a separate ambient overlay. Shown read-only for now.
    situation_key?: string;
    situation_label?: string;
    variants?: string[][];
  }
  interface Npc {
    scenes?: string[];
    dialogues: Dialogue[];
  }
  interface ReviewData {
    schema_version?: number;
    scope?: string[];
    zones: Record<string, { npcs: Record<string, Npc> }>;
    stats?: { total_dialogues?: number; emitted?: number; hidden_junk?: number };
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<ReviewData | null>(null);
  let overrides = $state<Record<string, { lines?: string[] }>>({});
  // Arc/ambient overlay: npc -> situation_id -> { variants }
  let ambientOverrides = $state<Record<string, Record<string, { variants?: string[] }>>>({});
  let drafts = $state<Record<string, string>>({});
  let saving = $state<Record<string, boolean>>({});
  // Origin filter. Owner primarily edits Arc-generated, so load() defaults this to
  // "arc" when arc rows are present, else "all". "owner" bucket = owner + unknown.
  let filter = $state<"all" | "arc" | "owner">("all");
  function matchesFilter(d: Dialogue): boolean {
    if (filter === "all") return true;
    if (filter === "arc") return d.origin === "arc";
    return d.origin !== "arc";
  }

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  // Fold state: zone/NPC default OPEN (collapse to close); dialogues default CLOSED (open to edit).
  const closedGroups = new SvelteSet<string>();
  const openDialogues = new SvelteSet<string>();

  function allDialogues(d: ReviewData): Dialogue[] {
    const out: Dialogue[] = [];
    for (const zone of Object.values(d.zones ?? {}))
      for (const npc of Object.values(zone.npcs ?? {}))
        for (const dl of npc.dialogues ?? []) out.push(dl);
    return out;
  }

  // Unified per-row key: owner rows key by id, arc rows by (npc, situation_id).
  function rowKey(d: Dialogue): string {
    return d.origin === "arc" ? `a:${d.npc}/${d.situation_id}` : `o:${d.id}`;
  }
  // Current base content = the override if one exists, else the source lines/variants.
  function baseArray(d: Dialogue): string[] {
    if (d.origin === "arc") {
      const ov = ambientOverrides[d.npc ?? ""]?.[d.situation_id ?? ""];
      return ov?.variants ?? d.variants ?? [];
    }
    const ov = overrides[String(d.id)];
    return ov?.lines ?? d.lines ?? [];
  }
  function baseText(d: Dialogue): string {
    return baseArray(d).join("\n");
  }
  function isEdited(d: Dialogue): boolean {
    if (d.origin === "arc") return ambientOverrides[d.npc ?? ""]?.[d.situation_id ?? ""] != null;
    return overrides[String(d.id)] != null;
  }
  function isDirty(d: Dialogue): boolean {
    const k = rowKey(d);
    return k in drafts && drafts[k] !== baseText(d);
  }

  function seedDrafts() {
    if (!data) return;
    const seeded: Record<string, string> = {};
    for (const d of allDialogues(data)) seeded[rowKey(d)] = baseText(d);
    drafts = seeded;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const r = await fetch(REVIEW_URL, { cache: "no-store", headers: authHeaders() });
      if (!r.ok) throw new Error(`review ${r.status} ${r.statusText}`);
      const txt = await r.text();
      try {
        data = JSON.parse(txt) as ReviewData;
      } catch {
        throw new Error("dialogue_review.json didn't parse as JSON — is the source reachable?");
      }
      // Overrides: absent/empty = no pending edits (not an error).
      try {
        const o = await fetch(OVERRIDES_URL, { cache: "no-store", headers: authHeaders() });
        if (o.ok) {
          const t = (await o.text()).trim();
          overrides = t ? JSON.parse(t) : {};
        } else overrides = {};
      } catch {
        overrides = {};
      }
      // Arc/ambient overlay — absent/empty = no pending edits.
      try {
        const a = await fetch(AMBIENT_OVERRIDES_URL, { cache: "no-store", headers: authHeaders() });
        if (a.ok) {
          const t = (await a.text()).trim();
          ambientOverrides = t ? JSON.parse(t) : {};
        } else ambientOverrides = {};
      } catch {
        ambientOverrides = {};
      }
      seedDrafts();
      // Default to Arc-generated when it's present (what the owner primarily edits).
      filter = allDialogues(data).some((d) => d.origin === "arc") ? "arc" : "all";
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    if (!isAdmin(auth.currentUser)) {
      loading = false;
      return;
    }
    await load();
  });

  function toDraftLines(text: string): string[] {
    const lines = text.split("\n");
    // drop trailing blank rows (a stray newline at the end), keep internal ones
    while (lines.length > 1 && lines[lines.length - 1].trim() === "") lines.pop();
    return lines;
  }

  async function save(d: Dialogue) {
    const k = rowKey(d);
    const arr = toDraftLines(drafts[k] ?? baseText(d));
    saving = { ...saving, [k]: true };
    try {
      if (d.origin === "arc") {
        const npc = d.npc ?? "", sit = d.situation_id ?? "";
        const r = await fetch(AMBIENT_SAVE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ npc, situation_id: sit, variants: arr }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error ?? `${r.status}`);
        }
        ambientOverrides = {
          ...ambientOverrides,
          [npc]: { ...(ambientOverrides[npc] ?? {}), [sit]: { variants: arr } },
        };
      } else {
        const r = await fetch(SAVE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ id: d.id, lines: arr }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error ?? `${r.status}`);
        }
        overrides = { ...overrides, [String(d.id)]: { lines: arr } };
      }
      drafts = { ...drafts, [k]: arr.join("\n") };
    } catch (e: any) {
      alert(`Save failed: ${e?.message ?? e}`);
    } finally {
      saving = { ...saving, [k]: false };
    }
  }

  async function revert(d: Dialogue) {
    const k = rowKey(d);
    saving = { ...saving, [k]: true };
    try {
      if (d.origin === "arc") {
        const npc = d.npc ?? "", sit = d.situation_id ?? "";
        const r = await fetch(AMBIENT_SAVE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ npc, situation_id: sit, revert: true }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error ?? `${r.status}`);
        }
        const copy = { ...ambientOverrides, [npc]: { ...(ambientOverrides[npc] ?? {}) } };
        delete copy[npc][sit];
        if (Object.keys(copy[npc]).length === 0) delete copy[npc];
        ambientOverrides = copy;
        drafts = { ...drafts, [k]: (d.variants ?? []).join("\n") };
      } else {
        const r = await fetch(SAVE_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...authHeaders() },
          body: JSON.stringify({ id: d.id, revert: true }),
        });
        if (!r.ok) {
          const e = await r.json().catch(() => ({}));
          throw new Error(e.error ?? `${r.status}`);
        }
        const no = { ...overrides };
        delete no[String(d.id)];
        overrides = no;
        drafts = { ...drafts, [k]: (d.lines ?? []).join("\n") };
      }
    } catch (e: any) {
      alert(`Revert failed: ${e?.message ?? e}`);
    } finally {
      saving = { ...saving, [k]: false };
    }
  }

  function toggleGroup(key: string) {
    if (closedGroups.has(key)) closedGroups.delete(key);
    else closedGroups.add(key);
  }
  function toggleDialogue(key: string) {
    if (openDialogues.has(key)) openDialogues.delete(key);
    else openDialogues.add(key);
  }

  let pendingCount = $derived(
    Object.keys(overrides).length +
      Object.values(ambientOverrides).reduce((n, sits) => n + Object.keys(sits).length, 0)
  );
  let visibleCount = $derived(data ? allDialogues(data).filter(matchesFilter).length : 0);
</script>

<div class="dlg">
  {#if loading}
    <p class="muted">Loading dialogue…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to edit dialogue.</p>
  {:else if error}
    <p class="err">Couldn’t load dialogue: {error}</p>
    <p class="muted small">
      Make sure you’re signed in with the owner (admin) account. Dev reads the local
      Chronicles mount; prod uses the admin-gated dialogue-overlay stack.
    </p>
    <button class="btn" onclick={load}>Retry</button>
  {:else if !data || Object.keys(data.zones ?? {}).length === 0}
    <p class="muted">No dialogue data. Arc generates <code>tools/dialogue_review.json</code> via the extractor.</p>
    <button class="btn" onclick={load}>Refresh</button>
  {:else}
    <div class="head">
      <span class="muted">
        Dialogue review · scope {(data.scope ?? []).join(", ") || "—"}
        <span class="sub">
          {data.stats?.emitted ?? "?"} dialogues shown ({data.stats?.hidden_junk ?? 0} junk filtered) ·
          edit the lines, Save writes to the overlay Arc applies · edits go live on the next game build
        </span>
      </span>
      <div class="head-actions">
        <div class="filter-tabs" role="group" aria-label="Filter by origin">
          <button class:on={filter === "arc"} onclick={() => (filter = "arc")}>Arc-generated</button>
          <button class:on={filter === "owner"} onclick={() => (filter = "owner")}>Yours</button>
          <button class:on={filter === "all"} onclick={() => (filter = "all")}>All</button>
        </div>
        {#if pendingCount > 0}
          <span class="pending">{pendingCount} pending edit{pendingCount === 1 ? "" : "s"}</span>
        {/if}
        <button class="btn" onclick={load}>Refresh</button>
      </div>
    </div>

    {#if visibleCount === 0}
      <p class="muted">
        {#if filter === "arc"}No Arc-generated dialogue in the current extract.{:else if filter === "owner"}No owner-authored dialogue matches.{:else}No dialogue in the extract.{/if}
      </p>
    {/if}
    {#each Object.entries(data.zones) as [zoneName, zone] (zoneName)}
      {@const zKey = `z:${zoneName}`}
      {@const zClosed = closedGroups.has(zKey)}
      {@const zoneMatch = Object.values(zone.npcs ?? {}).some((n) => n.dialogues.some(matchesFilter))}
      {#if zoneMatch}
        <section class="zone">
          <button class="fold zone-fold" onclick={() => toggleGroup(zKey)} aria-expanded={!zClosed}>
            <span class="caret">{zClosed ? "▸" : "▾"}</span>
            <span class="zone-name">{zoneName}</span>
            <span class="sub">{Object.keys(zone.npcs ?? {}).length} NPCs</span>
          </button>
          {#if !zClosed}
            {#each Object.entries(zone.npcs) as [npcName, npc] (npcName)}
              {@const dlgs = npc.dialogues.filter(matchesFilter)}
              {#if dlgs.length > 0}
                {@const nKey = `n:${zoneName}/${npcName}`}
                {@const nClosed = closedGroups.has(nKey)}
                <div class="npc">
                  <button class="fold npc-fold" onclick={() => toggleGroup(nKey)} aria-expanded={!nClosed}>
                    <span class="caret">{nClosed ? "▸" : "▾"}</span>
                    <span class="npc-name">{npcName}</span>
                    <span class="sub">
                      {(npc.scenes ?? []).join(", ")}{npc.scenes?.length ? " · " : ""}{dlgs.length} dialogue{dlgs.length === 1 ? "" : "s"}
                    </span>
                  </button>
                  {#if !nClosed}
                    {#each dlgs as d (rowKey(d))}
                      {@const dKey = rowKey(d)}
                      {@const dOpen = openDialogues.has(dKey)}
                      <div class="dia" class:edited={isEdited(d)}>
                        <button class="fold dia-fold" onclick={() => toggleDialogue(dKey)} aria-expanded={dOpen}>
                          <span class="caret">{dOpen ? "▾" : "▸"}</span>
                          <span class="dia-ctx">{d.context_label ?? `dialogue ${d.id ?? d.situation_id}`}</span>
                          {#if d.origin === "arc"}<span class="badge arc" title="Claude-generated ambient variant">Arc</span>{:else if d.origin === "owner"}<span class="badge owner" title="Hand-authored (core_Dialogue.json)">yours</span>{/if}
                          {#if d.origin === "arc" && (d.variants?.length ?? 0) > 1}<span class="badge vcount">{d.variants?.length} variants</span>{/if}
                          {#if d.has_options}<span class="badge opts" title="Branching dialogue — base text editable in v1, option branches come in v2">has options</span>{/if}
                          {#if isEdited(d)}<span class="badge edited-b">● edited</span>{/if}
                        </button>
                        {#if dOpen}
                          <div class="dia-body">
                            {#if d.origin === "arc"}
                              <p class="muted small">
                                {(d.variants?.length ?? 0)} ambient variant{(d.variants?.length ?? 0) === 1 ? "" : "s"} — one per line. Edit any/all and Save; they replace this situation's variants.
                              </p>
                            {/if}
                            <textarea
                              class="dia-text"
                              rows={Math.min(12, Math.max(2, (drafts[dKey] ?? "").split("\n").length))}
                              bind:value={drafts[dKey]}
                              spellcheck="true"
                            ></textarea>
                            <div class="dia-actions">
                              <button
                                class="btn save"
                                disabled={saving[dKey] || !isDirty(d)}
                                onclick={() => save(d)}
                              >{saving[dKey] ? "Saving…" : isDirty(d) ? "Save" : "Saved"}</button>
                              {#if isEdited(d)}
                                <button class="btn revert" disabled={saving[dKey]} onclick={() => revert(d)}>Revert</button>
                              {/if}
                              {#if isDirty(d)}<span class="dirty-note">unsaved changes</span>{/if}
                            </div>
                          </div>
                        {/if}
                      </div>
                    {/each}
                  {/if}
                </div>
              {/if}
            {/each}
          {/if}
        </section>
      {/if}
    {/each}
  {/if}
</div>

<style>
  .dlg {
    background: #0a0e17;
    color: #e0e7ff;
    font-family: "Courier New", monospace;
    padding: 1.25rem;
    max-width: 1000px;
    margin: 0 auto;
  }
  .muted { color: rgba(224, 231, 255, 0.55); }
  .muted.small { font-size: 0.78rem; line-height: 1.5; margin-top: 0.4rem; }
  .err { color: #f87171; }
  .sub { color: rgba(224, 231, 255, 0.45); font-weight: normal; font-size: 0.76rem; }
  code { background: rgba(167, 243, 208, 0.1); padding: 0 0.3rem; border-radius: 3px; }
  .head { display: flex; justify-content: space-between; align-items: flex-start; gap: 1rem; margin-bottom: 1rem; flex-wrap: wrap; }
  .head .sub { display: block; margin-top: 0.15rem; max-width: 46rem; line-height: 1.45; }
  .head-actions { display: flex; align-items: center; gap: 0.6rem; flex-shrink: 0; }
  .pending { font-size: 0.75rem; color: #fbbf24; background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.4); border-radius: 3px; padding: 0.1rem 0.45rem; }
  .btn {
    background: transparent; color: #a7f3d0; border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 4px; padding: 0.3rem 0.7rem; font-family: inherit; cursor: pointer; font-size: 0.8rem;
  }
  .btn:hover:not(:disabled) { background: rgba(167, 243, 208, 0.1); }
  .btn:disabled { opacity: 0.45; cursor: default; }

  .zone { margin-bottom: 0.5rem; }
  .fold {
    display: flex; align-items: baseline; gap: 0.5rem; width: 100%; text-align: left;
    background: none; border: none; color: inherit; font-family: inherit; cursor: pointer; padding: 0.35rem 0;
  }
  .caret { color: #6b7280; flex: none; }
  .zone-fold .zone-name { color: #a7f3d0; font-size: 1rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.06em; }
  .npc { margin-left: 1rem; border-left: 1px solid rgba(167, 243, 208, 0.1); padding-left: 0.6rem; }
  .npc-fold .npc-name { color: #e5e7eb; font-size: 0.88rem; font-weight: 600; }
  .dia { margin-left: 1.2rem; border-left: 1px solid rgba(255, 255, 255, 0.05); padding-left: 0.6rem; margin-bottom: 0.15rem; }
  .dia.edited { border-left-color: rgba(251, 191, 36, 0.5); }
  .dia-fold { padding: 0.3rem 0; }
  .dia-ctx { color: #cdd6e4; font-size: 0.82rem; }
  .badge { font-size: 0.62rem; padding: 0.05rem 0.4rem; border-radius: 3px; flex: none; white-space: nowrap; }
  .badge.opts { color: #c084fc; background: rgba(192, 132, 252, 0.12); border: 1px solid rgba(192, 132, 252, 0.35); }
  .badge.edited-b { color: #fbbf24; background: rgba(251, 191, 36, 0.12); border: 1px solid rgba(251, 191, 36, 0.4); }
  .badge.arc { color: #7dd3fc; background: rgba(125, 211, 252, 0.13); border: 1px solid rgba(125, 211, 252, 0.4); }
  .badge.owner { color: #94a3b8; background: rgba(148, 163, 184, 0.12); border: 1px solid rgba(148, 163, 184, 0.3); }
  .badge.vcount { color: #6b7280; background: rgba(107, 114, 128, 0.1); border: 1px solid rgba(107, 114, 128, 0.25); }
  .filter-tabs { display: inline-flex; border: 1px solid rgba(167, 243, 208, 0.2); border-radius: 5px; overflow: hidden; }
  .filter-tabs button { background: none; border: none; color: #8b97a8; font-family: inherit; font-size: 0.74rem; padding: 0.25rem 0.6rem; cursor: pointer; }
  .filter-tabs button:not(:last-child) { border-right: 1px solid rgba(167, 243, 208, 0.15); }
  .filter-tabs button.on { background: rgba(167, 243, 208, 0.15); color: #a7f3d0; }
  .filter-tabs button:hover:not(.on) { background: rgba(167, 243, 208, 0.06); }
  .dia-body { padding: 0.15rem 0 0.6rem 1.1rem; }
  .dia-text {
    width: 100%; box-sizing: border-box; resize: vertical;
    background: #12161e; color: #e0e7ff; border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 4px; padding: 0.5rem 0.6rem; font-family: system-ui, sans-serif; font-size: 0.92rem; line-height: 1.5;
  }
  .dia-text:focus { outline: none; border-color: rgba(167, 243, 208, 0.5); }
  .dia-actions { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.4rem; }
  .btn.save { color: #34d399; border-color: rgba(52, 211, 153, 0.4); }
  .btn.save:hover:not(:disabled) { background: rgba(52, 211, 153, 0.1); }
  .btn.revert { color: #f87171; border-color: rgba(248, 113, 113, 0.35); }
  .btn.revert:hover:not(:disabled) { background: rgba(248, 113, 113, 0.1); }
  .dirty-note { font-size: 0.72rem; color: #fbbf24; }
</style>
