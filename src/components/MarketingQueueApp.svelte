<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchManifest, fetchClipMeta, publishToPlatform, draftCaptions, approveToArtwork,
    clipMp4Url, clipThumbUrl,
    type Manifest, type ManifestEntry, type ClipMeta, type PublishResult,
    type DraftCaptionsResult, type ApproveToArtworkResult,
  } from "../lib/marketingQueue";
  import {
    manifest as fixtureManifest, checkAll, summarize, fixtureUrl,
    type MarketingFixtureEntry, type EntryHealth, type CoverageSummary,
  } from "../lib/marketingFixtures";

  const IS_DEV = import.meta.env.DEV;

  // Maps the caption field to the Postiz platform identifier.
  const PLATFORM_FOR_FIELD: Record<string, string> = {
    bluesky: "bluesky",
    discord: "discord",
    youtube_shorts: "youtube",
  };

  // Platform display names for button labels.
  const PLATFORM_LABEL: Record<string, string> = {
    bluesky: "Bluesky",
    discord: "Discord",
    youtube: "YouTube",
  };

  let manifest = $state<Manifest | null>(null);
  let loading = $state(true);
  let clipMetas = $state<Record<string, ClipMeta>>({});
  let selectedClip = $state<string | null>(null);
  let copiedKey = $state<string | null>(null);

  // Caption edits override the AI drafts. Key shape: `${clipName}.${field}`.
  // When a key is absent, fall back to the original draft from clipMetas.
  let captionEdits = $state<Record<string, string>>({});

  // Per-publish state. Key shape: `${clipName}.${platform}`.
  // busy = request in flight, result = last response, undefined = never published.
  let publishStates = $state<Record<string, { busy: boolean; result?: PublishResult }>>({});

  function currentCaption(clipName: string, field: string, draft: string | undefined): string {
    const key = `${clipName}.${field}`;
    if (key in captionEdits) return captionEdits[key];
    return draft ?? "";
  }

  function onCaptionInput(clipName: string, field: string, e: Event) {
    captionEdits[`${clipName}.${field}`] = (e.currentTarget as HTMLTextAreaElement).value;
  }

  // Per-clip caption-drafting state. Key: clip name. busy = request in
  // flight, result = last response.
  let draftStates = $state<Record<string, { busy: boolean; result?: DraftCaptionsResult }>>({});

  // Per-clip artwork-approval state. Same shape pattern as draftStates.
  let approveStates = $state<Record<string, { busy: boolean; result?: ApproveToArtworkResult }>>({});

  async function approveClipToArtwork(clipName: string) {
    const meta = clipMetas[clipName];
    if (!meta) return;
    const cap = meta.draft_captions ?? {};
    approveStates[clipName] = { busy: true };
    const result = await approveToArtwork({
      clip: clipName,
      title: currentCaption(clipName, "title", cap.title),
      description: currentCaption(clipName, "discord", cap.discord),
      scene: meta.scene_hint ?? undefined,
      duration_s: meta.clip_window?.duration_s ?? meta.duration_s,
    });
    approveStates[clipName] = { busy: false, result };
  }

  // Fixture-picker state.
  let fixtureHealth = $state<Record<string, EntryHealth>>({});
  let fixtureCoverage = $state<CoverageSummary | null>(null);
  let fixtureCheckBusy = $state(false);
  let selectedFixtureId = $state<string | null>(null);

  async function runFixtureHealthCheck() {
    fixtureCheckBusy = true;
    try {
      fixtureHealth = await checkAll();
      fixtureCoverage = summarize(fixtureHealth);
    } finally {
      fixtureCheckBusy = false;
    }
  }

  function dockerCommandFor(entry: MarketingFixtureEntry): string {
    if (!entry.fixture) return "# No fixture available — gap entry";
    const url = `${typeof window !== "undefined" ? window.location.origin : ""}${fixtureUrl(entry.fixture)}`;
    return [
      "# Native Windows capture (uses your GPU at 60fps).",
      "# Prereqs: ffmpeg in PATH, python+playwright+boto3 installed.",
      "./tests/autoplay-capture/run_capture.ps1 `",
      `  -SaveFixtureUrl "${url}" \``,
      `  -Persona ${entry.persona_hint} \``,
      "  -DurationS 180",
    ].join("\n");
  }

  async function draftCaptionsForClip(clipName: string) {
    draftStates[clipName] = { busy: true };
    const result = await draftCaptions(clipName);
    draftStates[clipName] = { busy: false, result };
    // If successful, re-fetch the clip metadata so the new captions render.
    if (result.ok) {
      const fresh = await fetchClipMeta(findEntry(clipName)?.meta ?? "");
      if (fresh) {
        clipMetas[clipName] = fresh;
        // Drop any pending edits — they were against the previous draft.
        for (const k of Object.keys(captionEdits)) {
          if (k.startsWith(`${clipName}.`)) delete captionEdits[k];
        }
      }
    }
  }

  async function publish(clipName: string, field: string, mp4File: string) {
    const platform = PLATFORM_FOR_FIELD[field];
    if (!platform) return;
    const draft = clipMetas[clipName]?.draft_captions?.[field as keyof typeof clipMetas[string]["draft_captions"]];
    const content = currentCaption(clipName, field, draft as string | undefined);
    if (!content) return;
    // Absolute URL so Postiz can fetch the media regardless of dev/prod.
    const mediaUrl = window.location.origin + clipMp4Url(mp4File);

    const stateKey = `${clipName}.${platform}`;
    publishStates[stateKey] = { busy: true };
    const result = await publishToPlatform(platform, content, mediaUrl);
    publishStates[stateKey] = { busy: false, result };
  }

  onMount(async () => {
    // Kick off the fixture health check immediately — independent of
    // capture state, so even an empty queue shows the fixture picker.
    runFixtureHealthCheck();
    const m = await fetchManifest();
    manifest = m;
    if (m && m.clips.length > 0) {
      // Eager-load each clip's metadata in parallel — manifest entries
      // only carry name/files/title; the per-platform captions live in
      // the individual JSON.
      const metas = await Promise.all(
        m.clips.map((c) => fetchClipMeta(c.meta).then((meta) => ({ name: c.name, meta })))
      );
      const map: Record<string, ClipMeta> = {};
      for (const { name, meta } of metas) {
        if (meta) map[name] = meta;
      }
      clipMetas = map;
      selectedClip = m.clips[0].name;
    }
    loading = false;
  });

  async function copyToClipboard(text: string, key: string) {
    try {
      await navigator.clipboard.writeText(text);
      copiedKey = key;
      setTimeout(() => {
        if (copiedKey === key) copiedKey = null;
      }, 1500);
    } catch {
      // Clipboard API failure is silent — the textarea is selectable as fallback.
    }
  }

  function findEntry(name: string): ManifestEntry | null {
    return manifest?.clips.find((c) => c.name === name) ?? null;
  }

  // Mirror title from per-clip meta back into the rendered list, since the
  // manifest's mirrored title may lag if caption_drafter ran after the
  // manifest was first written.
  function displayTitle(entry: ManifestEntry): string {
    const meta = clipMetas[entry.name];
    return meta?.draft_captions?.title ?? entry.title ?? entry.name;
  }
