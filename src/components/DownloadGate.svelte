<script lang="ts">
  import { connectionInfo, DOWNLOAD_MB } from "../lib/downloadGate";

  interface Props {
    /** User consents — caller sets the iframe src and starts the download. */
    oncontinue: () => void;
    /** Optional back-out (homepage shows this; /play omits it). */
    oncancel?: () => void;
    /** "fresh" = first load on this device; "update" = a new version bumped the
     *  service-worker cache, so the full game re-downloads. */
    mode?: "fresh" | "update";
  }
  let { oncontinue, oncancel, mode = "fresh" }: Props = $props();

  const conn = connectionInfo();
  const metered = conn.saveData || conn.slow;
  const isUpdate = mode === "update";
</script>

<div class="dl-gate" role="dialog" aria-modal="true" aria-labelledby="dl-gate-title">
  <div class="dl-card">
    <h2 id="dl-gate-title">{isUpdate ? "Game updated" : "Before you play"}</h2>
    <p class="dl-lead">
      {#if isUpdate}
        A new version is ready. Updating re-downloads about
        <strong>{DOWNLOAD_MB}&nbsp;MB</strong> — the engine and art are refreshed.
      {:else}
        The first load downloads about <strong>{DOWNLOAD_MB}&nbsp;MB</strong> — the game
        engine and art. It runs entirely in your browser, so there's a one-time download.
      {/if}
    </p>
    <ul class="dl-points">
      <li><span aria-hidden="true">📶</span> Best on <strong>Wi-Fi</strong> — on cellular this uses mobile data.</li>
      <li><span aria-hidden="true">💾</span> <strong>Saved after</strong> the first time, so it opens instantly later.</li>
    </ul>

    {#if metered}
      <p class="dl-warn">
        ⚠ You appear to be on a {conn.saveData ? "data-saver" : "slow or limited"}
        connection. This download may use cellular data — Wi-Fi is recommended.
      </p>
    {/if}

    <div class="dl-actions">
      <button class="dl-go" onclick={oncontinue}>
        {isUpdate ? "Update" : "Continue"} · ~{DOWNLOAD_MB}&nbsp;MB
      </button>
      {#if oncancel}
        <button class="dl-cancel" onclick={oncancel}>Not now</button>
      {/if}
    </div>
  </div>
</div>

<style>
  .dl-gate {
    position: absolute;
    inset: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1.5rem;
    background: var(--engine-bg, #0a0e14);
    color: var(--engine-text, #d6e0e8);
    z-index: 20;
  }
  .dl-card {
    max-width: 30rem;
    width: 100%;
    background: rgba(20, 28, 38, 0.92);
    border: 1px solid rgba(167, 243, 208, 0.28);
    border-radius: 12px;
    padding: 1.75rem 1.75rem 1.5rem;
    font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace;
    box-shadow: 0 10px 40px rgba(0, 0, 0, 0.5);
  }
  .dl-card h2 {
    margin: 0 0 0.75rem;
    font-size: 1.25rem;
    color: var(--engine-accent, #a7f3d0);
    letter-spacing: 0.01em;
  }
  .dl-lead {
    margin: 0 0 1rem;
    line-height: 1.55;
    font-size: 0.95rem;
  }
  .dl-points {
    list-style: none;
    margin: 0 0 1rem;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    font-size: 0.9rem;
    line-height: 1.45;
  }
  .dl-points li {
    display: flex;
    gap: 0.6rem;
    align-items: baseline;
  }
  .dl-warn {
    margin: 0 0 1rem;
    padding: 0.65rem 0.8rem;
    border-radius: 8px;
    background: rgba(234, 179, 8, 0.12);
    border: 1px solid rgba(234, 179, 8, 0.4);
    color: #f5d98a;
    font-size: 0.85rem;
    line-height: 1.45;
  }
  .dl-actions {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    flex-wrap: wrap;
  }
  .dl-go {
    flex: 1 1 auto;
    min-width: 12rem;
    padding: 0.75rem 1.1rem;
    border: 1px solid var(--engine-accent, #a7f3d0);
    border-radius: 8px;
    background: rgba(167, 243, 208, 0.14);
    color: var(--engine-accent, #a7f3d0);
    font-family: inherit;
    font-size: 0.95rem;
    font-weight: 600;
    cursor: pointer;
    transition: background 0.15s ease;
  }
  .dl-go:hover {
    background: rgba(167, 243, 208, 0.26);
  }
  .dl-cancel {
    padding: 0.75rem 1rem;
    border: 1px solid rgba(214, 224, 232, 0.25);
    border-radius: 8px;
    background: transparent;
    color: rgba(214, 224, 232, 0.8);
    font-family: inherit;
    font-size: 0.9rem;
    cursor: pointer;
  }
  .dl-cancel:hover {
    border-color: rgba(214, 224, 232, 0.5);
    color: #d6e0e8;
  }
  .dl-go:focus-visible,
  .dl-cancel:focus-visible {
    outline: 2px solid var(--engine-accent, #a7f3d0);
    outline-offset: 2px;
  }
</style>
