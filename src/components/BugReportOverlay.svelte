<script lang="ts">
  // DOM bug-report form rendered on the /play PARENT page (not in the game iframe).
  // A real <textarea> raises the native mobile soft keyboard — which the Godot
  // WebGL canvas can't do. Opened by the game's `allbyte:bug_report_open` message;
  // the game supplies context (scene, saveSnapshot, recentLogs), the user types
  // here, and GodotEmbed submits via the existing bugReport.ts path.
  import type { BugReportContext } from "../lib/bugReport";

  interface Props {
    context: BugReportContext | null;
    status: "idle" | "sending" | "sent" | "error";
    error?: string | null;
    onSend: (payload: { text: string; category: string }) => void;
    onCancel: () => void;
  }
  let { context, status, error = null, onSend, onCancel }: Props = $props();

  const CATEGORIES = ["crash", "graphics", "gameplay", "audio", "ui", "other"];
  let text = $state("");
  let category = $state("other");
  let ta = $state<HTMLTextAreaElement | null>(null);

  // Focus on open. Desktop raises the caret immediately; on mobile the keyboard
  // needs a real tap on THIS page (the game's tap was inside the iframe, so it
  // doesn't carry parent activation) — the textarea is the obvious tap target.
  $effect(() => {
    if (ta) ta.focus();
  });

  function send() {
    const t = text.trim();
    if (!t || status === "sending") return;
    onSend({ text: t, category });
  }
</script>

<div class="br-backdrop" role="dialog" aria-modal="true" aria-label="Report a bug">
  <div class="br-modal">
    <div class="br-head">
      <h2>Report a bug</h2>
      <button class="br-x" onclick={onCancel} aria-label="Close">×</button>
    </div>

    {#if status === "sent"}
      <p class="br-ok">✓ Report sent — thank you!</p>
    {:else}
      <label class="br-lbl" for="br-text">What happened?</label>
      <textarea
        id="br-text"
        bind:this={ta}
        bind:value={text}
        rows="5"
        maxlength="4000"
        placeholder="Describe the bug — what you did, and what went wrong…"
        disabled={status === "sending"}
      ></textarea>

      <div class="br-row">
        <label class="br-lbl" for="br-cat">Type</label>
        <select id="br-cat" bind:value={category} disabled={status === "sending"}>
          {#each CATEGORIES as c}<option value={c}>{c}</option>{/each}
        </select>
      </div>

      {#if context?.scene || context?.saveSnapshot}
        <p class="br-ctx">
          {#if context?.scene}Scene <b>{context.scene}</b> · {/if}your current save + recent logs are attached automatically
        </p>
      {/if}

      {#if status === "error"}
        <p class="br-err">Couldn’t send{error ? `: ${error}` : ""}. Please try again.</p>
      {/if}

      <div class="br-actions">
        <button class="br-btn ghost" onclick={onCancel} disabled={status === "sending"}>Cancel</button>
        <button class="br-btn primary" onclick={send} disabled={!text.trim() || status === "sending"}>
          {status === "sending" ? "Sending…" : "Submit"}
        </button>
      </div>
    {/if}
  </div>
</div>

<style>
  /* NOTE: this component's scoped <style> is DROPPED from the client:load island
     bundle (Astro/Svelte quirk — scope class ships but rules don't). The EFFECTIVE
     overlay styles live in GodotEmbed.svelte as a :global block. Kept here as the
     design reference; editing these alone will NOT change the rendered overlay. */
  .br-backdrop {
    position: fixed;
    inset: 0;
    z-index: 100000;
    background: rgba(3, 6, 12, 0.72);
    display: flex;
    justify-content: center;
    /* top-anchored so the on-screen keyboard doesn't cover the textarea */
    align-items: flex-start;
    padding: 8vh 1rem 1rem;
    overflow-y: auto;
  }
  .br-modal {
    width: 100%;
    max-width: 460px;
    background: #131a26;
    color: #e7ecf5;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 10px;
    padding: 1rem 1.1rem 1.15rem;
    box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
    font-family: system-ui, -apple-system, sans-serif;
  }
  .br-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.6rem; }
  .br-head h2 { margin: 0; font-size: 1.15rem; color: #a7f3d0; }
  .br-x {
    background: none; border: none; color: rgba(231, 236, 245, 0.6);
    font-size: 1.6rem; line-height: 1; cursor: pointer; padding: 0 0.2rem;
  }
  .br-x:hover { color: #e7ecf5; }
  .br-lbl { display: block; font-size: 0.82rem; color: rgba(231, 236, 245, 0.7); margin: 0.4rem 0 0.25rem; }
  textarea, select {
    width: 100%;
    /* 16px min — smaller triggers iOS Safari's zoom-on-focus */
    font-size: 16px;
    font-family: inherit;
    color: #e7ecf5;
    background: #0a0e17;
    border: 1px solid rgba(167, 243, 208, 0.25);
    border-radius: 6px;
    padding: 0.55rem 0.6rem;
    box-sizing: border-box;
  }
  textarea { resize: vertical; min-height: 5.5rem; line-height: 1.45; }
  textarea:focus, select:focus { outline: none; border-color: #a7f3d0; }
  .br-row { display: flex; align-items: center; gap: 0.6rem; margin-top: 0.5rem; }
  .br-row .br-lbl { margin: 0; flex-shrink: 0; }
  .br-row select { width: auto; flex: 1; }
  .br-ctx { font-size: 0.74rem; color: rgba(231, 236, 245, 0.5); margin: 0.55rem 0 0; }
  .br-ctx b { color: #a7f3d0; }
  .br-err { font-size: 0.82rem; color: #fca5a5; margin: 0.55rem 0 0; }
  .br-ok { font-size: 1rem; color: #a7f3d0; text-align: center; padding: 1.2rem 0; margin: 0; }
  .br-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 0.9rem; }
  .br-btn {
    font-family: inherit; font-size: 0.9rem; padding: 0.5rem 1rem;
    border-radius: 6px; cursor: pointer; border: 1px solid transparent;
  }
  .br-btn:disabled { opacity: 0.5; cursor: default; }
  .br-btn.ghost { background: transparent; color: rgba(231, 236, 245, 0.75); border-color: rgba(231, 236, 245, 0.25); }
  .br-btn.ghost:hover:not(:disabled) { background: rgba(255, 255, 255, 0.06); }
  .br-btn.primary { background: #a7f3d0; color: #0a0e17; font-weight: 700; }
  .br-btn.primary:hover:not(:disabled) { background: #bef7de; }
</style>
