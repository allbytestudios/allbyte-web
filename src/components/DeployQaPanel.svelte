<script lang="ts">
  // Deploy QA panel — admin view of the cross-browser + controller QA
  // runs that fire after each successful deploy via
  // .github/workflows/qa.yml.
  //
  // Data source: s3://allbyte.studio-site/test-snapshot/qa-runs/
  //   - index.json — rolling list of recent runs (last 30)
  //   - <run-id>/manifest.json — per-run summary
  //   - <run-id>/<os>-<engine>.png — screenshot per matrix cell
  //   - <run-id>/<os>-<engine>.logs.txt — iframe logs per matrix cell
  //
  // Both indices are served from CloudFront (test-snapshot/* is part of
  // the site bucket sync, with short Cache-Control set by the aggregate
  // Lambda). Polling is local — refresh on focus + on a 30s interval —
  // because S3 doesn't push.

  import { onMount, onDestroy } from "svelte";

  // Schema mirrors scripts/aggregate_qa_results.py
  interface IndexEntry {
    id: string;
    timestamp: string;
    commit_short: string;
    commit_sha: string;
    branch: string;
    trigger: string;
    overall_status: string;
    cross_browser_summary: {
      total: number;
      passed: number;
      with_fatal: number;
      with_suspect: number;
    };
    controller_status: string | null;
  }

  interface EngineResult {
    os: string;
    engine: string;
    status: string;
    scene?: string;
    boot_elapsed_s?: number;
    iframe_log_count?: number;
    fatal_log_count?: number;
    suspect_log_count?: number;
    fatal_samples?: string[];
    suspect_samples?: string[];
    screenshot_url?: string | null;
    logs_url?: string | null;
  }

  interface RunManifest {
    id: string;
    timestamp: string;
    commit_sha: string;
    commit_short: string;
    branch: string;
    trigger: string;
    engines: EngineResult[];
    cross_browser_summary: IndexEntry["cross_browser_summary"];
    controller: { profiles_total: number; profiles_passed: number; status: string } | null;
    overall_status: string;
  }

  const INDEX_URL = "/test-snapshot/qa-runs/index.json";

  let loadState = $state<"loading" | "ready" | "no_data" | "error">("loading");
  let errorMsg = $state<string>("");
  let index = $state<IndexEntry[]>([]);
  let selectedRunId = $state<string | null>(null);
  let selectedManifest = $state<RunManifest | null>(null);
  let manifestLoading = $state(false);

  async function loadIndex() {
    try {
      const res = await fetch(INDEX_URL, { cache: "no-store" });
      if (res.status === 404) {
        loadState = "no_data";
        return;
      }
      if (!res.ok) {
        loadState = "error";
        errorMsg = `index fetch HTTP ${res.status}`;
        return;
      }
      const data = await res.json();
      index = (data?.runs ?? []) as IndexEntry[];
      loadState = index.length > 0 ? "ready" : "no_data";
      // Auto-select the latest run on first load
      if (selectedRunId === null && index.length > 0) {
        selectedRunId = index[0].id;
        loadManifest(index[0].id);
      }
    } catch (e) {
      loadState = "error";
      errorMsg = String(e);
    }
  }

  async function loadManifest(runId: string) {
    if (!runId) return;
    manifestLoading = true;
    try {
      const res = await fetch(
        `/test-snapshot/qa-runs/${runId}/manifest.json`,
        { cache: "no-store" }
      );
      if (!res.ok) {
        selectedManifest = null;
        return;
      }
      selectedManifest = (await res.json()) as RunManifest;
    } catch {
      selectedManifest = null;
    } finally {
      manifestLoading = false;
    }
  }

  function selectRun(id: string) {
    selectedRunId = id;
    loadManifest(id);
  }

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  function onVisibilityChange() {
    if (!document.hidden) loadIndex();
  }

  onMount(() => {
    loadIndex();
    pollTimer = setInterval(loadIndex, 30_000);
    document.addEventListener("visibilitychange", onVisibilityChange);
  });
  onDestroy(() => {
    if (pollTimer) clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", onVisibilityChange);
  });

  // Derived: which OS+engine combos exist in the latest manifest
  let matrixCells = $derived.by(() => {
    if (!selectedManifest) return [];
    return selectedManifest.engines.map((e) => ({
      key: `${e.os}-${e.engine}`,
      ...e,
    }));
  });

  let allOSes = $derived.by(() => {
    if (!selectedManifest) return [] as string[];
    return Array.from(new Set(selectedManifest.engines.map((e) => e.os)));
  });
  let allEngines = $derived.by(() => {
    if (!selectedManifest) return [] as string[];
    return Array.from(new Set(selectedManifest.engines.map((e) => e.engine)));
  });

  function cellAt(os: string, engine: string) {
    return matrixCells.find((c) => c.os === os && c.engine === engine);
  }

  function statusClass(status: string | undefined): string {
    switch (status) {
      case "ok":
        return "qa-ok";
      case "partial":
      case "suspect":
        return "qa-warn";
      case "no_results":
      case "failed":
      case "boot_timeout":
      case "navigation_failed":
      case "no_iframe":
      case "iframe_no_frame":
      case "exception":
        return "qa-fail";
      default:
        return "qa-neutral";
    }
  }
