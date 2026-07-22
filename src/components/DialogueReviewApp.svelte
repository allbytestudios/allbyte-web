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

  const REVIEW_URL = "/test-data/tools/dialogue_review.json";
  const OVERRIDES_URL = "/test-data/tools/dialogue_overrides.json";
  // Trailing slash required — trailingSlash:"always" 404s the bare path before
  // the dev middleware runs (same as /api/decisions/ + /api/answers/).
  const SAVE_URL = "/api/dialogue-override/";

  interface Dialogue {
    id: number;
    scene?: string;
    npc?: string;
    context_label?: string;
    has_options?: boolean;
    lines: string[];
    dialogue_raw?: string;
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
  // True on the deployed site: this editor reads/writes the local game mount via
  // the dev server, so it only works under `npm run dev`. import.meta.env.DEV is
  // baked to false in the prod build.
  let notDev = $state(false);
  let data = $state<ReviewData | null>(null);
  let overrides = $state<Record<string, { lines?: string[] }>>({});
  let drafts = $state<Record<string, string>>({});
  let saving = $state<Record<string, boolean>>({});

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

  function baseLines(d: Dialogue): string[] {
    const ov = overrides[String(d.id)];
    return ov?.lines ?? d.lines ?? [];
  }
  function baseText(d: Dialogue): string {
    return baseLines(d).join("\n");
  }
  function isEdited(d: Dialogue): boolean {
    return overrides[String(d.id)] != null;
  }
  function isDirty(d: Dialogue): boolean {
    const k = String(d.id);
    return k in drafts && drafts[k] !== baseText(d);
  }

  function seedDrafts() {
    if (!data) return;
    const seeded: Record<string, string> = {};
    for (const d of allDialogues(data)) seeded[String(d.id)] = baseText(d);
    drafts = seeded;
  }

  async function load() {
    loading = true;
    error = null;
    try {
      const r = await fetch(REVIEW_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`review ${r.status} ${r.statusText}`);
      const txt = await r.text();
      try {
        data = JSON.parse(txt) as ReviewData;
      } catch {
        throw new Error("dialogue_review.json didn't parse as JSON — is the dev proxy + Chronicles mount available?");
      }
      // Overrides: absent/empty = no pending edits (not an error).
      try {
        const o = await fetch(OVERRIDES_URL, { cache: "no-store" });
        if (o.ok) {
          const t = (await o.text()).trim();
          overrides = t ? JSON.parse(t) : {};
        } else overrides = {};
      } catch {
        overrides = {};
      }
      seedDrafts();
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
    if (!import.meta.env.DEV) {
      notDev = true;
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
    const k = String(d.id);
    const lines = toDraftLines(drafts[k] ?? baseText(d));
    saving = { ...saving, [k]: true };
    try {
      const r = await fetch(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, lines }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `${r.status}`);
      }
      overrides = { ...overrides, [k]: { lines } };
      drafts = { ...drafts, [k]: lines.join("\n") };
    } catch (e: any) {
      alert(`Save failed: ${e?.message ?? e}\n\n(The editor writes to your local game mount — it only works on the dev server.)`);
    } finally {
      saving = { ...saving, [k]: false };
    }
  }

  async function revert(d: Dialogue) {
    const k = String(d.id);
    saving = { ...saving, [k]: true };
    try {
      const r = await fetch(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: d.id, revert: true }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `${r.status}`);
      }
      const no = { ...overrides };
      delete no[k];
      overrides = no;
      drafts = { ...drafts, [k]: (d.lines ?? []).join("\n") };
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
  function toggleDialogue(id: number) {
    const k = String(id);
    if (openDialogues.has(k)) openDialogues.delete(k);
    else openDialogues.add(k);
  }

  let pendingCount = $derived(Object.keys(overrides).length);
</script>

<div class="dlg">
  {#if loading}
    <p class="muted">Loading dialogue…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to edit dialogue.</p>
  {:else if notDev}
    <div class="devnote">
      <p class="devnote-h">The dialogue editor runs on your local dev server.</p>
      <p class="muted">
        It reads and writes your local game repo, so it only works under
        <code>npm run dev</code> → <code>localhost:4321/test/dialogue/</code>. This
        deployed copy can’t reach the game files, so there’s nothing to edit here.
      </p>
    </div>
  {:else if error}
    <p class="err">Couldn’t load dialogue: {error}</p>
    <p class="muted small">
      This editor reads the game repo live through the dev server. It only works on
      the local <code>:4321</code> dev build with the Chronicles mount — in prod it’s read-only.
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
        {#if pendingCount > 0}
          <span class="pending">{pendingCount} pending edit{pendingCount === 1 ? "" : "s"}</span>
        {/if}
        <button class="btn" onclick={load}>Refresh</button>
      </div>
    </div>

    {#each Object.entries(data.zones) as [zoneName, zone] (zoneName)}
      {@const zKey = `z:${zoneName}`}
      {@const zClosed = closedGroups.has(zKey)}
      <section class="zone">
        <button class="fold zone-fold" onclick={() => toggleGroup(zKey)} aria-expanded={!zClosed}>
          <span class="caret">{zClosed ? "▸" : "▾"}</span>
          <span class="zone-name">{zoneName}</span>
          <span class="sub">{Object.keys(zone.npcs ?? {}).length} NPCs</span>
        </button>
        {#if !zClosed}
          {#each Object.entries(zone.npcs) as [npcName, npc] (npcName)}
            {@const nKey = `n:${zoneName}/${npcName}`}
            {@const nClosed = closedGroups.has(nKey)}
            <div class="npc">
              <button class="fold npc-fold" onclick={() => toggleGroup(nKey)} aria-expanded={!nClosed}>
                <span class="caret">{nClosed ? "▸" : "▾"}</span>
                <span class="npc-name">{npcName}</span>
                <span class="sub">
                  {(npc.scenes ?? []).join(", ")}{npc.scenes?.length ? " · " : ""}{npc.dialogues.length} dialogue{npc.dialogues.length === 1 ? "" : "s"}
                </span>
              </button>
              {#if !nClosed}
                {#each npc.dialogues as d (d.id)}
                  {@const dKey = String(d.id)}
                  {@const dOpen = openDialogues.has(dKey)}
                  <div class="dia" class:edited={isEdited(d)}>
                    <button class="fold dia-fold" onclick={() => toggleDialogue(d.id)} aria-expanded={dOpen}>
                      <span class="caret">{dOpen ? "▾" : "▸"}</span>
                      <span class="dia-ctx">{d.context_label ?? `dialogue ${d.id}`}</span>
                      {#if d.has_options}<span class="badge opts" title="Branching dialogue — base text editable in v1, option branches come in v2">has options</span>{/if}
                      {#if isEdited(d)}<span class="badge edited-b">● edited</span>{/if}
                    </button>
                    {#if dOpen}
                      <div class="dia-body">
                        <textarea
                          class="dia-text"
                          rows={Math.min(10, Math.max(2, (drafts[dKey] ?? "").split("\n").length))}
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
          {/each}
        {/if}
      </section>
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
  .devnote {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 6px;
    padding: 1rem 1.1rem;
    max-width: 40rem;
  }
  .devnote-h { color: #a7f3d0; font-weight: 700; margin: 0 0 0.4rem; }
  .devnote .muted { line-height: 1.6; margin: 0; }
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