</script>

<section class="fixture-panel">
  <header class="fixture-panel-header">
    <h2>
      Capture from fixture
      {#if fixtureCoverage}
        <span class="coverage-pill" title="Coverage summary">
          {fixtureCoverage.available}/{fixtureCoverage.total} available
          {#if fixtureCoverage.missing > 0}<span class="coverage-warn"> · {fixtureCoverage.missing} missing</span>{/if}
          {#if fixtureCoverage.gaps > 0}<span class="coverage-gap"> · {fixtureCoverage.gaps} gaps</span>{/if}
        </span>
      {/if}
    </h2>
    <button onclick={runFixtureHealthCheck} disabled={fixtureCheckBusy} class="verify-btn">
      {fixtureCheckBusy ? "Checking…" : "Re-check"}
    </button>
  </header>

  <ul class="fixture-list">
    {#each fixtureManifest.entries as entry}
      {@const h = fixtureHealth[entry.id]}
      {@const status = h?.status ?? "unchecked"}
      {@const isSelected = selectedFixtureId === entry.id}
      <li class="fixture-row" class:selected={isSelected}>
        <button class="fixture-row-btn" onclick={() => (selectedFixtureId = isSelected ? null : entry.id)}>
          <span class="fixture-status status-{status}" title={status}>
            {#if status === "available"}✓{:else if status === "missing"}✗{:else if status === "gap"}○{:else}…{/if}
          </span>
          <span class="fixture-category">{entry.category}</span>
          <span class="fixture-title">{entry.story_beat}</span>
          {#if entry.arc_cond !== null}
            <span class="fixture-cond">cond {entry.arc_cond}</span>
          {/if}
          {#if entry.scene_anchor}
            <span class="fixture-scene">{entry.scene_anchor}</span>
          {/if}
        </button>
        {#if isSelected}
          <div class="fixture-detail">
            <p class="fixture-notes">{entry.notes}</p>
            <div class="fixture-tags">
              {#each entry.tags as t}<span class="fixture-tag">{t}</span>{/each}
            </div>
            {#if entry.fixture}
              <p class="fixture-meta">
                File: <code>{entry.fixture}</code> · Est. duration: {entry.duration_estimate_s}s · Persona: <code>{entry.persona_hint}</code>
              </p>
              <details>
                <summary>Docker command for this fixture</summary>
                <pre class="fixture-cmd">{dockerCommandFor(entry)}</pre>
              </details>
            {:else}
              <p class="fixture-gap-note">
                <strong>Gap — no captured fixture yet.</strong>
                Needs Arc to capture this state during a Tier 5 run or
                hand-craft via state injection. See coord docs in
                <code>Desktop/GameDev/APP_CLAUDE_SAVE_FIXTURE_SCAFFOLDING.md</code>.
              </p>
            {/if}
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>

<section class="marketing-queue">
  {#if loading}
    <div class="loading">Loading clips…</div>
  {:else if !manifest}
    <div class="empty">
      <h2>No capture manifest found</h2>
      <p>
        Run an autoplay-capture session to populate the queue. The pipeline
        writes <code>manifest.json</code> + per-clip files to
        <code>.tmp/capture-out/clips/</code> (or the path set by
        <code>CAPTURE_OUT_DIR</code>).
      </p>
      <pre><code>docker run --rm \
  -v ${`$`}{PWD}/.tmp/capture-out:/home/pwuser/out \
  --add-host=host.docker.internal:host-gateway \
  -e DURATION_S=120 \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  allbyte/autoplay-capture</code></pre>
    </div>
  {:else if manifest.clips.length === 0}
    <div class="empty">
      <h2>Manifest found, no clips</h2>
      <p>
        The session at <code>{manifest.source_mp4}</code> produced no
        combat clusters. Try a longer session (<code>DURATION_S=300</code>)
        or a more aggressive persona (<code>PERSONA=default</code>).
      </p>
    </div>
  {:else}
    <aside class="sidebar">
      <h2 class="sidebar-title">
        Clips <span class="count">{manifest.clips.length}</span>
      </h2>
      <p class="sidebar-meta">
        Source: <code>{manifest.source_mp4}</code>
        {#if manifest.persona}<br/>Persona: <code>{manifest.persona}</code>{/if}
      </p>
      <ul class="clip-list">
        {#each manifest.clips as entry}
          {@const isActive = selectedClip === entry.name}
          {@const hasCaptions = !!clipMetas[entry.name]?.draft_captions}
          <li>
            <button
              class="clip-row"
              class:active={isActive}
              onclick={() => (selectedClip = entry.name)}
            >
              <img src={clipThumbUrl(entry.thumb)} alt="" class="thumb" />
              <span class="clip-title">{displayTitle(entry)}</span>
              <span class="clip-badges">
                {#if hasCaptions}
                  <span class="badge captioned" title="Captions drafted">cap</span>
                {:else}
                  <span class="badge no-captions" title="No draft captions">—</span>
                {/if}
              </span>
            </button>
          </li>
        {/each}
      </ul>
    </aside>

    <article class="detail">
      {#if selectedClip}
        {@const entry = findEntry(selectedClip)}
        {@const meta = clipMetas[selectedClip]}
        {#if entry && meta}
          <header class="detail-header">
            <h2>{meta.draft_captions?.title ?? entry.name}</h2>
            <p class="detail-meta">
              <span>Duration: {meta.duration_s.toFixed(1)}s</span>
              <span>Window: {meta.clip_window.start_s.toFixed(1)}s – {meta.clip_window.end_s.toFixed(1)}s</span>
              <span>Events: {meta.event_count}</span>
              {#if meta.persona}<span>Persona: {meta.persona}</span>{/if}
            </p>
          </header>

          <video
            class="player"
            src={clipMp4Url(entry.mp4)}
            controls
            poster={clipThumbUrl(entry.thumb)}
            preload="metadata"
          ></video>

          {#snippet draftButton()}
            {@const ds = draftStates[selectedClip!]}
            {@const as = approveStates[selectedClip!]}
            <div class="header-btn-row">
              <button
                class="draft-btn"
                disabled={!IS_DEV || ds?.busy}
                title={!IS_DEV ? "Drafting needs the local dev server (host's claude CLI)" : ""}
                onclick={() => draftCaptionsForClip(selectedClip!)}
              >
                {ds?.busy ? "Drafting via claude CLI…" : (meta.draft_captions ? "Re-draft captions" : "Draft captions")}
              </button>
              <button
                class="approve-btn"
                disabled={!IS_DEV || as?.busy || !meta.draft_captions}
                title={!IS_DEV ? "Adding to artwork needs the local dev server" : (!meta.draft_captions ? "Draft captions first" : "Copy to durable S3 path + append to recordings.json")}
                onclick={() => approveClipToArtwork(selectedClip!)}
              >
                {as?.busy ? "Adding…" : "Add to artwork"}
              </button>
            </div>
            {#if ds?.result && !ds.result.ok}
              <div class="publish-result err">
                Drafting failed: {ds.result.error ?? "unknown"}
              </div>
            {/if}
            {#if as?.result}
              {@const r = as.result}
              <div class="publish-result" class:ok={r.ok} class:err={!r.ok}>
                {#if r.ok}
                  Added as <code>{r.entry?.id}</code>. Visible on <a href="/artwork/#recordings" target="_blank" rel="noopener">/artwork/</a> as draft (admin-only). Commit <code>src/data/recordings.json</code> to publish.
                {:else}
                  Add failed: {r.error}{r.detail ? ` — ${r.detail}` : ""}
                {/if}
              </div>
            {/if}
          {/snippet}

          {#if meta.draft_captions}
            {@const cap = meta.draft_captions}
            <section class="captions">
              <div class="captions-header">
                <h3>Draft captions</h3>
                {@render draftButton()}
              </div>

              {#snippet captionBlock(field: string, label: string, limit: number | null, rows: number, draft: string | undefined)}
                {@const current = currentCaption(selectedClip!, field, draft)}
                {@const platform = PLATFORM_FOR_FIELD[field]}
                {@const stateKey = platform ? `${selectedClip}.${platform}` : ""}
                {@const pubState = stateKey ? publishStates[stateKey] : undefined}
                <div class="caption-block">
                  <label>
                    <span class="caption-label">
                      {label}
                      <small>{current.length}{limit ? `/${limit}` : " chars"}{limit && current.length > limit ? " — over limit" : ""}</small>
                    </span>
                    <div class="caption-row">
                      <textarea
                        rows={rows}
                        value={current}
                        oninput={(e) => onCaptionInput(selectedClip!, field, e)}
                      ></textarea>
                      <div class="caption-actions">
                        <button onclick={() => copyToClipboard(current, `${selectedClip}-${field}`)}>
                          {copiedKey === `${selectedClip}-${field}` ? "Copied" : "Copy"}
                        </button>
                        {#if platform}
                          <button
                            class="publish-btn"
                            disabled={!IS_DEV || pubState?.busy || !current}
                            title={!IS_DEV ? "Publish requires the local dev server" : ""}
                            onclick={() => publish(selectedClip!, field, findEntry(selectedClip!)?.mp4 ?? "")}
                          >
                            {pubState?.busy ? "Publishing…" : `Publish to ${PLATFORM_LABEL[platform]}`}
                          </button>
                        {/if}
                      </div>
                    </div>
                    {#if pubState?.result}
                      {@const r = pubState.result}
                      <div class="publish-result" class:ok={r.ok} class:err={!r.ok}>
                        {#if r.ok}
                          Posted to {r.integration?.name ?? platform}.
                        {:else}
                          Failed: {r.error}
                        {/if}
                      </div>
                    {/if}
                  </label>
                </div>
              {/snippet}

              {#if cap.title}
                {@render captionBlock("title", "Title", 80, 1, cap.title)}
              {/if}
              {#if cap.bluesky}
                {@render captionBlock("bluesky", "Bluesky", 290, 3, cap.bluesky)}
              {/if}
              {#if cap.discord}
                {@render captionBlock("discord", "Discord", null, 4, cap.discord)}
              {/if}
              {#if cap.youtube_shorts}
                {@render captionBlock("youtube_shorts", "YouTube Shorts", 180, 3, cap.youtube_shorts)}
              {/if}
            </section>
          {:else}
            <section class="captions empty-captions">
              <div class="captions-header">
                <h3>No draft captions</h3>
                {@render draftButton()}
              </div>
              <p>
                Click <strong>Draft captions</strong> to generate caption
                variants via the host's <code>claude</code> CLI (uses your
                Claude Code subscription quota). The script runs locally —
                no API key needed.
              </p>
            </section>
          {/if}

          <details class="raw">
            <summary>Raw clip metadata</summary>
            <pre>{JSON.stringify(meta, null, 2)}</pre>
          </details>
        {:else}
          <div class="loading">Loading clip…</div>
        {/if}
      {/if}
    </article>
  {/if}
</section>

<style>
  .marketing-queue {
    display: grid;
    grid-template-columns: 320px 1fr;
    gap: 1rem;
    max-width: 1600px;
    margin: 0 auto;
    padding: 1rem;
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  .fixture-panel {
    max-width: 1600px;
    margin: 0 auto;
    padding: 1rem 1rem 0;
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
  }
  .fixture-panel-header {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    margin-bottom: 0.5rem;
  }
  .fixture-panel-header h2 {
    font-size: 0.82rem;
    color: var(--crimson);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0;
    display: flex;
    align-items: baseline;
    gap: 0.75rem;
  }
  .coverage-pill {
    font-size: 0.75rem;
    color: var(--ink);
    background: var(--paperblend);
    border: 1px solid var(--rule);
    padding: 0.1rem 0.5rem;
    border-radius: 3px;
    text-transform: none;
    letter-spacing: 0;
  }
  .coverage-warn { color: var(--sem-danger); }
  .coverage-gap  { color: var(--sem-warn); }
  .verify-btn {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    color: var(--crimson);
    padding: 0.25rem 0.6rem;
    font-family: inherit;
    font-size: 0.72rem;
    border-radius: 3px;
    cursor: pointer;
  }
  .verify-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .fixture-list {
    list-style: none;
    padding: 0;
    margin: 0;
    border: 1px solid var(--rule);
    border-radius: 4px;
    background: var(--paperblend);
  }
  .fixture-row { border-bottom: 1px solid var(--rule); }
  .fixture-row:last-child { border-bottom: none; }
  .fixture-row-btn {
    width: 100%;
    background: transparent;
    border: none;
    color: inherit;
    text-align: left;
    padding: 0.5rem 0.75rem;
    display: grid;
    grid-template-columns: 24px 90px 1fr auto auto;
    gap: 0.75rem;
    align-items: baseline;
    cursor: pointer;
    font-family: inherit;
    font-size: 0.8rem;
  }
  .fixture-row-btn:hover { background: var(--paperblend); }
  .fixture-row.selected .fixture-row-btn { background: var(--paperblend); }
  .fixture-status {
    text-align: center;
    font-weight: bold;
    font-size: 0.9rem;
  }
  .status-available { color: var(--crimson); }
  .status-missing   { color: var(--sem-danger); }
  .status-gap       { color: var(--sem-warn); }
  .status-unchecked { color: var(--ink-soft); }
  .fixture-category {
    color: var(--crimson);
    background: var(--paperblend);
    padding: 0.05rem 0.4rem;
    border-radius: 2px;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .fixture-title {
    color: var(--ink);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .fixture-cond, .fixture-scene {
    color: var(--ink-soft);
    font-size: 0.72rem;
  }
  .fixture-detail {
    padding: 0.25rem 0.75rem 0.75rem 0.75rem;
    background: var(--paperblend);
    border-top: 1px dashed var(--rule);
  }
  .fixture-notes {
    color: var(--ink);
    font-size: 0.78rem;
    margin: 0.25rem 0;
  }
  .fixture-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; margin: 0.25rem 0; }
  .fixture-tag {
    font-size: 0.68rem;
    background: var(--paperblend);
    border: 1px solid var(--rule);
    color: var(--crimson);
    padding: 0.05rem 0.35rem;
    border-radius: 2px;
  }
  .fixture-meta { color: var(--ink-soft); font-size: 0.72rem; margin: 0.25rem 0; }
  .fixture-meta code { color: var(--crimson); }
  .fixture-cmd {
    background: #0f1420;
    border: 1px solid var(--rule);
    color: var(--crimson);
    padding: 0.5rem;
    border-radius: 3px;
    overflow-x: auto;
    font-size: 0.72rem;
    margin: 0.25rem 0;
  }
  .fixture-gap-note {
    color: var(--sem-warn);
    font-size: 0.78rem;
    margin: 0.5rem 0;
  }
  .fixture-gap-note code { color: var(--ink); }

  .loading, .empty {
    grid-column: 1 / -1;
    padding: 3rem 1rem;
    text-align: center;
    color: var(--ink-soft);
  }
  .empty h2 {
    color: var(--ink);
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  .empty pre {
    text-align: left;
    background: #0f1420;
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 0.75rem;
    overflow-x: auto;
    color: var(--crimson);
    font-size: 0.78rem;
    margin: 1rem auto;
    max-width: 700px;
  }
  .empty code {
    color: var(--crimson);
    background: var(--paperblend);
    padding: 0.05rem 0.3rem;
    border-radius: 2px;
  }

  .sidebar {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 0.75rem;
    min-height: 60vh;
  }
  .sidebar-title {
    font-size: 0.82rem;
    color: var(--crimson);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 0.25rem;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .sidebar-title .count {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    color: var(--crimson);
    font-size: 0.78rem;
  }
  .sidebar-meta {
    font-size: 0.75rem;
    color: var(--ink-soft);
    margin: 0 0 0.75rem;
    word-break: break-all;
  }
  .sidebar-meta code {
    color: var(--ink);
  }

  .clip-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .clip-row {
    width: 100%;
    background: transparent;
    border: 1px solid transparent;
    color: inherit;
    text-align: left;
    padding: 0.4rem;
    display: grid;
    grid-template-columns: 64px 1fr auto;
    gap: 0.5rem;
    align-items: center;
    cursor: pointer;
    font-family: inherit;
    border-radius: 3px;
    margin-bottom: 0.25rem;
    transition: background 0.1s ease;
  }
  .clip-row:hover {
    background: var(--paperblend);
  }
  .clip-row.active {
    background: var(--paperblend);
    border-color: var(--rule);
  }
  .thumb {
    width: 64px;
    height: 36px;
    object-fit: cover;
    border-radius: 2px;
    background: var(--panel);
  }
  .clip-title {
    font-size: 0.78rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .clip-badges {
    display: flex;
    gap: 0.2rem;
  }
  .badge {
    font-size: 0.65rem;
    padding: 0.05rem 0.3rem;
    border-radius: 2px;
    border: 1px solid;
  }
  .badge.captioned {
    color: var(--crimson);
    border-color: var(--rule);
    background: var(--paperblend);
  }
  .badge.no-captions {
    color: var(--ink-soft);
    border-color: rgba(107, 114, 128, 0.3);
    background: rgba(107, 114, 128, 0.05);
  }

  .detail {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    border-radius: 4px;
    padding: 1rem;
    min-height: 60vh;
  }
  .detail-header h2 {
    color: var(--ink);
    font-size: 1rem;
    margin: 0 0 0.4rem;
  }
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: var(--ink-soft);
    margin: 0 0 1rem;
  }
  .player {
    width: 100%;
    max-height: 60vh;
    background: var(--panel);
    border-radius: 4px;
    border: 1px solid var(--rule);
  }

  .captions {
    margin-top: 1rem;
  }
  .captions h3 {
    font-size: 0.82rem;
    color: var(--crimson);
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 0.5rem;
  }
  .captions-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    margin-bottom: 0.5rem;
  }
  .captions-header h3 {
    margin: 0;
  }
  .header-btn-row {
    display: flex;
    gap: 0.4rem;
    flex-wrap: wrap;
  }
  .draft-btn, .approve-btn {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    color: var(--crimson);
    padding: 0.4rem 0.8rem;
    font-family: inherit;
    font-size: 0.78rem;
    border-radius: 3px;
    cursor: pointer;
  }
  .draft-btn:hover:not(:disabled),
  .approve-btn:hover:not(:disabled) {
    background: var(--paperblend);
  }
  .draft-btn:disabled, .approve-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .approve-btn {
    background: rgba(251, 191, 36, 0.1);
    border-color: var(--sem-warn);
    color: var(--sem-warn);
  }
  .approve-btn:hover:not(:disabled) {
    background: rgba(251, 191, 36, 0.22);
  }
  .empty-captions p {
    color: var(--ink-soft);
    font-size: 0.85rem;
  }
  .empty-captions code {
    color: var(--crimson);
  }
  .caption-block {
    margin-bottom: 0.75rem;
  }
  .caption-label {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: var(--crimson);
    margin-bottom: 0.25rem;
  }
  .caption-label small {
    color: var(--ink-soft);
    font-size: 0.7rem;
  }
  .caption-row {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.5rem;
    align-items: start;
  }
  .caption-row textarea {
    width: 100%;
    background: #0f1420;
    border: 1px solid var(--rule);
    color: var(--ink);
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.5rem;
    border-radius: 3px;
    resize: vertical;
  }
  .caption-row textarea:focus {
    outline: 1px solid var(--rule);
  }
  .caption-actions {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 9rem;
  }
  .caption-row button {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    color: var(--crimson);
    padding: 0.4rem 0.7rem;
    font-family: inherit;
    font-size: 0.78rem;
    border-radius: 3px;
    cursor: pointer;
    height: max-content;
  }
  .caption-row button:hover:not(:disabled) {
    background: var(--paperblend);
  }
  .caption-row button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .publish-btn {
    background: rgba(251, 191, 36, 0.1) !important;
    border-color: var(--sem-warn) !important;
    color: var(--sem-warn) !important;
  }
  .publish-btn:hover:not(:disabled) {
    background: rgba(251, 191, 36, 0.22) !important;
  }
  .publish-result {
    margin-top: 0.4rem;
    padding: 0.4rem 0.6rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-family: inherit;
  }
  .publish-result.ok {
    background: var(--paperblend);
    border: 1px solid var(--rule);
    color: var(--crimson);
  }
  .publish-result.err {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.3);
    color: var(--sem-danger);
    word-break: break-word;
  }

  .raw {
    margin-top: 1.5rem;
    border-top: 1px dashed var(--rule);
    padding-top: 0.75rem;
  }
  .raw summary {
    cursor: pointer;
    font-size: 0.75rem;
    color: var(--ink-soft);
  }
  .raw pre {
    background: #0f1420;
    border: 1px solid var(--rule);
    border-radius: 3px;
    padding: 0.5rem;
    font-size: 0.72rem;
    overflow-x: auto;
    color: var(--crimson);
    margin-top: 0.5rem;
  }

  @media (max-width: 900px) {
    .marketing-queue {
      grid-template-columns: 1fr;
    }
  }
</style>
