<script lang="ts">
  // Relic vignette review (owner-approval gate). Reads Arc's tools/relic_vignettes.json
  // — per-relic → per-expertise-TIER → an ordered array of LINES (each fades in one at
  // a time on the parchment in-game). Tier 1 = acquisition (usable at level 1); higher
  // tiers unlock as the relic's expertise grows. The prose is placeholder until the
  // owner reviews here. Read-first v1; the edit→overlay writeback (relic_vignette_overrides,
  // Arc's apply_relic_vignette_overrides.py) lands once Arc ships the write half.
  // Source: WebBootstrap/DataStore/web/core_RelicVignettes.json (Arc's extractor).
  import { onMount } from "svelte";
  import { SvelteSet } from "svelte/reactivity";

  const DEV = import.meta.env.DEV;
  // DEV: chroniclesProxy serves the live file from the game repo. PROD: synced to
  // S3 test-snapshot alongside the other console data (read-only there).
  const REVIEW_URL = DEV
    ? "/test-data/tools/relic_vignettes.json"
    : "/test-snapshot/tools/relic_vignettes.json";

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
  const open = new SvelteSet<string>();

  const relics = $derived(
    (data?.relics ?? []).filter((r) => r.relic_name && r.relic_name !== "_default")
  );
  const counts = $derived.by(() => {
    const c = { relics: 0, tiers: 0, draft: 0, review: 0, approved: 0 };
    for (const r of relics) {
      c.relics++;
      for (const t of r.tiers ?? []) {
        c.tiers++;
        const s = (t.status ?? "draft").toLowerCase();
        if (s === "approved") c.approved++;
        else if (s === "review") c.review++;
        else c.draft++;
      }
    }
    return c;
  });

  onMount(load);
  async function load() {
    loading = true;
    error = null;
    try {
      const r = await fetch(REVIEW_URL, { cache: "no-store" });
      if (!r.ok) throw new Error(`relic_vignettes.json not reachable (${r.status})`);
      data = (await r.json()) as VData;
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
  function statusClass(s?: string) {
    const v = (s ?? "draft").toLowerCase();
    return v === "approved" ? "s-approved" : v === "review" ? "s-review" : "s-draft";
  }
</script>

<section class="vg">
  <header class="vg-head">
    <div>
      <h2>Relic Vignettes</h2>
      <p class="sub">
        The stories a relic reveals as its expertise grows. Read the prose, tier by tier.
        This is the owner-approval gate before the real vignettes land.
      </p>
    </div>
    <button class="reload" onclick={load} disabled={loading}>{loading ? "Loading…" : "Reload"}</button>
  </header>

  {#if !loading && !error && relics.length}
    <div class="tally">
      <span>{counts.relics} relics</span>
      <span>{counts.tiers} vignettes</span>
      <span class="s-approved">{counts.approved} approved</span>
      <span class="s-review">{counts.review} in review</span>
      <span class="s-draft">{counts.draft} draft</span>
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
                <div class="tier">
                  <div class="tier-head">
                    <span class="tlabel">{t.label ?? `Tier ${t.tier}`}</span>
                    <span class="badge {statusClass(t.status)}">{(t.status ?? "draft")}</span>
                  </div>
                  <ol class="lines">
                    {#each t.lines ?? [] as line, i (i)}
                      <li>{line}</li>
                    {/each}
                  </ol>
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
  .vg-head h2 { margin: 0 0 0.2rem; color: #a7f3d0; font-size: 1.4rem; }
  .sub { margin: 0; color: #8aa89b; font-size: 0.86rem; max-width: 60ch; line-height: 1.5; }
  .reload { background: #12202b; color: #a7f3d0; border: 1px solid #234; border-radius: 5px; padding: 0.4rem 0.8rem; cursor: pointer; font: inherit; font-size: 0.8rem; }
  .reload:disabled { opacity: 0.6; cursor: default; }
  .tally { display: flex; flex-wrap: wrap; gap: 0.5rem 1.1rem; margin: 1rem 0 0.4rem; font-size: 0.82rem; color: #8aa89b; }
  .note { color: #8aa89b; font-size: 0.86rem; margin: 1.2rem 0; }
  .empty { margin: 1.4rem 0; }
  .err { color: #f0a58c; font-size: 0.9rem; margin: 0 0 0.5rem; }
  code { background: #0d1620; border: 1px solid #1e2e3a; border-radius: 3px; padding: 0.05rem 0.35rem; color: #a7f3d0; }
  .relics { list-style: none; margin: 1rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
  .relic { border: 1px solid #1e2e3a; border-radius: 7px; background: #0d1620; overflow: hidden; }
  .relic-head { width: 100%; display: flex; align-items: center; gap: 0.7rem; padding: 0.75rem 0.9rem; background: none; border: 0; color: #cfe6dc; cursor: pointer; font: inherit; text-align: left; }
  .relic-head:hover { background: #10202b; }
  .chev { color: #4f8f7a; width: 0.9em; }
  .rname { color: #a7f3d0; font-weight: 600; font-size: 0.98rem; }
  .anam { color: #8aa89b; font-style: italic; font-size: 0.78rem; }
  .tcount { margin-left: auto; color: #6b8579; font-size: 0.76rem; }
  .tiers { padding: 0.2rem 0.9rem 0.9rem; display: flex; flex-direction: column; gap: 0.8rem; }
  .tier { border-left: 2px solid #234; padding-left: 0.9rem; }
  .tier-head { display: flex; align-items: center; gap: 0.7rem; margin-bottom: 0.4rem; }
  .tlabel { color: #cfe6dc; font-size: 0.86rem; }
  .badge { font-size: 0.66rem; text-transform: uppercase; letter-spacing: 0.06em; padding: 0.12rem 0.5rem; border-radius: 3px; border: 1px solid currentColor; }
  .s-draft { color: #b7a06a; }
  .s-review { color: #7ab0d8; }
  .s-approved { color: #7fce8f; }
  .lines { margin: 0; padding-left: 1.4rem; display: flex; flex-direction: column; gap: 0.35rem; }
  .lines li { color: #d9ead9; font-size: 0.9rem; line-height: 1.5; }
  @media (max-width: 560px) { .vg-head { flex-direction: column; } }
</style>
