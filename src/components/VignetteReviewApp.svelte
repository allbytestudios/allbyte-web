<script lang="ts">
  // Relic vignette review + edit (owner-approval gate). Reads Arc's
  // tools/relic_vignettes.json — per-relic → per-expertise-TIER → an ordered
  // array of LINES (each fades in one at a time on the parchment in-game).
  // The owner edits a tier's lines; edits queue into tools/relic_vignette_overrides.json
  // (keyed "<relic_name>|<tier>" -> {lines}) which Arc's apply_relic_vignette_overrides.py
  // folds back into core_RelicVignettes.json. DEV-only write (local proxy + dev
  // middleware); prod is read-only. Source: WebBootstrap/DataStore/web/core_RelicVignettes.json.
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";

  const DEV = import.meta.env.DEV;
  const REVIEW_URL = DEV
    ? "/test-data/tools/relic_vignettes.json"
    : "/test-snapshot/tools/relic_vignettes.json";
  const OVERRIDES_URL = DEV
    ? "/test-data/tools/relic_vignette_overrides.json"
    : "/test-snapshot/tools/relic_vignette_overrides.json";
  const SAVE_URL = "/api/relic-vignette-override/"; // dev middleware only

  interface Tier {
    tier: number;
    label?: string;
    status?: "draft" | "review" | "approved" | string;
    lines: string[];
  }
  interface Relic {
    relic_name: string;
    relic_id?: number;
    anam?: string;
    tiers: Tier[];
  }
  interface VData {
    schema_version?: number;
    source?: string;
    overlay_key?: string;
    relics: Relic[];
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<VData | null>(null);
  let overrides = $state<Record<string, { lines?: string[] }>>({});
  let drafts = $state<Record<string, string>>({});
  let editing = $state<string | null>(null);
  let saving = $state<Record<string, boolean>>({});
  const open = new SvelteSet<string>();

  // Editing is a dev-only, admin-only affordance (writes to the local game repo).
  const canEdit = $derived(DEV && isAdmin(auth.currentUser));

  const relics = $derived(
    (data?.relics ?? []).filter((r) => r.relic_name && r.relic_name !== "_default")
  );

  function key(relic: Relic, tier: Tier) {
    return relic.relic_name + "|" + tier.tier;
  }
  function effLines(relic: Relic, tier: Tier): string[] {
    const ov = overrides[key(relic, tier)];
    return ov && Array.isArray(ov.lines) ? ov.lines : (tier.lines ?? []);
  }
  function isOverridden(relic: Relic, tier: Tier) {
    return !!overrides[key(relic, tier)];
  }

  const counts = $derived.by(() => {
    const c = { relics: 0, tiers: 0, edited: 0 };
    for (const r of relics) {
      c.relics++;
      for (const t of r.tiers ?? []) {
        c.tiers++;
        if (isOverridden(r, t)) c.edited++;
      }
    }
    return c;
  });

  onMount(load);
  async function load() {
    loading = true;
    error = null;
    try {
      const [rv, ov] = await Promise.all([
        fetch(REVIEW_URL, { cache: "no-store" }),
        fetch(OVERRIDES_URL, { cache: "no-store" }).catch(() => null),
      ]);
      if (!rv.ok) throw new Error(`relic_vignettes.json not reachable (${rv.status})`);
      data = (await rv.json()) as VData;
      overrides = ov && ov.ok ? await ov.json().catch(() => ({})) : {};
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  function toggle(name: string) {
    if (open.has(name)) open.delete(name);
    else open.add(name);
  }
  function startEdit(relic: Relic, tier: Tier) {
    const k = key(relic, tier);
    drafts = { ...drafts, [k]: effLines(relic, tier).join("\n") };
    editing = k;
  }
  function cancelEdit() {
    editing = null;
  }

  function linesFromDraft(text: string): string[] {
    const arr = text.replace(/\r\n/g, "\n").split("\n");
    while (arr.length && !arr[arr.length - 1].trim()) arr.pop(); // drop trailing blanks
    return arr;
  }

  async function save(relic: Relic, tier: Tier) {
    const k = key(relic, tier);
    const lines = linesFromDraft(drafts[k] ?? "");
    if (!lines.length) {
      alert("A vignette needs at least one line.");
      return;
    }
    saving = { ...saving, [k]: true };
    try {
      const r = await fetch(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relic_name: relic.relic_name, tier: tier.tier, lines }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `${r.status}`);
      }
      overrides = { ...overrides, [k]: { lines } };
      editing = null;
    } catch (e: any) {
      alert(`Save failed: ${e?.message ?? e}`);
    } finally {
      saving = { ...saving, [k]: false };
    }
  }

  async function revert(relic: Relic, tier: Tier) {
    const k = key(relic, tier);
    saving = { ...saving, [k]: true };
    try {
      const r = await fetch(SAVE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ relic_name: relic.relic_name, tier: tier.tier, revert: true }),
      });
      if (!r.ok) {
        const e = await r.json().catch(() => ({}));
        throw new Error(e.error ?? `${r.status}`);
      }
      const next = { ...overrides };
      delete next[k];
      overrides = next;
      if (editing === k) editing = null;
    } catch (e: any) {
      alert(`Revert failed: ${e?.message ?? e}`);
    } finally {
      saving = { ...saving, [k]: false };
    }
  }
