<script lang="ts">
  import type { TestRunStatus } from "../lib/testIndex";
  import { formatRelativeTime, formatDurationMs } from "../lib/testIndex";

  interface Props {
    status: TestRunStatus | null;
  }

  let { status }: Props = $props();

  let etaLabel = $derived.by(() => {
    const s = status?.progress?.eta_seconds;
    if (s == null) return null;
    if (s < 60) return `${Math.round(s)}s`;
    const m = Math.floor(s / 60);
    const r = Math.round(s - m * 60);
    return `${m}m ${r}s`;
  });
</script>

{#if status}
  <div class="status-card state-{status.state}">
    {#if status.state === "running"}
      <div class="header">
        <span class="state-badge running">● RUNNING</span>
        <span class="run-id">{status.run_id}</span>
        {#if status.progress}
          <span class="progress-label">
            {status.progress.completed} / {status.progress.total}
            ({status.progress.percent.toFixed(1)}%)
          </span>
          {#if etaLabel}<span class="eta">ETA {etaLabel}</span>{/if}
        {/if}
      </div>
      {#if status.progress}
        <div class="progress-bar" aria-hidden="true">
          <div class="bar-fill" style="width: {status.progress.percent}%"></div>
        </div>
        <div class="counters">
          <span class="c pass">✓ {status.progress.passed_so_far}</span>
          <span class="c fail">✗ {status.progress.failed_so_far}</span>
          <span class="c xfail">◉ {status.progress.xfailed_so_far}</span>
        </div>
      {/if}
      {#if status.workers.length > 0}
        <div class="workers">
          {#each status.workers as w (w.worker)}
            <div class="lane">
              <span class="worker">{w.worker}</span>
              <span class="current">
                {#if w.current_test}
                  → {w.current_test}
                {:else}
                  (idle)
                {/if}
              </span>
              <span class="completed">{w.tests_completed} done</span>
              {#if w.last_outcome}
                <span class="last last-{w.last_outcome}">{w.last_outcome}</span>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    {:else if status.state === "finished" || status.state === "aborted"}
      <div class="header compact">
        <span class="state-badge {status.state}">
          {status.state === "finished" ? "✓ FINISHED" : "⚠ ABORTED"}
        </span>
        <span class="run-id">{status.run_id}</span>
        {#if status.progress}
          <span class="progress-label">
            {status.progress.completed} / {status.progress.total}
          </span>
          <span class="c pass">✓ {status.progress.passed_so_far}</span>
          <span class="c fail">✗ {status.progress.failed_so_far}</span>
          <span class="c xfail">◉ {status.progress.xfailed_so_far}</span>
        {/if}
        <span class="updated">updated {formatRelativeTime(status.updated_at)}</span>
      </div>
    {:else}
      <div class="header compact">
        <span class="state-badge idle">◯ IDLE</span>
        {#if status.run_id}
          <span class="run-id">last run {status.run_id}</span>
        {:else}
          <span class="run-id">no run captured yet</span>
        {/if}
        {#if status.updated_at}
          <span class="updated">updated {formatRelativeTime(status.updated_at)}</span>
        {/if}
      </div>
    {/if}
  </div>
{/if}

<style>
  .status-card {
    background: #1a1e26;
    border: 1px solid rgba(167, 243, 208, 0.2);
    border-radius: 6px;
    padding: 0.75rem 1rem;
    margin-bottom: 0.75rem;
    font-family: "Courier New", monospace;
    color: #d1d5db;
  }
  .status-card.state-running {
    border-color: rgba(167, 243, 208, 0.45);
    box-shadow: 0 0 12px rgba(167, 243, 208, 0.1);
  }
  .header {
    display: flex;
    align-items: center;
    gap: 0.85rem;
    flex-wrap: wrap;
  }
  .header.compact { gap: 1rem; font-size: 0.85rem; }
  .state-badge {
    font-weight: 700;
    font-size: 0.78rem;
    letter-spacing: 0.08em;
    padding: 0.15rem 0.55rem;
    border-radius: 3px;
  }
  .state-badge.running {
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.4);
    animation: pulse 1.5s ease-in-out infinite;
  }
  .state-badge.finished {
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.1);
    border: 1px solid rgba(167, 243, 208, 0.3);
  }
  .state-badge.aborted {
    color: #fca5a5;
    background: rgba(248, 113, 113, 0.1);
    border: 1px solid rgba(248, 113, 113, 0.3);
  }
  .state-badge.idle {
    color: #9ca3af;
    background: rgba(156, 163, 175, 0.08);
    border: 1px solid rgba(156, 163, 175, 0.25);
  }
  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.6; }
  }
  .run-id { color: #9ca3af; font-size: 0.8rem; }
  .progress-label { color: #e5e7eb; font-size: 0.85rem; font-weight: 600; }
  .eta { color: #a7f3d0; font-size: 0.8rem; }
  .updated { color: #6b7280; font-size: 0.75rem; margin-left: auto; }
  .progress-bar {
    margin-top: 0.5rem;
    height: 6px;
    background: rgba(255, 255, 255, 0.05);
    border-radius: 3px;
    overflow: hidden;
  }
  .bar-fill {
    height: 100%;
    background: linear-gradient(90deg, #86efac, #a7f3d0);
    transition: width 0.3s ease-out;
  }
  .counters {
    display: flex;
    gap: 0.75rem;
    margin-top: 0.4rem;
    font-size: 0.8rem;
  }
  .c.pass { color: #a7f3d0; }
  .c.fail { color: #f87171; }
  .c.xfail { color: #fbbf24; }
  .workers {
    margin-top: 0.6rem;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .lane {
    display: grid;
    grid-template-columns: auto 1fr auto auto;
    gap: 0.75rem;
    padding: 0.3rem 0.5rem;
    background: rgba(255, 255, 255, 0.02);
    border-radius: 3px;
    font-size: 0.78rem;
    align-items: center;
  }
  .worker {
    color: #a7f3d0;
    font-weight: 700;
    font-size: 0.7rem;
    background: rgba(167, 243, 208, 0.1);
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
  }
  .current {
    color: #e5e7eb;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    min-width: 0;
  }
  .completed { color: #9ca3af; font-size: 0.7rem; }
  .last { font-size: 0.7rem; padding: 0.1rem 0.35rem; border-radius: 2px; }
  .last-passed { color: #a7f3d0; background: rgba(167, 243, 208, 0.1); }
  .last-failed { color: #fca5a5; background: rgba(248, 113, 113, 0.1); }
  .last-xfailed { color: #fcd34d; background: rgba(251, 191, 36, 0.1); }
</style>
