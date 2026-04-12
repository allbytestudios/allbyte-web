<script lang="ts">
  import type { TestEntry, TestIndex } from "../lib/testIndex";
  import {
    statusClass,
    formatRelativeTime,
    formatDurationMs,
    latestScreenshot,
    findTestBySlug,
    TIER_META,
  } from "../lib/testIndex";
  import { fetchIndex, artifactUrl } from "../lib/testDataSource";
  import { auth } from "../lib/auth.svelte.ts";
  import { isTierAtLeast } from "../lib/tier";
  import { onMount } from "svelte";

  let viewerHasAccess = $derived(isTierAtLeast(auth.currentUser, "hero"));

  let test = $state<TestEntry | null>(null);
  let index = $state<TestIndex | null>(null);
  let error = $state<string | null>(null);
  let slug = $state<string>("");

  onMount(async () => {
    const params = new URLSearchParams(window.location.search);
    slug = params.get("id") ?? "";
    if (!slug) {
      error = "Missing ?id=<test-slug> in URL.";
      return;
    }
    try {
      index = await fetchIndex();
      const found = findTestBySlug(index, slug);
      if (!found) {
        error = `No test found for slug: ${slug}`;
        return;
      }
      test = found;
    } catch (err: any) {
      error = err?.message ?? String(err);
    }
  });

  let cls = $derived(test ? statusClass(test.status) : "unknown");
  let tierMeta = $derived(test ? TIER_META[test.tier] : null);
  let screenshotPath = $derived(test ? latestScreenshot(test) : null);
  let screenshotUrl = $derived(screenshotPath ? artifactUrl(screenshotPath) : null);
  let lastRunRel = $derived(
    test?.last_run?.timestamp ? formatRelativeTime(test.last_run.timestamp) : "—"
  );

  function shapeLabel(s: "A" | "B" | "C"): string {
    switch (s) {
      case "A":
        return "Scene-based";
      case "B":
        return "Save fixture";
      case "C":
        return "Live traversal";
    }
  }
</script>

