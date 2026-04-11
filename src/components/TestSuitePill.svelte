<script lang="ts">
  import type { TestIndex, TestRunStatus } from "../lib/testIndex";
  import { fetchIndex, fetchStatus } from "../lib/testDataSource";
  import { onMount } from "svelte";

  interface Props {
    locked: boolean;
    lockedTooltip?: string;
    enabledTooltip?: string;
  }

  let {
    locked,
    lockedTooltip = "Hero+ subscription required",
    enabledTooltip = "Open the test suite dashboard",
  }: Props = $props();

  let index = $state<TestIndex | null>(null);
  let status = $state<TestRunStatus | null>(null);

  onMount(() => {
    fetchIndex()
      .then((i) => {
        index = i;
      })
      .catch(() => {});
    fetchStatus()
      .then((s) => {
        status = s;
      })
      .catch(() => {});
  });

  let t1 = $derived(index?.summary.by_tier?.["1"] ?? null);
  let t2 = $derived(index?.summary.by_tier?.["2"] ?? null);
  let t3 = $derived(index?.summary.by_tier?.["3"] ?? null);
  let total = $derived(index?.summary.total_tests ?? null);
  // Dot blinks when there's any "actively running" signal — either the test
  // runner state is "running" OR live CON agents are working. Blinks even
  // when the pill is locked, so a non-Hero visitor still sees activity.
  let agentsLive = $derived(status?.agents?.count_live ?? 0);
  let isActivelyRunning = $derived(
    status?.state === "running" || agentsLive > 0
  );
  let title = $derived(locked ? lockedTooltip : enabledTooltip);
</script>

{#snippet pillInner()}
  <div class="row row-top">
    <span
      class="dot"
      class:active={isActivelyRunning}
      title={isActivelyRunning ? "Test run in progress" : ""}
      aria-hidden="true"
    ></span>
    <span class="name">TEST SUITE DASHBOARD</span>
  </div>
  <div class="row row-bottom">
    {#if t1 != null || t2 != null || t3 != null}
      <span class="tier-tag tier-t1" title="GUT native unit tests">T1 {t1 ?? 0}</span>
      <span class="tier-tag tier-t2" title="GUT integration tests">T2 {t2 ?? 0}</span>
      <span class="tier-tag tier-t3" title="Playwright browser tests">T3 {t3 ?? 0}</span>
    {:else}
      <span class="hint">Loading test suite…</span>
    {/if}
  </div>
  {#if locked}
    <span class="locked-veil" aria-hidden="true">
      <span class="veil-text">Hero Only</span>
    </span>
  {/if}
{/snippet}

{#if locked}
  <span
    class="test-suite-pill locked"
    title={title}
    aria-disabled="true"
    onclick={(e) => e.stopPropagation()}
  >
    {@render pillInner()}
  </span>
{:else}
  <a
    class="test-suite-pill enabled"
    href="/test/"
    title={title}
    onclick={(e) => e.stopPropagation()}
  >
    {@render pillInner()}
  </a>
{/if}

<style>
  .test-suite-pill {
    position: relative;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 0.35rem;
    width: 220px;
    min-height: 58px;
    padding: 0.5rem 0.75rem;
    background: rgba(10, 14, 23, 0.92);
    border: 1px solid rgba(167, 243, 208, 0.45);
    border-radius: 6px;
    text-decoration: none;
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
    color: #e5e7eb;
    backdrop-filter: blur(4px);
    -webkit-backdrop-filter: blur(4px);
    transition: border-color 0.2s, background 0.2s, transform 0.15s, box-shadow 0.2s;
    box-sizing: border-box;
    overflow: hidden;
  }
  .test-suite-pill::before {
    content: "";
    position: absolute;
    inset: 0;
    background: radial-gradient(circle at 85% 15%, rgba(167, 243, 208, 0.1), transparent 60%);
    pointer-events: none;
  }
  .test-suite-pill.enabled:hover {
    background: rgba(167, 243, 208, 0.1);
    border-color: rgba(167, 243, 208, 0.85);
    transform: translateY(-1px);
    box-shadow: 0 4px 16px rgba(167, 243, 208, 0.2);
  }

  .row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
    white-space: nowrap;
    min-width: 0;
    position: relative;
    z-index: 1;
  }
  .row-bottom { gap: 0.3rem; }

  .dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: #6b7280;
    flex-shrink: 0;
    border: 1px solid rgba(167, 243, 208, 0.35);
  }
  .dot.active {
    background: #fbbf24;
    border-color: transparent;
    box-shadow: 0 0 8px rgba(251, 191, 36, 0.7);
    animation: ts-pulse 1.2s ease-in-out infinite;
  }
  @keyframes ts-pulse {
    0%, 100% { opacity: 1; transform: scale(1); }
    50%      { opacity: 0.55; transform: scale(0.75); }
  }

  .name {
    font-weight: 700;
    letter-spacing: 0.06em;
    color: #a7f3d0;
    font-size: 0.78rem;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .tier-tag {
    font-size: 0.75rem;
    font-weight: 700;
    letter-spacing: 0.02em;
    padding: 0.08rem 0.25rem;
    border-radius: 2px;
    flex: 1 1 0;
    text-align: center;
    cursor: help;
  }
  .tier-t1 {
    color: #a78bfa;
    background: rgba(167, 139, 250, 0.1);
    border: 1px solid rgba(167, 139, 250, 0.35);
  }
  .tier-t2 {
    color: #60a5fa;
    background: rgba(96, 165, 250, 0.1);
    border: 1px solid rgba(96, 165, 250, 0.35);
  }
  .tier-t3 {
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.35);
  }
  .hint {
    font-size: 0.72rem;
    color: #6b7280;
    font-style: italic;
  }

  /* Locked state: same structure as enabled, but an overlay veil is drawn
     on top with a "Hero Only" label — matches the .demo-overlay /
     "Coming Soon" pattern used on the demo button itself. */
  .test-suite-pill.locked {
    cursor: not-allowed;
    user-select: none;
    border-color: rgba(107, 114, 128, 0.5);
  }

  .locked-veil {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    background: rgba(20, 27, 36, 0.62);
    border-radius: 6px;
    z-index: 2;
    pointer-events: none;
    transition: background 0.2s;
  }
  .test-suite-pill.locked:hover .locked-veil {
    background: rgba(20, 27, 36, 0.4);
  }
  .veil-text {
    font-family: "AllByteCustom", Georgia, "Times New Roman", serif;
    font-size: 1.45rem;
    color: rgba(224, 231, 255, 0.55);
    letter-spacing: 0.04em;
    line-height: 1;
  }
</style>
