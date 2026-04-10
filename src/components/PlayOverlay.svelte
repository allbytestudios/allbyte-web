<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { saves, downloadSavesFile, uploadSavesFile, syncToServerNow } from "../lib/saves.svelte.ts";

  interface Props {
    onExit: () => void;
  }

  let { onExit }: Props = $props();

  let fileInput: HTMLInputElement | null = $state(null);
  let uploadError = $state<string | null>(null);

  function handleSaveClick() {
    downloadSavesFile();
  }

  function handleLoadClick() {
    uploadError = null;
    fileInput?.click();
  }

  async function handleFileSelected(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    if (!confirm("Load this save file? This will overwrite your current saves.")) {
      input.value = "";
      return;
    }

    const err = await uploadSavesFile(file);
    if (err) {
      uploadError = err;
    } else {
      uploadError = null;
    }
    input.value = "";
  }

  const isSyncTier = $derived(
    auth.currentUser?.tier === "hero" || auth.currentUser?.tier === "legend"
  );

  const syncLabel = $derived.by(() => {
    switch (saves.syncStatus) {
      case "syncing": return "Syncing...";
      case "synced": return "Synced ✓";
      case "unsynced": return "Pending sync...";
      case "error": return "⚠ Sync error";
      default: return "Not synced";
    }
  });
</script>

<div class="play-overlay-header">
  <button class="play-btn back-btn" onclick={onExit} aria-label="Back to home">
    <span class="btn-icon" aria-hidden="true">&larr;</span>
    <span class="btn-label">Back</span>
  </button>

  <div class="play-overlay-actions">
    <button class="play-btn" onclick={handleSaveClick} aria-label="Download saves to file">
      <span class="btn-icon" aria-hidden="true">&#x1F4BE;</span>
      <span class="btn-label">Save state</span>
    </button>

    <button class="play-btn" onclick={handleLoadClick} aria-label="Upload saves from file">
      <span class="btn-icon" aria-hidden="true">&#x1F4C2;</span>
      <span class="btn-label">Load state</span>
    </button>

    <input
      type="file"
      accept="application/json,.json"
      bind:this={fileInput}
      onchange={handleFileSelected}
      class="hidden-file-input"
      aria-hidden="true"
    />

    {#if isSyncTier}
      <button
        class="sync-indicator"
        class:syncing={saves.syncStatus === "syncing"}
        class:synced={saves.syncStatus === "synced"}
        class:error={saves.syncStatus === "error"}
        class:unsynced={saves.syncStatus === "unsynced"}
        onclick={syncToServerNow}
        title={saves.lastSyncedAt ? `Last synced ${new Date(saves.lastSyncedAt).toLocaleTimeString()}` : "Click to sync now"}
        aria-label="Server sync status: {syncLabel}"
      >
        {syncLabel}
      </button>
    {/if}
  </div>
</div>

{#if uploadError}
  <div class="upload-error" role="alert">{uploadError}</div>
{/if}

<style>
  .play-overlay-header {
    background: #1a1e26;
    border-bottom: 1px solid rgba(167, 243, 208, 0.2);
    padding: 0.4rem 1rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    min-height: 52px;
    flex: 0 0 auto;
  }

  .play-overlay-actions {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .play-btn {
    font-family: "Courier New", monospace;
    font-size: 0.95rem;
    color: #a7f3d0;
    background: rgba(167, 243, 208, 0.08);
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 4px;
    padding: 0.5rem 0.85rem;
    min-height: 44px;
    min-width: 44px;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    cursor: pointer;
    transition: background 0.15s, border-color 0.15s;
  }

  .play-btn:hover {
    background: rgba(167, 243, 208, 0.18);
    border-color: rgba(167, 243, 208, 0.5);
  }

  .btn-icon {
    font-size: 1.1rem;
    line-height: 1;
  }

  .btn-label {
    line-height: 1;
  }

  .hidden-file-input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  .sync-indicator {
    font-family: "Courier New", monospace;
    font-size: 0.85rem;
    background: rgba(224, 231, 255, 0.06);
    border: 1px solid rgba(224, 231, 255, 0.2);
    color: rgba(224, 231, 255, 0.8);
    border-radius: 4px;
    padding: 0.4rem 0.7rem;
    min-height: 44px;
    display: inline-flex;
    align-items: center;
    cursor: pointer;
    transition: all 0.2s;
  }

  .sync-indicator:hover {
    background: rgba(224, 231, 255, 0.12);
  }

  .sync-indicator.synced {
    color: #a7f3d0;
    border-color: rgba(167, 243, 208, 0.4);
  }

  .sync-indicator.syncing {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.4);
  }

  .sync-indicator.unsynced {
    color: #fbbf24;
    border-color: rgba(251, 191, 36, 0.3);
  }

  .sync-indicator.error {
    color: #f87171;
    border-color: rgba(239, 68, 68, 0.4);
  }

  .upload-error {
    background: rgba(239, 68, 68, 0.15);
    border-bottom: 1px solid rgba(239, 68, 68, 0.4);
    color: #fecaca;
    font-family: "Courier New", monospace;
    font-size: 0.9rem;
    padding: 0.5rem 1rem;
    text-align: center;
  }

  @media (max-width: 600px) {
    .btn-label {
      display: none;
    }

    .sync-indicator {
      font-size: 0.75rem;
      padding: 0.4rem 0.5rem;
    }
  }
</style>
