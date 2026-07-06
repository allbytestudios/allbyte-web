<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin, isTierAtLeast } from "../lib/tier";
  import { bySection, launchUrl, type Scenario } from "../lib/scenarios";

  // AutoPlay personas (Quinn's JP policies) — "" = manual, no overlay.
  const PERSONAS = ["", "STR_FOCUS", "BALANCED", "MAGIC", "DEX_DODGE", "CON_TANK"];

  const groups = bySection();
  // Per-row persona override, seeded from each scenario's default.
  let overrides = $state<Record<string, string>>(
    Object.fromEntries(groups.flatMap((g) => g.scenarios).map((s) => [s.id, s.persona ?? ""])),
  );

  const gated = $derived(
    !(isAdmin(auth.currentUser) || isTierAtLeast(auth.currentUser, "legend")),
  );

  function href(s: Scenario): string {
    const persona = overrides[s.id] ?? s.persona ?? "";
    return launchUrl(s, { persona: persona || undefined });
  }
</script>

<div class="scn">
  <p class="scn-lede">
    Drop straight into the <code>develop</code> build at a saved scenario — the save restores
    the party and warps into its scene. Persona is an optional AutoPlay overlay applied after
    the load; leave it <em>manual</em> to drive yourself.
  </p>

  {#if gated}
    <p class="scn-note-block">
      The scenario launcher is <strong>admin / Legend only</strong> — it loads the debug
      <code>develop</code> build.
    </p>
  {:else if groups.length === 0}
    <p class="scn-note-block">
      No scenarios yet. Quinn populates <code>quinn_spine.json</code>; run
      <code>npm run sync:scenarios</code> to mirror the rows + save fixtures here.
    </p>
  {:else}
    {#each groups as g (g.section)}
      <section class="scn-section">
        <h2 class="scn-h">{g.section}</h2>
        <div class="scn-rows">
          {#each g.scenarios as s (s.id)}
            <div class="scn-row">
              <div class="scn-info">
                <span class="scn-label">{s.label}</span>
                {#if s.note}<span class="scn-desc">{s.note}</span>{/if}
                <span class="scn-meta"
                  >{s.fixtureId}{#if s.packs?.length} · packs: {s.packs.join(", ")}{/if}</span
                >
              </div>
              <div class="scn-actions">
                <label class="scn-persona">
                  <span>persona</span>
                  <select bind:value={overrides[s.id]}>
                    {#each PERSONAS as p}
                      <option value={p}>{p || "— manual —"}</option>
                    {/each}
                  </select>
                </label>
                <a class="scn-launch" href={href(s)} target="_blank" rel="noopener"
                  >Launch in develop ↗</a
                >
              </div>
            </div>
          {/each}
        </div>
      </section>
    {/each}
  {/if}
</div>

<style>
  .scn {
    max-width: 1100px;
    margin: 0 auto;
    padding: 1rem 1rem 2rem;
    color: #d1d5db;
    font-family: "Courier New", monospace;
  }
  .scn-lede {
    font-size: 0.85rem;
    color: #9ca3af;
    line-height: 1.5;
    margin: 0.5rem 0 1.25rem;
  }
  .scn code {
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.08);
    padding: 0 0.25rem;
    border-radius: 3px;
  }
  .scn-note-block {
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.15);
    border-radius: 5px;
    padding: 1rem;
    font-size: 0.85rem;
    color: #9ca3af;
  }
  .scn-section {
    margin-bottom: 1.75rem;
  }
  .scn-h {
    font-size: 0.8rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: #a7f3d0;
    border-bottom: 1px solid rgba(167, 243, 208, 0.12);
    padding-bottom: 0.35rem;
    margin: 0 0 0.6rem;
  }
  .scn-rows {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
  }
  .scn-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.08);
    border-radius: 5px;
    padding: 0.6rem 0.85rem;
  }
  .scn-row:hover {
    border-color: rgba(167, 243, 208, 0.22);
  }
  .scn-info {
    display: flex;
    flex-direction: column;
    gap: 0.15rem;
    min-width: 0;
  }
  .scn-label {
    font-size: 0.9rem;
    color: #e5e7eb;
    font-weight: 600;
  }
  .scn-desc {
    font-size: 0.78rem;
    color: #9ca3af;
  }
  .scn-meta {
    font-size: 0.72rem;
    color: #6b7280;
  }
  .scn-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    flex-shrink: 0;
  }
  .scn-persona {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    font-size: 0.72rem;
    color: #6b7280;
  }
  .scn-persona select {
    background: #0a0e17;
    color: #d1d5db;
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 3px;
    padding: 0.2rem 0.35rem;
    font-family: inherit;
    font-size: 0.75rem;
  }
  .scn-launch {
    font-size: 0.8rem;
    color: #a7f3d0;
    text-decoration: none;
    padding: 0.35rem 0.7rem;
    border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 4px;
    white-space: nowrap;
  }
  .scn-launch:hover {
    background: rgba(167, 243, 208, 0.1);
    border-color: rgba(167, 243, 208, 0.6);
  }
  @media (max-width: 600px) {
    .scn-row {
      flex-direction: column;
      align-items: stretch;
    }
    .scn-actions {
      justify-content: space-between;
    }
  }
</style>
