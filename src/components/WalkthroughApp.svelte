<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast, isAdmin } from "../lib/tier";
  import { onMount } from "svelte";
  import {
    walkthrough, chapterTitle, clipMp4Url, clipThumbUrl,
    type Chapter, type ClipRef,
  } from "../lib/walkthrough";

  let authChecked = $state(false);
  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "legend"));
  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  // Filter drafts for non-admins; admin sees all.
  let visibleChapters = $derived(
    viewerIsAdmin
      ? walkthrough.chapters
      : walkthrough.chapters.filter((c) => !c.draft)
  );

  let selectedChapterId = $state<string | null>(null);
  let selectedChapter = $derived(
    selectedChapterId
      ? visibleChapters.find((c) => c.id === selectedChapterId) ?? null
      : visibleChapters[0] ?? null
  );

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    authChecked = true;
  });

  function fmtDuration(s?: number): string {
    if (s === undefined || s === null) return "—";
    const m = Math.floor(s / 60);
    const sec = Math.round(s - m * 60);
    return `${m}m ${sec}s`;
  }
</script>

<section class="walkthrough">
  {#if !authChecked}
    <div class="loading">Checking access…</div>
  {:else if !viewerHasAccess}
    <div class="locked">
      <h1>The Walkthrough</h1>
      <p class="lede">
        A chapter-by-chapter playthrough of The Chronicles of Nesis —
        scene-by-scene, with screenshots, area maps, dialogue excerpts,
        and combat strategy notes. Captured by an autoplay system that
        explores every room, talks to every NPC, finds every item, and
        fights every encounter.
      </p>
      <p class="gate">
        Available to <strong>Legend</strong> supporters.
      </p>
      <a href="/subscribe/" class="cta">Support the studio</a>
    </div>
  {:else if walkthrough.chapters.length === 0}
    <div class="empty">
      <h1>The Walkthrough</h1>
      <p>
        Chapters are coming. The Completionist autoplay batches haven't
        run yet — once they do, scenes, dialogue, encounters, and items
        from across the entire story will assemble into a published-style
        walkthrough here.
      </p>
      {#if viewerIsAdmin}
        <details class="admin-debug">
          <summary>Admin debug</summary>
          <p>
            Skeleton ready. To produce the first chapter:
          </p>
          <ol>
            <li>Run a capture against any save fixture</li>
            <li><code>chapter_extractor.py</code> runs automatically and
              writes <code>.tmp/capture-out/chapters/&lt;id&gt;.chapter.json</code></li>
            <li>Aggregate those into <code>src/data/walkthrough.json</code>
              (aggregator script TODO)</li>
            <li>Commit + push — chapters render here</li>
          </ol>
          <p>
            Coordination doc with Arc:
            <code>APP_CLAUDE_COMPLETIONIST_AND_WALKTHROUGH_EVENTS.md</code>
          </p>
        </details>
      {/if}
    </div>
  {:else}
    <aside class="chapter-nav">
      <h2 class="nav-title">Chapters</h2>
      <ul>
        {#each visibleChapters as ch}
          <li>
            <button
              class="chapter-link"
              class:active={(selectedChapterId ?? visibleChapters[0]?.id) === ch.id}
              onclick={() => (selectedChapterId = ch.id)}
            >
              {chapterTitle(ch)}
              {#if ch.draft}<span class="draft-tag">draft</span>{/if}
            </button>
          </li>
        {/each}
      </ul>
    </aside>

    <article class="chapter-body">
      {#if selectedChapter}
        {@const ch = selectedChapter}
        <header class="chapter-header">
          <h1>{chapterTitle(ch)}</h1>
          <p class="chapter-meta">
            {#if ch.persona}<span>Persona: <strong>{ch.persona}</strong></span>{/if}
            <span>Duration: <strong>{fmtDuration(ch.duration_s)}</strong></span>
            {#if ch.cond_at_start !== null && ch.cond_at_end !== null}
              <span>Cond: {ch.cond_at_start} → {ch.cond_at_end}</span>
            {/if}
          </p>
          {#if ch.hero_image}
            <img src={ch.hero_image} alt="" class="hero-image" />
          {/if}
        </header>

        {#if ch.ai_summary}
          <section class="prose summary">
            <h2>Summary</h2>
            <p>{ch.ai_summary}</p>
          </section>
        {/if}

        {#if ch.manual_notes}
          <section class="prose owner-notes">
            <h2>Notes</h2>
            <p>{ch.manual_notes}</p>
          </section>
        {/if}

        {#if ch.scenes_visited.length > 0}
          <section class="scenes-section">
            <h2>Scenes visited</h2>
            <ul class="scenes-list">
              {#each ch.scenes_visited as scene}
                <li>
                  <strong>{scene.anchor}</strong>
                  <span class="muted">
                    — {fmtDuration(scene.dwell_s)}
                    {#if scene.first_visit}<em>(first visit)</em>{/if}
                  </span>
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if ch.dialogue.length > 0}
          <section class="dialogue-section">
            <h2>Dialogue highlights</h2>
            {#each ch.dialogue as line}
              <blockquote class="dialogue-line">
                {#if line.speaker}<cite>{line.speaker}</cite>{/if}
                <p>"{line.text}"</p>
              </blockquote>
            {/each}
          </section>
        {/if}

        {#if ch.encounters.length > 0}
          <section class="encounters-section">
            <h2>Encounters</h2>
            <ul class="encounter-list">
              {#each ch.encounters as enc, i}
                <li>
                  <strong>Encounter {i + 1}</strong>
                  — {fmtDuration(enc.duration_s)}, {enc.kills} kill{enc.kills === 1 ? "" : "s"}
                  {#if enc.skill_uses > 0}, {enc.skill_uses} skill use{enc.skill_uses === 1 ? "" : "s"}{/if}
                </li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if ch.items_found.length > 0}
          <section class="items-section">
            <h2>Items found</h2>
            <ul class="items-list">
              {#each ch.items_found as item}
                <li>{item.item_name ?? item.item_id} {#if item.scene}<span class="muted">— {item.scene}</span>{/if}</li>
              {/each}
            </ul>
          </section>
        {/if}

        {#if ch.clips.length > 0}
          <section class="clips-section">
            <h2>Clips</h2>
            <div class="clip-grid">
              {#each ch.clips as clip}
                <figure class="clip-tile">
                  <video
                    src={clipMp4Url(ch, clip)}
                    poster={clipThumbUrl(ch, clip)}
                    controls
                    preload="metadata"
                  ></video>
                  <figcaption>{clip.name}</figcaption>
                </figure>
              {/each}
            </div>
          </section>
        {/if}
      {/if}
    </article>
  {/if}
</section>

<style>
  .walkthrough {
    max-width: 1200px;
    margin: 0 auto;
    padding: 2rem 1.5rem 3rem;
    color: #2a1f1a;
    font-family: "AllByteCustom", "Cardo", Georgia, serif;
  }

  .loading, .locked, .empty {
    text-align: center;
    padding: 3rem 1rem;
  }
  .locked h1, .empty h1 {
    font-size: 2.5rem;
    margin: 0 0 1.5rem;
    color: #2a1f1a;
  }
  .lede {
    font-size: 1.1rem;
    line-height: 1.6;
    max-width: 640px;
    margin: 0 auto 1.5rem;
  }
  .gate {
    font-size: 1rem;
    margin: 1.5rem 0;
    color: #4a2f1a;
  }
  .cta {
    display: inline-block;
    margin-top: 1rem;
    padding: 0.75rem 1.5rem;
    background: #2a1f1a;
    color: #f4ebd0;
    border-radius: 4px;
    text-decoration: none;
    font-weight: 600;
  }
  .cta:hover {
    background: #4a2f1a;
  }
  .admin-debug {
    margin-top: 2rem;
    text-align: left;
    background: rgba(42, 31, 26, 0.05);
    border: 1px solid rgba(42, 31, 26, 0.15);
    padding: 1rem;
    border-radius: 4px;
    max-width: 640px;
    margin-left: auto;
    margin-right: auto;
  }
  .admin-debug summary {
    cursor: pointer;
    font-weight: 600;
  }
  .admin-debug code {
    background: rgba(42, 31, 26, 0.08);
    padding: 0.1rem 0.3rem;
    border-radius: 2px;
    font-family: "Courier New", monospace;
    font-size: 0.9rem;
  }

  /* Populated walkthrough — chapter nav + body layout */
  .walkthrough:has(.chapter-nav) {
    display: grid;
    grid-template-columns: 260px 1fr;
    gap: 2rem;
  }
  .chapter-nav {
    border-right: 1px solid rgba(42, 31, 26, 0.15);
    padding-right: 1rem;
  }
  .nav-title {
    font-size: 1rem;
    margin: 0 0 0.75rem;
    color: #4a2f1a;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .chapter-nav ul {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .chapter-link {
    width: 100%;
    text-align: left;
    background: none;
    border: none;
    padding: 0.5rem 0.5rem;
    font-family: inherit;
    font-size: 0.95rem;
    color: #2a1f1a;
    cursor: pointer;
    border-left: 3px solid transparent;
  }
  .chapter-link:hover {
    background: rgba(42, 31, 26, 0.05);
  }
  .chapter-link.active {
    border-left-color: #2a1f1a;
    font-weight: 600;
  }
  .draft-tag {
    display: inline-block;
    margin-left: 0.5rem;
    padding: 0.05rem 0.35rem;
    background: rgba(251, 191, 36, 0.2);
    border: 1px solid rgba(251, 191, 36, 0.4);
    color: #92400e;
    border-radius: 2px;
    font-size: 0.7rem;
    text-transform: uppercase;
  }

  .chapter-body {
    min-height: 60vh;
  }
  .chapter-header h1 {
    font-size: 2rem;
    margin: 0 0 0.5rem;
    color: #2a1f1a;
  }
  .chapter-meta {
    color: #4a2f1a;
    font-size: 0.9rem;
    margin: 0 0 1.5rem;
    display: flex;
    gap: 1.25rem;
    flex-wrap: wrap;
  }
  .hero-image {
    width: 100%;
    border-radius: 4px;
    margin-bottom: 1.5rem;
  }

  .prose {
    margin: 1.5rem 0;
    line-height: 1.7;
    font-size: 1.05rem;
  }
  .prose h2 {
    font-size: 1.4rem;
    margin: 0 0 0.5rem;
  }
  .summary p, .owner-notes p {
    margin: 0;
  }

  .scenes-section, .dialogue-section, .encounters-section, .items-section, .clips-section {
    margin: 1.5rem 0;
  }
  .scenes-section h2, .dialogue-section h2, .encounters-section h2, .items-section h2, .clips-section h2 {
    font-size: 1.4rem;
    margin: 0 0 0.5rem;
  }
  .scenes-list, .items-list, .encounter-list {
    list-style: none;
    padding: 0;
    margin: 0;
  }
  .scenes-list li, .items-list li, .encounter-list li {
    padding: 0.4rem 0;
    border-bottom: 1px dotted rgba(42, 31, 26, 0.15);
    font-size: 0.95rem;
  }
  .scenes-list li:last-child, .items-list li:last-child, .encounter-list li:last-child {
    border-bottom: none;
  }
  .muted {
    color: #6b5e4a;
    font-style: italic;
  }

  .dialogue-line {
    margin: 0.75rem 0;
    padding: 0.75rem 1rem;
    border-left: 3px solid #2a1f1a;
    background: rgba(42, 31, 26, 0.04);
  }
  .dialogue-line cite {
    font-style: normal;
    font-weight: 600;
    color: #4a2f1a;
    margin-bottom: 0.25rem;
    display: block;
  }
  .dialogue-line p {
    margin: 0;
    font-style: italic;
  }

  .clip-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
    gap: 1rem;
    margin-top: 0.75rem;
  }
  .clip-tile {
    margin: 0;
    background: #2a1f1a;
    border-radius: 4px;
    overflow: hidden;
  }
  .clip-tile video {
    width: 100%;
    display: block;
  }
  .clip-tile figcaption {
    padding: 0.4rem 0.6rem;
    color: #f4ebd0;
    font-size: 0.8rem;
    font-family: "Courier New", monospace;
  }

  @media (max-width: 900px) {
    .walkthrough:has(.chapter-nav) {
      grid-template-columns: 1fr;
    }
    .chapter-nav {
      border-right: none;
      border-bottom: 1px solid rgba(42, 31, 26, 0.15);
      padding-right: 0;
      padding-bottom: 1rem;
      margin-bottom: 1rem;
    }
  }
</style>