</script>

<section class="deploy-qa-section">
  <h3 class="qa-title">
    Deploy QA
    <span class="qa-subtitle">
      cross-browser + controller smoke against {" "}
      <code>allbyte.studio/play/</code> after each deploy
    </span>
  </h3>

  {#if loadState === "loading"}
    <div class="qa-empty">Loading recent QA runs…</div>
  {:else if loadState === "error"}
    <div class="qa-empty qa-error">Error loading QA runs: {errorMsg}</div>
  {:else if loadState === "no_data"}
    <div class="qa-empty">
      No QA runs yet — the workflow at
      <code>.github/workflows/qa.yml</code> populates this after the next
      deploy.
    </div>
  {:else}
    <div class="qa-layout">
      <!-- Left rail: run history -->
      <aside class="qa-history">
        <div class="qa-history-title">Recent runs</div>
        <ol class="qa-history-list">
          {#each index as run (run.id)}
            <li>
              <button
                class="qa-history-item {selectedRunId === run.id
                  ? 'qa-history-active'
                  : ''}"
                onclick={() => selectRun(run.id)}
              >
                <span class="qa-history-status {statusClass(run.overall_status)}">
                  {run.overall_status}
                </span>
                <span class="qa-history-sha">{run.commit_short}</span>
                <span class="qa-history-time">{run.timestamp.slice(0, 16).replace("T", " ")}</span>
              </button>
            </li>
          {/each}
        </ol>
      </aside>

      <!-- Right: selected run detail -->
      <div class="qa-detail">
        {#if manifestLoading}
          <div class="qa-empty">Loading run…</div>
        {:else if !selectedManifest}
          <div class="qa-empty">Select a run from the list.</div>
        {:else}
          {@const m = selectedManifest}
          <div class="qa-run-header">
            <div>
              <span class="qa-run-overall {statusClass(m.overall_status)}">{m.overall_status}</span>
              <code class="qa-run-sha">{m.commit_short}</code>
              <span class="qa-run-time">{m.timestamp}</span>
              <span class="qa-run-trigger">via {m.trigger}</span>
            </div>
            <div class="qa-run-summary">
              cross-browser {m.cross_browser_summary.passed}/{m.cross_browser_summary.total}
              {#if m.cross_browser_summary.with_fatal > 0}
                · <span class="qa-fail">{m.cross_browser_summary.with_fatal} fatal</span>
              {/if}
              {#if m.cross_browser_summary.with_suspect > 0}
                · <span class="qa-warn">{m.cross_browser_summary.with_suspect} suspect</span>
              {/if}
              {#if m.controller}
                · controllers {m.controller.profiles_passed}/{m.controller.profiles_total}
              {/if}
            </div>
          </div>

          <!-- OS × engine matrix -->
          <div class="qa-matrix-wrap">
            <table class="qa-matrix">
              <thead>
                <tr>
                  <th></th>
                  {#each allEngines as engine}
                    <th>{engine}</th>
                  {/each}
                </tr>
              </thead>
              <tbody>
                {#each allOSes as os}
                  <tr>
                    <th>{os}</th>
                    {#each allEngines as engine}
                      {@const cell = cellAt(os, engine)}
                      <td class={statusClass(cell?.status)}>
                        {#if cell}
                          <div class="qa-cell-status">{cell.status}</div>
                          {#if cell.boot_elapsed_s != null}
                            <div class="qa-cell-detail">{cell.boot_elapsed_s}s · {cell.iframe_log_count ?? 0} logs</div>
                          {/if}
                          {#if (cell.fatal_log_count ?? 0) > 0}
                            <div class="qa-cell-flag">{cell.fatal_log_count} FATAL</div>
                          {:else if (cell.suspect_log_count ?? 0) > 0}
                            <div class="qa-cell-flag">{cell.suspect_log_count} suspect</div>
                          {/if}
                        {:else}
                          <div class="qa-cell-status qa-neutral">—</div>
                        {/if}
                      </td>
                    {/each}
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>

          <!-- Screenshots row -->
          <details class="qa-screenshots" open>
            <summary>Screenshots</summary>
            <div class="qa-screenshot-grid">
              {#each m.engines as e (e.os + "-" + e.engine)}
                {#if e.screenshot_url}
                  <figure class="qa-screenshot">
                    <img src={e.screenshot_url} alt="{e.os} / {e.engine}" loading="lazy" />
                    <figcaption>{e.os} · {e.engine}</figcaption>
                  </figure>
                {/if}
              {/each}
            </div>
          </details>

          <!-- Suspect / fatal log excerpts -->
          {#each m.engines as e (e.os + "-" + e.engine)}
            {#if (e.fatal_samples?.length ?? 0) > 0 || (e.suspect_samples?.length ?? 0) > 0}
              <details class="qa-logs">
                <summary>
                  {e.os} · {e.engine} —
                  {(e.fatal_samples?.length ?? 0)} fatal, {(e.suspect_samples?.length ?? 0)} suspect
                </summary>
                {#if e.fatal_samples && e.fatal_samples.length > 0}
                  <div class="qa-logs-section">
                    <div class="qa-logs-label">Fatal</div>
                    {#each e.fatal_samples as s}
                      <pre class="qa-log-line qa-log-fatal">{s}</pre>
                    {/each}
                  </div>
                {/if}
                {#if e.suspect_samples && e.suspect_samples.length > 0}
                  <div class="qa-logs-section">
                    <div class="qa-logs-label">Suspect</div>
                    {#each e.suspect_samples as s}
                      <pre class="qa-log-line qa-log-suspect">{s}</pre>
                    {/each}
                  </div>
                {/if}
              </details>
            {/if}
          {/each}
        {/if}
      </div>
    </div>
  {/if}
</section>

<style>
  .deploy-qa-section {
    margin: 1.5rem 0;
    padding: 1rem;
    background: #0d1117;
    border: 1px solid #374151;
    border-radius: 4px;
  }
  .qa-title {
    margin: 0 0 0.75rem;
    font-family: "Courier New", monospace;
    font-size: 1rem;
    color: #a7f3d0;
    text-transform: uppercase;
    letter-spacing: 0.08em;
  }
  .qa-subtitle {
    text-transform: none;
    letter-spacing: 0;
    font-size: 0.75rem;
    color: #9ca3af;
    margin-left: 0.6rem;
    font-weight: normal;
  }
  .qa-empty {
    color: #9ca3af;
    font-size: 0.85rem;
    padding: 0.75rem 0;
  }
  .qa-error {
    color: #fca5a5;
  }
  .qa-layout {
    display: grid;
    grid-template-columns: 220px 1fr;
    gap: 1rem;
  }
  @media (max-width: 768px) {
    .qa-layout {
      grid-template-columns: 1fr;
    }
  }
  .qa-history-title {
    font-family: "Courier New", monospace;
    font-size: 0.75rem;
    color: #9ca3af;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    margin-bottom: 0.5rem;
  }
  .qa-history-list {
    list-style: none;
    padding: 0;
    margin: 0;
    max-height: 360px;
    overflow-y: auto;
  }
  .qa-history-item {
    width: 100%;
    text-align: left;
    background: transparent;
    border: 1px solid transparent;
    border-radius: 3px;
    padding: 0.4rem 0.5rem;
    margin-bottom: 0.2rem;
    color: #d1d5db;
    font-family: "Courier New", monospace;
    font-size: 0.72rem;
    cursor: pointer;
    display: grid;
    grid-template-columns: auto auto 1fr;
    gap: 0.5rem;
    align-items: center;
  }
  .qa-history-item:hover {
    background: #161b22;
    border-color: #374151;
  }
  .qa-history-active {
    background: #161b22;
    border-color: #a7f3d0;
  }
  .qa-history-status {
    font-size: 0.68rem;
    padding: 0.1rem 0.35rem;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }
  .qa-history-sha {
    color: #a7f3d0;
  }
  .qa-history-time {
    color: #6b7280;
    text-align: right;
  }
  .qa-run-header {
    display: flex;
    justify-content: space-between;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid #374151;
    margin-bottom: 0.75rem;
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
    color: #d1d5db;
  }
  .qa-run-overall {
    padding: 0.15rem 0.45rem;
    border-radius: 2px;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    font-size: 0.72rem;
    margin-right: 0.5rem;
  }
  .qa-run-sha {
    color: #a7f3d0;
    margin-right: 0.5rem;
  }
  .qa-run-time {
    color: #9ca3af;
    margin-right: 0.5rem;
  }
  .qa-run-trigger {
    color: #6b7280;
    font-size: 0.7rem;
  }
  .qa-run-summary {
    color: #9ca3af;
  }
  .qa-matrix-wrap {
    overflow-x: auto;
    margin-bottom: 0.75rem;
  }
  .qa-matrix {
    border-collapse: collapse;
    width: 100%;
    font-family: "Courier New", monospace;
    font-size: 0.75rem;
  }
  .qa-matrix th,
  .qa-matrix td {
    border: 1px solid #374151;
    padding: 0.5rem;
    text-align: left;
    vertical-align: top;
  }
  .qa-matrix th {
    background: #161b22;
    color: #9ca3af;
    font-weight: normal;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    font-size: 0.7rem;
  }
  .qa-cell-status {
    font-weight: bold;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.72rem;
  }
  .qa-cell-detail {
    color: #9ca3af;
    font-size: 0.68rem;
    margin-top: 0.15rem;
  }
  .qa-cell-flag {
    color: #fca5a5;
    font-size: 0.68rem;
    margin-top: 0.15rem;
  }
  .qa-ok {
    background: rgba(52, 211, 153, 0.12);
    color: #6ee7b7;
  }
  .qa-warn {
    background: rgba(252, 211, 77, 0.12);
    color: #fcd34d;
  }
  .qa-fail {
    background: rgba(248, 113, 113, 0.12);
    color: #fca5a5;
  }
  .qa-neutral {
    color: #6b7280;
  }
  .qa-screenshots,
  .qa-logs {
    margin: 0.5rem 0;
    border: 1px solid #374151;
    border-radius: 3px;
    padding: 0.5rem 0.75rem;
    font-family: "Courier New", monospace;
    font-size: 0.78rem;
  }
  .qa-screenshots summary,
  .qa-logs summary {
    cursor: pointer;
    color: #d1d5db;
  }
  .qa-screenshot-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.75rem;
    margin-top: 0.75rem;
  }
  .qa-screenshot {
    margin: 0;
    background: #161b22;
    border: 1px solid #374151;
    border-radius: 3px;
    padding: 0.4rem;
  }
  .qa-screenshot img {
    display: block;
    width: 100%;
    height: auto;
    border-radius: 2px;
  }
  .qa-screenshot figcaption {
    font-size: 0.7rem;
    color: #9ca3af;
    margin-top: 0.35rem;
    text-align: center;
  }
  .qa-logs-section {
    margin-top: 0.5rem;
  }
  .qa-logs-label {
    color: #9ca3af;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    margin-bottom: 0.2rem;
  }
  .qa-log-line {
    background: #0a0e17;
    color: #d1d5db;
    padding: 0.35rem 0.5rem;
    border-radius: 2px;
    font-size: 0.72rem;
    margin: 0.2rem 0;
    white-space: pre-wrap;
    word-break: break-word;
    border-left: 2px solid transparent;
  }
  .qa-log-fatal {
    border-left-color: #f87171;
  }
  .qa-log-suspect {
    border-left-color: #fcd34d;
  }
</style>
