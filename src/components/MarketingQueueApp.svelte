<script lang="ts">
  import { onMount } from "svelte";
  import {
    fetchManifest, fetchClipMeta, publishToPlatform,
    clipMp4Url, clipThumbUrl,
    type Manifest, type ManifestEntry, type ClipMeta, type PublishResult,
  } from "../lib/marketingQueue";

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

          {#if meta.draft_captions}
            {@const cap = meta.draft_captions}
            <section class="captions">
              <h3>Draft captions</h3>

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
              <h3>No draft captions</h3>
              <p>
                The caption drafter didn't run for this clip. Common causes:
                <code>ANTHROPIC_API_KEY</code> wasn't set in the container,
                or the Claude call failed. Re-run
                <code>caption_drafter.py</code> against the clips dir to
                retry.
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
    color: #d1d5db;
    font-family: "Courier New", monospace;
  }

  .loading, .empty {
    grid-column: 1 / -1;
    padding: 3rem 1rem;
    text-align: center;
    color: #6b7280;
  }
  .empty h2 {
    color: #d1d5db;
    font-size: 1rem;
    margin: 0 0 0.5rem;
  }
  .empty pre {
    text-align: left;
    background: #0f1420;
    border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 4px;
    padding: 0.75rem;
    overflow-x: auto;
    color: #a7f3d0;
    font-size: 0.78rem;
    margin: 1rem auto;
    max-width: 700px;
  }
  .empty code {
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.08);
    padding: 0.05rem 0.3rem;
    border-radius: 2px;
  }

  .sidebar {
    background: rgba(167, 243, 208, 0.03);
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 4px;
    padding: 0.75rem;
    min-height: 60vh;
  }
  .sidebar-title {
    font-size: 0.82rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 0.25rem;
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }
  .sidebar-title .count {
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.25);
    padding: 0.05rem 0.4rem;
    border-radius: 3px;
    color: #a7f3d0;
    font-size: 0.78rem;
  }
  .sidebar-meta {
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0 0 0.75rem;
    word-break: break-all;
  }
  .sidebar-meta code {
    color: #d1d5db;
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
    background: rgba(167, 243, 208, 0.06);
  }
  .clip-row.active {
    background: rgba(167, 243, 208, 0.1);
    border-color: rgba(167, 243, 208, 0.3);
  }
  .thumb {
    width: 64px;
    height: 36px;
    object-fit: cover;
    border-radius: 2px;
    background: #0a0e17;
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
    color: #a7f3d0;
    border-color: rgba(167, 243, 208, 0.4);
    background: rgba(167, 243, 208, 0.08);
  }
  .badge.no-captions {
    color: #6b7280;
    border-color: rgba(107, 114, 128, 0.3);
    background: rgba(107, 114, 128, 0.05);
  }

  .detail {
    background: rgba(167, 243, 208, 0.02);
    border: 1px solid rgba(167, 243, 208, 0.08);
    border-radius: 4px;
    padding: 1rem;
    min-height: 60vh;
  }
  .detail-header h2 {
    color: #d1d5db;
    font-size: 1rem;
    margin: 0 0 0.4rem;
  }
  .detail-meta {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    font-size: 0.75rem;
    color: #6b7280;
    margin: 0 0 1rem;
  }
  .player {
    width: 100%;
    max-height: 60vh;
    background: #0a0e17;
    border-radius: 4px;
    border: 1px solid rgba(167, 243, 208, 0.1);
  }

  .captions {
    margin-top: 1rem;
  }
  .captions h3 {
    font-size: 0.82rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin: 0 0 0.5rem;
  }
  .empty-captions p {
    color: #6b7280;
    font-size: 0.85rem;
  }
  .empty-captions code {
    color: #a7f3d0;
  }
  .caption-block {
    margin-bottom: 0.75rem;
  }
  .caption-label {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    font-size: 0.78rem;
    color: #a7f3d0;
    margin-bottom: 0.25rem;
  }
  .caption-label small {
    color: #6b7280;
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
    border: 1px solid rgba(167, 243, 208, 0.15);
    color: #d1d5db;
    font-family: inherit;
    font-size: 0.82rem;
    padding: 0.5rem;
    border-radius: 3px;
    resize: vertical;
  }
  .caption-row textarea:focus {
    outline: 1px solid rgba(167, 243, 208, 0.4);
  }
  .caption-actions {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    min-width: 9rem;
  }
  .caption-row button {
    background: rgba(167, 243, 208, 0.12);
    border: 1px solid rgba(167, 243, 208, 0.35);
    color: #a7f3d0;
    padding: 0.4rem 0.7rem;
    font-family: inherit;
    font-size: 0.78rem;
    border-radius: 3px;
    cursor: pointer;
    height: max-content;
  }
  .caption-row button:hover:not(:disabled) {
    background: rgba(167, 243, 208, 0.22);
  }
  .caption-row button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .publish-btn {
    background: rgba(251, 191, 36, 0.1) !important;
    border-color: rgba(251, 191, 36, 0.4) !important;
    color: #fbbf24 !important;
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
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.3);
    color: #a7f3d0;
  }
  .publish-result.err {
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.3);
    color: #f87171;
    word-break: break-word;
  }

  .raw {
    margin-top: 1.5rem;
    border-top: 1px dashed rgba(167, 243, 208, 0.1);
    padding-top: 0.75rem;
  }
  .raw summary {
    cursor: pointer;
    font-size: 0.75rem;
    color: #6b7280;
  }
  .raw pre {
    background: #0f1420;
    border: 1px solid rgba(167, 243, 208, 0.1);
    border-radius: 3px;
    padding: 0.5rem;
    font-size: 0.72rem;
    overflow-x: auto;
    color: #a7f3d0;
    margin-top: 0.5rem;
  }

  @media (max-width: 900px) {
    .marketing-queue {
      grid-template-columns: 1fr;
    }
  }
</style>
