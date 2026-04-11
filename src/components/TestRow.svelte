<script lang="ts">
  import type { TestEntry } from "../lib/testIndex";
  import {
    statusClass,
    formatRelativeTime,
    formatDurationMs,
    latestScreenshot,
    testIdToSlug,
    TIER_META,
  } from "../lib/testIndex";

  interface Props {
    test: TestEntry;
    isRunning: boolean;
  }

  let { test, isRunning }: Props = $props();

  let cls = $derived(isRunning ? "running" : statusClass(test.status));
  let href = $derived(`/test/view/?id=${testIdToSlug(test.id)}`);
  let lastRunLabel = $derived(formatRelativeTime(test.last_run?.timestamp ?? null));
  let lastRunAbs = $derived(test.last_run?.timestamp ?? "");
  let durationLabel = $derived(
    isRunning ? "running…" : formatDurationMs(test.last_run?.duration_ms ?? null)
  );
  let isSlow = $derived(
    !!test.last_run?.duration_ms && test.last_run.duration_ms > 20000
  );
  let hasShot = $derived(latestScreenshot(test) !== null);
  let tierMeta = $derived(TIER_META[test.tier]);

  function tierTooltip(tier: number): string {
    switch (tier) {
      case 1:
        return "Tier 1 — GUT: native Godot unit test. Fast, pure logic, no browser.";
      case 2:
        return "Tier 2 — GUT integration: scene tree loaded, seconds per test.";
      case 3:
        return "Tier 3 — Playwright: real browser + WASM, highest fidelity.";
      default:
        return `Tier ${tier}`;
    }
  }

  function shapeTooltip(shape: "A" | "B" | "C" | null): string {
    switch (shape) {
      case "A":
        return "Shape A — Scene-based. Custom Godot test scene. Fast, deterministic.";
      case "B":
        return "Shape B — Save fixture. Loads a JSON save state to reach context.";
      case "C":
        return "Shape C — Live traversal. Real intro, real events. Slow but realistic.";
      default:
        return "No shape (native test)";
    }
  }
</script>

<a class="test-row" class:running={isRunning} href={href}>
  <span class="dot dot-{cls}" aria-hidden="true">
    {#if isRunning}<span class="spinner"></span>{/if}
  </span>
  <span class="name" title={test.description ?? test.name}>{test.name}</span>
  <span class="tier" style="--tier-color: {tierMeta.color}" title={tierTooltip(test.tier)}>{tierMeta.short}</span>
  {#if test.shape}
    <span class="shape shape-{test.shape}" title={shapeTooltip(test.shape)}>{test.shape}</span>
  {/if}
  <span class="duration" class:slow={isSlow}>{durationLabel}</span>
  <span class="ts" title={lastRunAbs}>{lastRunLabel}</span>
  <span class="shot" aria-hidden="true">{hasShot ? "▣" : ""}</span>
</a>

<style>
  .test-row {
    display: grid;
    grid-template-columns: auto 1fr auto auto auto auto auto;
    align-items: center;
    gap: 0.5rem;
    padding: 0.35rem 0.6rem;
    margin: 0.1rem 0;
    border-radius: 4px;
    border: 1px solid transparent;
    text-decoration: none;
    color: #d1d5db;
    font-family: "Courier New", monospace;
    font-size: 0.82rem;
    transition: background 0.1s, border-color 0.1s;
  }
  .test-row:hover {
    background: rgba(167, 243, 208, 0.05);
    border-color: rgba(167, 243, 208, 0.2);
  }
  .test-row.running {
    background: rgba(167, 243, 208, 0.08);
    border-color: rgba(167, 243, 208, 0.35);
  }
  .dot {
    width: 12px;
    height: 12px;
    border-radius: 50%;
    display: inline-block;
    position: relative;
  }
  .dot-pass { background: #a7f3d0; }
  .dot-fail { background: #f87171; }
  .dot-xfail {
    background: transparent;
    border: 1.5px solid #fbbf24;
  }
  .dot-skip {
    background: transparent;
    border: 1.5px solid #6b7280;
  }
  .dot-unknown {
    background: transparent;
    border: 1.5px dashed rgba(255, 255, 255, 0.2);
  }
  .dot-running {
    background: transparent;
    border: 1.5px solid #a7f3d0;
  }
  .spinner {
    position: absolute;
    inset: -2px;
    border-radius: 50%;
    border: 2px solid transparent;
    border-top-color: #a7f3d0;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .name {
    color: #e5e7eb;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .tier, .shape {
    font-size: 0.65rem;
    font-weight: 700;
    letter-spacing: 0.05em;
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
    flex-shrink: 0;
    cursor: help;
  }
  .tier {
    color: var(--tier-color);
    border: 1px solid var(--tier-color);
    background: color-mix(in srgb, var(--tier-color) 10%, transparent);
  }
  .shape {
    color: #9ca3af;
    border: 1px solid rgba(156, 163, 175, 0.4);
  }
  .shape-A { color: #86efac; border-color: rgba(134, 239, 172, 0.5); }
  .shape-B { color: #fde68a; border-color: rgba(253, 230, 138, 0.5); }
  .shape-C { color: #fca5a5; border-color: rgba(252, 165, 165, 0.5); }
  .duration {
    color: #9ca3af;
    font-size: 0.75rem;
    min-width: 3.5rem;
    text-align: right;
  }
  .duration.slow { color: #fca5a5; font-weight: 700; }
  .ts {
    color: #6b7280;
    font-size: 0.7rem;
    min-width: 4rem;
    text-align: right;
  }
  .shot {
    color: #a7f3d0;
    font-size: 0.9rem;
    min-width: 1rem;
    text-align: center;
  }
</style>