</script>

<section class="vg">
  <header class="vg-head">
    <div>
      <h2>Relic Vignettes</h2>
      <p class="sub">
        The stories a relic reveals as its expertise grows. Read the prose tier by tier
        {#if canEdit}and edit the lines{/if} — the owner-approval gate before the real
        vignettes land in-game.
      </p>
    </div>
    <button class="reload" onclick={load} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
  </header>

  {#if !loading && !error && relics.length}
    <div class="tally">
      <span>{counts.relics} relics</span>
      <span>{counts.tiers} vignettes</span>
      {#if counts.edited}<span class="s-edited">{counts.edited} edited</span>{/if}
      {#if !canEdit}<span class="ro">read-only{DEV ? " (admin to edit)" : " (edit on the local console)"}</span>{/if}
    </div>
  {/if}

  {#if loading}
    <p class="note">Loading vignettes…</p>
  {:else if error}
    <div class="empty">
      <p class="err">{error}</p>
      <p class="note">
        On the local dev console this reads live from the game repo. On production it appears after
        the test-data sync runs. Hit Reload once <code>tools/relic_vignettes.json</code> is available.
      </p>
    </div>
  {:else if !relics.length}
    <p class="note">No relic vignettes found in the file yet.</p>
  {:else}
    <ul class="relics">
      {#each relics as r (r.relic_name)}
        <li class="relic">
          <button class="relic-head" onclick={() => toggle(r.relic_name)} aria-expanded={open.has(r.relic_name)}>
            <span class="chev">{open.has(r.relic_name) ? "▾" : "▸"}</span>
            <span class="rname">{r.relic_name}</span>
            {#if r.anam}<span class="anam">preserves {r.anam}</span>{/if}
            <span class="tcount">{(r.tiers ?? []).length} tier{(r.tiers ?? []).length === 1 ? "" : "s"}</span>
          </button>
          {#if open.has(r.relic_name)}
            <div class="tiers">
              {#each r.tiers ?? [] as t (t.tier)}
                {@const k = key(r, t)}
                <div class="tier" class:edited={isOverridden(r, t)}>
                  <div class="tier-head">
                    <span class="tlabel">{t.label ?? `Tier ${t.tier}`}</span>
                    <span
                      class="badge {isOverridden(r, t)
                        ? 's-edited'
                        : t.status === 'approved'
                          ? 's-approved'
                          : t.status === 'review'
                            ? 's-review'
                            : 's-draft'}"
                    >
                      {isOverridden(r, t) ? "edited" : (t.status ?? "draft")}
                    </span>
                    {#if canEdit && editing !== k}
                      <button class="mini" onclick={() => startEdit(r, t)}>Edit</button>
                      {#if isOverridden(r, t)}
                        <button class="mini revert" onclick={() => revert(r, t)} disabled={saving[k]}>Revert</button>
                      {/if}
                    {/if}
                  </div>

                  {#if editing === k}
                    <textarea
                      class="editor"
                      rows={Math.max(3, drafts[k]?.split("\n").length ?? 3)}
                      bind:value={drafts[k]}
                      placeholder="One line per row — each fades in on the parchment in order."
                    ></textarea>
                    <div class="edit-actions">
                      <button class="mini save" onclick={() => save(r, t)} disabled={saving[k]}>
                        {saving[k] ? "Saving…" : "Save & publish"}
                      </button>
                      <button class="mini" onclick={cancelEdit}>Cancel</button>
                      <span class="hint">Goes live locally + queues to Arc.</span>
                    </div>
                  {:else}
                    <ol class="lines">
                      {#each effLines(r, t) as line, i (i)}
                        <li>{line}</li>
                      {/each}
                    </ol>
                  {/if}
                </div>
              {/each}
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .vg { max-width: 900px; margin: 0 auto; padding: 1.4rem clamp(0.8rem, 4vw, 2rem) 4rem; color: #cfe6dc; font-family: "SF Mono", ui-monospace, Menlo, Consolas, monospace; }
  .vg-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 1rem; }
  .vg-head h2 { margin: 0 0 0.2rem; color: var(--crimson); font-size: 1.4rem; }
  .sub { margin: 0; color: #8aa89b; font-size: 0.86rem; max-width: 64ch; line-height: 1.5; }
  .reload { background: #12202b; color: var(--crimson); border: 1px solid #234; border-radius: 5px; padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; font-size: 0.8rem; }
  .reload:disabled { opacity: 0.6; cursor: default; }
  .tally { display: flex; flex-wrap: wrap; gap: 0.5rem 1.1rem; margin: 1rem 0 0.4rem; font-size: 0.82rem; color: #8aa89b; }
  .ro { color: #6b8579; }
  .note { color: #8aa89b; font-size: 0.86rem; margin: 1.2rem 0; }
  .empty { margin: 1.4rem 0; }
  .err { color: #f0a58c; font-size: 0.9rem; margin: 0 0 0.5rem; }
  code { background: #0d1620; border: 1px solid #1e2e3a; border-radius: 3px; padding: 0.05rem 0.35rem; color: var(--crimson); }
  .relics { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .relic { border: 1px solid #1e2e3a; border-radius: 7px; background: #0d1620; overflow: hidden; }
  .relic-head { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 0.75rem 0.9rem; background: none; border: 0; color: #cfe6dc; cursor: pointer; font: inherit; text-align: left; }
  .relic-head:hover { background: #10202b; }
  .chev { color: #4f8f7a; width: 0.9em; }
  .rname { color: var(--crimson); font-weight: 600; font-size: 0.98rem; }
  .anam { color: #8aa89b; font-style: italic; font-size: 0.78rem; }
  .tcount { margin-left: auto; color: #6b8579; font-size: 0.76rem; }
  .tiers { padding: 0.2rem 0.9rem 0.9rem; display: flex; flex-direction: column; gap: 0.85rem; }
  .tier { border-left: 2px solid #234; padding-left: 0.9rem; }
  .tier.edited { border-left-color: #7fce8f; }
  .tier-head { display: flex; align-items: center; gap: 0.6rem; margin-bottom: 0.45rem; }
  .tlabel { color: #cfe6dc; font-size: 0.86rem; }
  .badge { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.12rem 0.5rem; border-radius: 3px; border: 1px solid currentColor; }
  .s-draft { color: #b7a06a; }
  .s-review { color: #7ab0d8; }
  .s-approved { color: #7fce8f; }
  .s-edited { color: #7fce8f; }
  .mini { font: inherit; font-size: 0.72rem; background: #12202b; color: var(--crimson); border: 1px solid #234; border-radius: 4px; padding: 0.15rem 0.55rem; cursor: pointer; }
  .mini:hover { background: #16303e; }
  .mini:disabled { opacity: 0.6; cursor: default; }
  .mini.save { background: #14361f; color: #7fce8f; border-color: #2d5a34; }
  .mini.revert { color: #d8a07a; }
  .lines { margin: 0; padding-left: 1.4rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .lines li { color: #d9ead9; font-size: 0.9rem; line-height: 1.5; }
  .editor { width: 100%; min-height: 5rem; resize: vertical; font-family: inherit; font-size: 0.86rem; line-height: 1.5; color: #e6f3ea; background: #0a1520; border: 1px solid #2d5a34; border-radius: 5px; padding: 0.55rem 0.7rem; }
  .edit-actions { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
  .hint { color: #6b8579; font-size: 0.72rem; }
  @media (max-width: 560px) { .vg-head { flex-direction: column; } }
</style>
