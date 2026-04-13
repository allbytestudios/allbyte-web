<script lang="ts">
  import type { FixtureManifest, FixtureEntry } from "../lib/ticketTypes";
  import { fetchFixtureManifest } from "../lib/testDataSource";
  import { onMount, onDestroy } from "svelte";

  let manifest = $state<FixtureManifest | null>(null);
  let filter = $state("");
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  async function load() {
    manifest = await fetchFixtureManifest().catch(() => null);
  }

  onMount(() => {
    load();
    pollTimer = setInterval(load, 30_000);
  });

  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
  });

  let filtered = $derived.by<FixtureEntry[]>(() => {
    if (!manifest) return [];
    if (!filter) return manifest.fixtures;
    const q = filter.toLowerCase();
    return manifest.fixtures.filter(
      (f) =>
        f.name.toLowerCase().includes(q) ||
        f.scene.toLowerCase().includes(q) ||
        f.tags?.some((t) => t.toLowerCase().includes(q)),
    );
  });
</script>

{#if manifest && manifest.fixtures.length > 0}
  <div class="fixture-picker">
    <h3 class="section-title">Fixtures</h3>
    {#if manifest.fixtures.length > 4}
      <input
        type="text"
        class="fixture-filter"
        placeholder="Filter by name, scene, or tag..."
        bind:value={filter}
      />
    {/if}
    <div class="fixture-list">
      {#each filtered as f (f.id)}
        <div class="fixture-row">
          <div class="fixture-info">
            <span class="fixture-name">{f.name}</span>
            <span class="fixture-scene">{f.scene}</span>
            {#if f.tags?.length}
              <span class="fixture-tags">
                {#each f.tags.slice(0, 3) as tag}
                  <span class="fixture-tag">{tag}</span>
                {/each}
              </span>
            {/if}
          </div>
          <div class="fixture-meta">
            {#if f.gameVersion}
              <span class="fixture-version">{f.gameVersion}</span>
            {/if}
            <a href="/play/?fixture={f.id}" class="fixture-load">Open in Game</a>
          </div>
        </div>
      {/each}
    </div>
    {#if filtered.length === 0 && filter}
      <p class="fixture-empty">No fixtures match "{filter}"</p>
    {/if}
  </div>
{/if}

<style>
  .fixture-picker {
    margin-top: 0.5rem;
  }
  .section-title {
    font-size: 0.82rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 1.5rem 0 0.5rem;
  }
  .fixture-filter {
    width: 100%;
    background: #12161e;
    color: #d1d5db;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 3px;
    padding: 0.35rem 0.5rem;
    font-family: inherit;
    font-size: 0.8rem;
    margin-bottom: 0.5rem;
    box-sizing: border-box;
  }
  .fixture-filter::placeholder { color: #4b5563; }
  .fixture-list {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }
  .fixture-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.4rem 0.6rem;
    background: #12161e;
    border: 1px solid rgba(167, 243, 208, 0.08);
    border-radius: 4px;
  }
  .fixture-row:hover {
    border-color: rgba(167, 243, 208, 0.25);
  }
  .fixture-info {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
    min-width: 0;
  }
  .fixture-name {
    font-size: 0.82rem;
    color: #e5e7eb;
    font-weight: 600;
  }
  .fixture-scene {
    font-size: 0.75rem;
    color: #6b7280;
  }
  .fixture-tags {
    display: flex;
    gap: 0.25rem;
  }
  .fixture-tag {
    font-size: 0.68rem;
    color: #4b5563;
    border: 1px solid rgba(156, 163, 175, 0.15);
    border-radius: 2px;
    padding: 0 0.25rem;
  }
  .fixture-meta {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-shrink: 0;
  }
  .fixture-version {
    font-size: 0.72rem;
    color: #4b5563;
  }
  .fixture-load {
    font-size: 0.75rem;
    color: #a7f3d0;
    text-decoration: none;
    padding: 0.2rem 0.5rem;
    border: 1px solid rgba(167, 243, 208, 0.3);
    border-radius: 3px;
    white-space: nowrap;
  }
  .fixture-load:hover {
    background: rgba(167, 243, 208, 0.08);
    border-color: rgba(167, 243, 208, 0.5);
  }
  .fixture-empty {
    font-size: 0.78rem;
    color: #6b7280;
    padding: 0.5rem 0;
  }
</style>