<div class="detail">
  {#if !auth.authReady}
    <div class="loading">Checking subscription…</div>
  {:else if !viewerHasAccess}
    <div class="gate">
      <h2>Hero tier required</h2>
      <p>Per-test detail, screenshots, and run history are a <strong>Hero</strong> tier perk. The public test suite summary is at <a href="/test/">/test/</a>.</p>
      <p><a class="gate-link" href="/subscribe/">View subscription tiers →</a></p>
      <p><a href="/test/">← Back to test suite</a></p>
    </div>
  {:else if error}
    <div class="error">
      <h2>Test not available</h2>
      <p>{error}</p>
      <p><a href="/test/">← Back to test suite</a></p>
    </div>
  {:else if !test}
    <div class="loading">Loading…</div>
  {:else}
    <nav class="breadcrumb">
      <a href="/test/">← Test Suite</a>
      <span class="sep">/</span>
      <span class="leaf-path">{test.leaf}</span>
    </nav>
    <h1 class="test-name">{test.name}</h1>

    <div class="status-row">
      <span class="dot dot-{cls}" aria-hidden="true"></span>
      <span class="status-label status-{cls}">{test.status}</span>
      {#if test.last_run}
        <span class="sep">·</span>
        <span class="last-run" title={test.last_run.timestamp}>
          last run {lastRunRel} · {formatDurationMs(test.last_run.duration_ms)} · {test.last_run.outcome}
        </span>
      {:else}
        <span class="sep">·</span>
        <span class="last-run never">never run</span>
      {/if}
    </div>

    {#if test.description}
      <p class="description">{test.description}</p>
    {/if}

    <section class="section">
      <h2>Latest screenshot</h2>
      {#if screenshotUrl}
        <a href={screenshotUrl} target="_blank" rel="noopener">
          <img class="screenshot" src={screenshotUrl} alt="Latest screenshot for {test.name}" />
        </a>
        <p class="path">{screenshotPath}</p>
      {:else}
        <p class="empty">No screenshots captured yet.</p>
      {/if}
    </section>

    <section class="section metadata">
      <h2>Metadata</h2>
      <dl>
        <dt>Tier</dt>
        <dd>
          {#if tierMeta}
            <span class="tier-badge" style="--c: {tierMeta.color}">
              Tier {test.tier} — {tierMeta.name}
            </span>
          {/if}
        </dd>
        <dt>Shape</dt>
        <dd>{test.shape ? test.shape + " — " + shapeLabel(test.shape) : "—"}</dd>
        <dt>Leaf</dt>
        <dd>{test.leaf}</dd>
        <dt>File</dt>
        <dd><code>{test.file}:{test.line}</code></dd>
        <dt>Fixture</dt>
        <dd><code>{test.fixture ?? "—"}</code></dd>
        <dt>Markers</dt>
        <dd>
          {#if test.markers.length > 0}
            {test.markers.join(", ")}
          {:else}
            —
          {/if}
        </dd>
        <dt>Source</dt>
        <dd>
          <a href={test.links.source} target="_blank" rel="noopener">
            → GitHub
          </a>
        </dd>
      </dl>
    </section>

    {#if test.last_run}
      <section class="section">
        <h2>Last run</h2>
        <div class="run-info">
          <div><span class="k">when</span> {lastRunRel}</div>
          <div><span class="k">outcome</span> {test.last_run.outcome}</div>
          <div><span class="k">duration</span> {formatDurationMs(test.last_run.duration_ms)}</div>
        </div>
      </section>
    {/if}
  {/if}
</div>

<style>
  .detail {
    max-width: 900px;
    margin: 0 auto;
    padding: 1rem 1.25rem 3rem;
    color: #e5e7eb;
    font-family: "Courier New", monospace;
  }
  .loading,
  .error,
  .gate {
    text-align: center;
    padding: 3rem;
    color: #9ca3af;
  }
  .error h2 { color: #fca5a5; }
  .gate h2 {
    color: #fbbf24;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    font-size: 1.05rem;
  }
  .gate strong { color: #fbbf24; }
  .gate a { color: #a7f3d0; text-decoration: none; }
  .gate a:hover { text-decoration: underline; }
  .gate .gate-link {
    display: inline-block;
    margin: 0.5rem 0;
    padding: 0.5rem 1rem;
    border: 1px solid rgba(167, 243, 208, 0.45);
    border-radius: 4px;
  }
  .breadcrumb {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
    color: #9ca3af;
    margin-bottom: 0.4rem;
  }
  .breadcrumb a { color: #a7f3d0; text-decoration: none; }
  .breadcrumb a:hover { text-decoration: underline; }
  .sep { color: #4b5563; }
  .leaf-path { color: #9ca3af; }
  .test-name {
    font-size: 1.4rem;
    color: #a7f3d0;
    margin: 0.3rem 0 0.8rem;
    word-break: break-all;
  }
  .status-row {
    display: flex;
    align-items: center;
    gap: 0.6rem;
    padding: 0.5rem 0.8rem;
    background: #12161e;
    border-radius: 4px;
    font-size: 0.9rem;
  }
  .dot {
    width: 14px;
    height: 14px;
    border-radius: 50%;
  }
  .dot-pass { background: #a7f3d0; }
  .dot-fail { background: #f87171; }
  .dot-xfail { background: transparent; border: 2px solid #fbbf24; }
  .dot-skip { background: transparent; border: 2px solid #6b7280; }
  .dot-unknown { background: transparent; border: 2px dashed rgba(255, 255, 255, 0.25); }
  .status-label {
    text-transform: uppercase;
    font-weight: 700;
    font-size: 0.75rem;
    letter-spacing: 0.1em;
  }
  .status-pass { color: #a7f3d0; }
  .status-fail { color: #fca5a5; }
  .status-xfail { color: #fbbf24; }
  .status-skip, .status-unknown { color: #9ca3af; }
  .last-run { color: #9ca3af; font-size: 0.82rem; }
  .last-run.never { font-style: italic; }
  .description {
    margin: 1rem 0;
    color: #d1d5db;
    font-size: 0.95rem;
    line-height: 1.5;
    font-style: italic;
  }
  .section {
    margin-top: 1.5rem;
    padding-top: 1rem;
    border-top: 1px solid rgba(167, 243, 208, 0.1);
  }
  .section h2 {
    font-size: 0.85rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    margin: 0 0 0.6rem;
  }
  .screenshot {
    max-width: 100%;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 4px;
    background: #000;
  }
  .path {
    font-size: 0.72rem;
    color: #6b7280;
    margin: 0.3rem 0 0;
    word-break: break-all;
  }
  .empty {
    color: #6b7280;
    font-style: italic;
    font-size: 0.85rem;
  }
  dl {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 0.45rem 1rem;
    margin: 0;
    font-size: 0.85rem;
  }
  dt {
    color: #9ca3af;
    font-weight: 400;
  }
  dd {
    color: #e5e7eb;
    margin: 0;
    word-break: break-word;
  }
  code {
    background: rgba(255, 255, 255, 0.04);
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    font-size: 0.82rem;
  }
  .tier-badge {
    color: var(--c);
    border: 1px solid var(--c);
    padding: 0.1rem 0.5rem;
    border-radius: 3px;
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.05em;
  }
  .run-info {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(140px, 1fr));
    gap: 0.5rem 1rem;
    font-size: 0.85rem;
  }
  .k {
    color: #6b7280;
    text-transform: uppercase;
    font-size: 0.65rem;
    letter-spacing: 0.08em;
    display: block;
  }
</style>
