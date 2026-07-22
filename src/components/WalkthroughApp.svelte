<script lang="ts">
  /**
   * Walkthrough — linear magazine-scroll renderer (2026-06-16 design).
   *
   * Renders the Laria scene graph (src/data/walkthrough-scenes.json, via
   * src/lib/walkthroughScenes.ts) as a vertical strategy-guide: one spread per
   * scene in canonical order, each with a looping-video hero, drop-cap guide
   * prose, callout boxes, and a click-to-jump EXITS ribbon. A sticky mini-map
   * tracks the reader's position; a per-scene control plays the area's theme
   * through the global MusicPlayer.
   *
   * Media is null in the stub — heroes show a "capture pending" placeholder
   * until the capture pipeline runs against Arc's _testWarpToScene hook.
   * Tier-gating is intentionally absent: that decision is still open, so the
   * scaffold renders publicly. (TODO: gate when the owner decides.)
   */
  import { onMount } from "svelte";
  import assetIndex from "../data/asset-index.json";
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import {
    sceneGraph, scenesInOrder, sceneById, isInternalExit,
    sceneClipUrl, sceneStillUrl,
    CALLOUT_GLYPH, KIND_LABEL, presetLabel,
    type WalkScene, type SceneExit,
  } from "../lib/walkthroughScenes";

  // Walkthrough is in progress: admins preview it to iterate; it ships as a
  // Legend-tier feature. (Dev initAuth auto-admins, so it's visible locally.)
  let authChecked = $state(false);
  let canView = $derived(isAdmin(auth.currentUser));
  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) { await new Promise((r) => setTimeout(r, 100)); waited += 100; }
    authChecked = true;
  });

  const scenes = scenesInOrder();
  let activeSceneId = $state<string>(scenes[0]?.id ?? "");

  let sectionNodes: HTMLElement[] = [];
  function sceneSection(node: HTMLElement) {
    sectionNodes.push(node);
    return {
      destroy() {
        sectionNodes = sectionNodes.filter((n) => n !== node);
      },
    };
  }

  function scrollToScene(id: string) {
    document.getElementById(`scene-${id}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  }

  // --- MusicPlayer hookup ---------------------------------------------------
  // Resolve a scene's `music` id to a track in the asset index (loose name
  // match), defaulting to the Laria theme. Playing is a user gesture (button),
  // which keeps us on the right side of browser autoplay policy.
  let musicLoaded = false;
  function resolveTrackIndex(music: string | null): number {
    const tracks = assetIndex.music as Array<{ name: string; file: string }>;
    if (music) {
      const key = music.toLowerCase();
      const exact = tracks.findIndex((t) => t.name.toLowerCase() === key);
      if (exact >= 0) return exact;
      const partial = tracks.findIndex((t) =>
        key.includes(t.name.toLowerCase()) || t.name.toLowerCase().includes("laria")
      );
      if (partial >= 0) return partial;
    }
    const laria = tracks.findIndex((t) => t.name.toLowerCase().includes("laria"));
    return laria >= 0 ? laria : 0;
  }
  function playSceneTheme(scene: WalkScene) {
    const index = resolveTrackIndex(scene.music);
    if (!musicLoaded) {
      window.dispatchEvent(new CustomEvent("music-player:load", {
        detail: { tracks: assetIndex.music, index },
      }));
      musicLoaded = true;
    } else {
      window.dispatchEvent(new CustomEvent("music-player:play", {
        detail: { index },
      }));
    }
  }

  // --- Video hero: click to unmute ------------------------------------------
  function toggleHeroSound(e: MouseEvent) {
    const v = e.currentTarget as HTMLVideoElement;
    v.muted = !v.muted;
    if (!v.muted) v.play().catch(() => {});
  }

  // --- Active-scene tracking for the mini-map -------------------------------
  onMount(() => {
    const ratios = new Map<string, number>();
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          const id = (e.target as HTMLElement).dataset.sceneId ?? "";
          ratios.set(id, e.isIntersecting ? e.intersectionRatio : 0);
        }
        let best = activeSceneId;
        let bestRatio = -1;
        for (const [id, r] of ratios) {
          if (r > bestRatio) { bestRatio = r; best = id; }
        }
        if (bestRatio > 0) activeSceneId = best;
      },
      { rootMargin: "-30% 0px -55% 0px", threshold: [0, 0.25, 0.5, 0.75, 1] }
    );
    sectionNodes.forEach((n) => io.observe(n));
    return () => io.disconnect();
  });

  function exitTarget(exit: SceneExit): WalkScene | undefined {
    return isInternalExit(exit) ? sceneById(exit.to) : undefined;
  }

  // Indent interiors under their hub in the mini-map.
  const isChild = (s: WalkScene) => s.parentScene !== null;
</script>

{#if !authChecked}
  <div class="wt-gate"><p>Loading…</p></div>
{:else if !canView}
  <div class="wt-gate">
    <h1 class="wt-gate-title">Walkthrough</h1>
    <p class="wt-gate-lead">A published-style, scene-by-scene guide to The Chronicles of Nesis — stills, maps, items, and routing.</p>
    <p class="wt-gate-status"><span aria-hidden="true">🔒</span> In progress — shipping as a <strong>Legend</strong>-tier perk.</p>
    <a class="wt-gate-cta" href="/subscribe/">See the tiers</a>
  </div>
{:else}
<div class="wt">
  <!-- Sticky mini-map / table of contents -->
  <aside class="wt-map" aria-label="Scene map">
    <div class="wt-map-inner">
      <h2 class="wt-map-title">Laria</h2>
      <p class="wt-map-sub">Village walkthrough</p>
      <nav>
        <ol>
          {#each scenes as s (s.id)}
            <li class:child={isChild(s)} class:active={s.id === activeSceneId}>
              <button type="button" onclick={() => scrollToScene(s.id)}>
                <span class="dot" data-kind={s.kind}></span>
                <span class="nm">{s.displayName}</span>
              </button>
            </li>
          {/each}
        </ol>
      </nav>
      <p class="wt-map-foot">→ Waterways <em>(separate section)</em></p>
      {#if sceneGraph.stub}
        <p class="wt-stub-badge">STUB DATA · captures pending</p>
      {/if}
    </div>
  </aside>

  <!-- The magazine scroll -->
  <div class="wt-scroll">
    {#each scenes as scene, i (scene.id)}
      <section
        id={`scene-${scene.id}`}
        class="spread"
        data-scene-id={scene.id}
        use:sceneSection
      >
        <header class="spread-head">
          {#if scene.parentScene}
            <p class="parent-crumb">
              <button type="button" class="link" onclick={() => scrollToScene(scene.parentScene!)}>
                {sceneById(scene.parentScene)?.displayName ?? scene.parentScene}
              </button>
              <span aria-hidden="true"> › </span>
            </p>
          {/if}
          <h2 class="scene-title">{scene.displayName}</h2>
          <p class="scene-lead">{scene.lead}</p>
          <div class="scene-meta">
            <span class="chip kind" data-kind={scene.kind}>{KIND_LABEL[scene.kind]}</span>
            <span class="chip">Party · {presetLabel(scene.partyPreset)}</span>
            {#if scene.music}
              <button type="button" class="chip play" onclick={() => playSceneTheme(scene)}>
                ♪ Play theme
              </button>
            {/if}
          </div>
        </header>

        <div class="spread-body">
          <!-- Hero: looping video when captured, placeholder until then -->
          <figure class="hero">
            {#if sceneClipUrl(scene)}
              <!-- svelte-ignore a11y_media_has_caption -->
              <video
                src={sceneClipUrl(scene)}
                poster={sceneStillUrl(scene) ?? undefined}
                autoplay loop muted playsinline
                onclick={toggleHeroSound}
                title="Click for sound"
              ></video>
            {:else if sceneStillUrl(scene)}
              <img class="hero-img" src={sceneStillUrl(scene)} alt={`${scene.displayName} — Chronicles of Nesis`} loading="lazy" />
            {:else}
              <div class="hero-stub" role="img" aria-label={`${scene.displayName} — capture pending`}>
                <span class="film">▶</span>
                <span class="hero-name">{scene.displayName}</span>
                <span class="pending">Capture pending</span>
              </div>
            {/if}

            <!-- Consistent per-scene info box: items + scene transitions -->
            <div class="still-box">
              {#if scene.items.length}
                <div class="sb-row">
                  <span class="sb-label">Items</span>
                  <span class="sb-vals">{scene.items.join("  ·  ")}</span>
                </div>
              {/if}
              <div class="sb-row">
                <span class="sb-label">Exits</span>
                <span class="sb-vals exits">
                  {#each scene.exits as exit}
                    {@const target = exitTarget(exit)}
                    {#if target}
                      <button type="button" class="sb-exit" onclick={() => scrollToScene(target.id)}>→ {target.displayName}</button>
                    {:else}
                      <span class="sb-exit ext" title="Outside this section">⇥ {exit.to}</span>
                    {/if}
                  {/each}
                </span>
              </div>
            </div>
          </figure>

          <!-- Guide prose -->
          <div class="guide">
            <p class="guide-text">{scene.guide}</p>

            {#if scene.callouts.length}
              <div class="callouts">
                {#each scene.callouts as c}
                  <aside class="callout" data-kind={c.kind}>
                    <p class="callout-title">
                      <span class="glyph" aria-hidden="true">{CALLOUT_GLYPH[c.kind]}</span>
                      {c.title}
                    </p>
                    <p class="callout-body">{c.body}</p>
                  </aside>
                {/each}
              </div>
            {/if}
          </div>
        </div>

        {#if i < scenes.length - 1}
          <div class="rule" aria-hidden="true">❧</div>
        {/if}
      </section>
    {/each}

    <footer class="wt-end">
      <p>The road west leads to the <strong>Waterways</strong> — a separate section of the guide.</p>
    </footer>
  </div>
</div>
{/if}

<style>
  .wt-gate {
    max-width: 560px; margin: 4rem auto; padding: 2rem 1.5rem; text-align: center;
    color: #3a2f1c;
  }
  .wt-gate-title { font-family: "AllByteCustom", serif; font-size: 2.5rem; color: #8a5a2b; margin: 0 0 0.75rem; }
  .wt-gate-lead { font-size: 1.05rem; line-height: 1.6; color: #6b5b3a; margin: 0 0 1.25rem; }
  .wt-gate-status { font-size: 1rem; color: #3a2f1c; margin: 0 0 1.5rem; }
  .wt-gate-cta {
    display: inline-block; font-family: "AllByteCustom", serif; font-size: 1.1rem;
    background: #8a5a2b; color: #fff; padding: 0.6rem 1.6rem; border-radius: 4px; text-decoration: none;
  }
  .wt-gate-cta:hover { background: #744a22; }

  /* Heart-theme parchment magazine. */
  .wt {
    --parch: #f4ebd0;
    --parch-2: #ece0bd;
    --ink: #3a2f1c;
    --ink-soft: #6b5b3a;
    --accent: #8a5a2b;
    --rule: #cbb682;
    display: grid;
    grid-template-columns: 230px minmax(0, 1fr);
    gap: 2rem;
    max-width: 1180px;
    margin: 0 auto;
    padding: 1.5rem 1.25rem 4rem;
    color: var(--ink);
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
  }

  /* ---- Mini-map ---- */
  .wt-map { position: relative; }
  .wt-map-inner {
    position: sticky;
    top: 1.25rem;
    background: var(--parch-2);
    border: 1px solid var(--rule);
    border-radius: 8px;
    padding: 1rem 0.9rem;
  }
  .wt-map-title {
    font-family: "AllByteCustom", serif;
    font-size: 1.7rem;
    line-height: 1;
    margin: 0;
    color: var(--accent);
  }
  .wt-map-sub { margin: 0.15rem 0 0.75rem; font-size: 0.8rem; color: var(--ink-soft); }
  .wt-map ol { list-style: none; margin: 0; padding: 0; }
  .wt-map li.child { margin-left: 0.85rem; }
  .wt-map li button {
    display: flex; align-items: center; gap: 0.5rem;
    width: 100%; padding: 0.28rem 0.4rem;
    background: none; border: none; cursor: pointer;
    text-align: left; color: var(--ink-soft);
    font-size: 0.86rem; border-radius: 5px;
  }
  .wt-map li button:hover { background: rgba(138, 90, 43, 0.1); color: var(--ink); }
  .wt-map li.active button { color: var(--accent); font-weight: 600; background: rgba(138, 90, 43, 0.14); }
  .wt-map .dot {
    width: 8px; height: 8px; border-radius: 50%;
    background: var(--rule); flex: none;
  }
  .wt-map li.active .dot { background: var(--accent); }
  .dot[data-kind="interior"] { border-radius: 1px; }
  .dot[data-kind="dungeon"] { background: #7a3b3b; }
  .wt-map-foot { margin: 0.75rem 0 0; font-size: 0.78rem; color: var(--ink-soft); }
  .wt-stub-badge {
    margin: 0.6rem 0 0; font-size: 0.75rem; letter-spacing: 0.06em;
    color: #9a7b3a; background: rgba(154, 123, 58, 0.12);
    border: 1px dashed var(--rule); border-radius: 4px;
    padding: 0.25rem 0.4rem; text-align: center;
  }

  /* ---- Spread ---- */
  .spread { margin-bottom: 1.5rem; }
  .spread-head { margin-bottom: 1rem; }
  .parent-crumb { margin: 0 0 0.2rem; font-size: 0.8rem; color: var(--ink-soft); }
  .scene-title {
    font-family: "AllByteCustom", serif;
    font-size: clamp(2rem, 4vw, 3rem);
    line-height: 1.05; margin: 0; color: var(--ink);
  }
  .scene-lead {
    font-style: italic; color: var(--ink-soft);
    margin: 0.25rem 0 0.6rem; font-size: 1.05rem;
  }
  .scene-meta { display: flex; flex-wrap: wrap; gap: 0.45rem; align-items: center; }
  .chip {
    font-size: 0.78rem; letter-spacing: 0.03em; text-transform: uppercase;
    background: var(--parch-2); border: 1px solid var(--rule);
    color: var(--ink-soft); border-radius: 999px; padding: 0.22rem 0.6rem;
  }
  .chip.kind[data-kind="dungeon"] { color: #7a3b3b; border-color: #c79a9a; }
  .chip.play { cursor: pointer; color: var(--accent); }
  .chip.play:hover { background: rgba(138, 90, 43, 0.12); }

  .spread-body {
    display: grid;
    grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
    gap: 1.5rem;
    align-items: start;
  }

  /* ---- Hero ---- */
  .hero { margin: 0; position: relative; }

  /* Consistent per-scene info box overlaid on the still */
  .still-box {
    position: absolute;
    left: 0; right: 0; bottom: 0;
    background: rgba(244, 235, 208, 0.93);
    border-top: 1px solid var(--rule);
    border-radius: 0 0 8px 8px;
    padding: 0.5rem 0.7rem;
    display: flex; flex-direction: column; gap: 0.25rem;
    backdrop-filter: blur(2px);
  }
  .sb-row { display: flex; gap: 0.5rem; align-items: baseline; font-size: 0.82rem; line-height: 1.35; }
  .sb-label {
    flex: none; width: 3.1rem;
    font-family: "AllByteCustom", Georgia, serif;
    color: var(--accent); font-size: 0.92rem;
  }
  .sb-vals { color: var(--ink); }
  .sb-vals.exits { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .sb-exit {
    font: inherit; background: var(--parch-2); border: 1px solid var(--rule);
    color: var(--accent); border-radius: 4px; padding: 0.05rem 0.45rem; cursor: pointer;
  }
  button.sb-exit:hover { background: var(--accent); color: #fff; }
  .sb-exit.ext { cursor: default; opacity: 0.7; border-style: dashed; color: var(--ink-soft); }
  .hero video, .hero-img {
    width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
    border-radius: 8px; border: 1px solid var(--rule);
    background: #000; display: block;
  }
  .hero video { cursor: pointer; }
  .hero-stub {
    width: 100%; aspect-ratio: 16 / 9;
    border: 1px dashed var(--rule); border-radius: 8px;
    background: repeating-linear-gradient(45deg, var(--parch-2), var(--parch-2) 10px, #e6d8b0 10px, #e6d8b0 20px);
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    gap: 0.4rem; color: var(--ink-soft);
  }
  .hero-stub .film { font-size: 2rem; opacity: 0.5; }
  .hero-stub .hero-name { font-family: "AllByteCustom", serif; font-size: 1.3rem; color: var(--accent); }
  .hero-stub .pending {
    font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.08em;
    background: rgba(58, 47, 28, 0.08); padding: 0.15rem 0.5rem; border-radius: 999px;
  }

  /* ---- Guide ---- */
  .guide-text { margin: 0; font-size: 1rem; line-height: 1.65; }
  .guide-text::first-letter {
    font-family: "AllByteCustom", serif;
    font-size: 3.1rem; line-height: 0.8; float: left;
    padding: 0.1rem 0.5rem 0 0; color: var(--accent);
  }
  .callouts { display: grid; gap: 0.7rem; margin-top: 1rem; }
  .callout {
    border-left: 3px solid var(--accent);
    background: var(--parch-2);
    border-radius: 0 6px 6px 0; padding: 0.6rem 0.8rem;
  }
  .callout[data-kind="warning"] { border-left-color: #b4602a; }
  .callout[data-kind="secret"] { border-left-color: #8a6db0; }
  .callout[data-kind="music"] { border-left-color: #3f7a6a; }
  .callout[data-kind="lore"] { border-left-color: #a98a3a; }
  .callout-title { margin: 0 0 0.15rem; font-weight: 700; font-size: 0.92rem; display: flex; gap: 0.4rem; align-items: baseline; }
  .callout-title .glyph { color: var(--accent); }
  .callout[data-kind="warning"] .glyph { color: #b4602a; }
  .callout-body { margin: 0; font-size: 0.88rem; line-height: 1.5; color: var(--ink-soft); }

  /* ---- Exits ribbon ---- */
  .exits {
    display: flex; align-items: center; gap: 0.8rem; flex-wrap: wrap;
    margin-top: 1.25rem; padding-top: 0.9rem; border-top: 1px solid var(--rule);
  }
  .exits-label {
    font-family: "AllByteCustom", serif; font-size: 1.1rem; color: var(--accent);
  }
  .exits ul { list-style: none; display: flex; flex-wrap: wrap; gap: 0.5rem; margin: 0; padding: 0; }
  .exit {
    display: inline-flex; align-items: baseline; gap: 0.4rem;
    background: var(--parch-2); border: 1px solid var(--rule);
    border-radius: 6px; padding: 0.4rem 0.7rem; cursor: pointer;
    color: var(--ink); font-size: 0.85rem;
  }
  button.exit:hover { background: rgba(138, 90, 43, 0.12); border-color: var(--accent); }
  .exit .arrow { color: var(--accent); }
  .exit .exit-label { color: var(--ink-soft); font-size: 0.78rem; }
  .exit.external { cursor: default; opacity: 0.7; border-style: dashed; }

  .rule { text-align: center; color: var(--rule); font-size: 1.4rem; margin: 2.25rem 0 0.75rem; }
  .wt-end { text-align: center; color: var(--ink-soft); font-style: italic; padding-top: 1rem; }
  .link { background: none; border: none; padding: 0; cursor: pointer; color: var(--accent); text-decoration: underline; font: inherit; }

  /* ---- Responsive ---- */
  @media (max-width: 860px) {
    .wt { grid-template-columns: 1fr; gap: 1rem; }
    .wt-map-inner { position: static; }
    .wt-map ol { display: flex; flex-wrap: wrap; gap: 0.25rem; }
    .wt-map li.child { margin-left: 0; }
    .spread-body { grid-template-columns: 1fr; }
  }
</style>
