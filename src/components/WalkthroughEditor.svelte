<script lang="ts">
  /**
   * Walkthrough edit overlay (Phase 1).
   *
   * Two jobs, one island:
   *  1. FOR EVERYONE — fetch the per-scene overrides and swap the affected
   *     `.wt-prose` bodies so an owner's edit shows live (rendered by
   *     walkthroughRender, the prose-subset renderer).
   *  2. FOR ADMINS — inject an "Edit" button into each scene, opening an inline
   *     editor for the BODY markdown only (never the frontmatter — those keys
   *     join the spine + save tree). Saving persists the override and appends the
   *     diff to Quinn's learning feed (server-side).
   *
   * The scenes are server-rendered by Astro; this reaches into that DOM directly
   * (like WalkthroughChrome's scroll-spy), rather than owning the markup.
   */
  import { onMount } from "svelte";
  import { auth } from "../lib/auth.svelte";
  import { isAdmin } from "../lib/tier";
  import { renderProse } from "../lib/walkthroughRender";
  import { fetchOverrides, saveOverride, canEdit, type WalkthroughOverride } from "../lib/walkthroughOverrides";

  type Body = { body: string; scene?: string };

  let overrides = $state<Record<string, WalkthroughOverride>>({});
  let bodies: Record<string, Body> = {};
  let ready = $state(false);

  // editor state
  let editing = $state<{ code: string; scene?: string; base: string; md: string; note: string } | null>(null);
  let saving = $state(false);
  let toast = $state<{ msg: string; ok: boolean } | null>(null);
  let injected = false;

  const admin = $derived(isAdmin(auth.currentUser));

  function sceneEl(code: string): HTMLElement | null {
    return document.querySelector(`.wt-scene[data-code="${CSS.escape(code)}"]`);
  }
  function proseEl(code: string): HTMLElement | null {
    return sceneEl(code)?.querySelector(".wt-prose") ?? null;
  }

  function applyOne(code: string) {
    const prose = proseEl(code);
    const ov = overrides[code];
    if (!prose) return;
    if (ov) {
      prose.innerHTML = renderProse(ov.edited_md);
      sceneEl(code)?.setAttribute("data-overridden", "true");
    }
  }
  function applyAll() {
    for (const code of Object.keys(overrides)) applyOne(code);
  }

  function toastMsg(msg: string, ok = true) {
    toast = { msg, ok };
    setTimeout(() => (toast = null), 3200);
  }

  function openEditor(code: string) {
    const base = bodies[code]?.body ?? "";
    const ov = overrides[code];
    editing = {
      code,
      scene: bodies[code]?.scene,
      base,
      md: ov?.edited_md ?? base,
      note: "",
    };
  }
  function cancel() {
    editing = null;
  }
  async function save() {
    if (!editing) return;
    saving = true;
    const res = await saveOverride(
      {
        code: editing.code,
        scene: editing.scene,
        edited_md: editing.md,
        base_md: editing.base,
        note: editing.note.trim() || undefined,
      },
      auth.authToken,
    );
    saving = false;
    if (res.ok && res.override) {
      overrides = { ...overrides, [editing.code]: res.override };
      applyOne(editing.code);
      toastMsg(`Saved ${editing.code} · sent to Quinn's feed`);
      editing = null;
    } else {
      toastMsg(res.error ?? "Save failed", false);
    }
  }

  // Inject the admin Edit buttons once (idempotent).
  function injectEditButtons() {
    if (injected) return;
    injected = true;
    document.querySelectorAll<HTMLElement>(".wt-scene[data-code]").forEach((scene) => {
      const code = scene.getAttribute("data-code") ?? "";
      if (!code || scene.querySelector(".wt-edit-btn")) return;
      const head = scene.querySelector(".scene-head");
      if (!head) return;
      const btn = document.createElement("button");
      btn.className = "wt-edit-btn";
      btn.type = "button";
      btn.textContent = "Edit";
      btn.title = "Edit this section's text (admin)";
      btn.addEventListener("click", () => openEditor(code));
      head.appendChild(btn);
    });
  }

  onMount(() => {
    try {
      bodies = JSON.parse(document.getElementById("wt-scene-bodies")?.textContent || "{}");
    } catch {
      bodies = {};
    }
    (async () => {
      overrides = await fetchOverrides();
      applyAll();
      ready = true;
    })();
  });

  // Admin edit affordance appears once auth resolves — but only where editing is
  // actually wired (dev now; prod after the Phase-2 overlay stack lands).
  $effect(() => {
    if (ready && auth.authReady && admin && canEdit) injectEditButtons();
  });

  function onKey(e: KeyboardEvent) {
    if (e.key === "Escape" && editing) cancel();
  }
</script>

<svelte:window onkeydown={onKey} />

{#if editing}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="we-scrim" onclick={cancel}></div>
  <div class="we-panel" role="dialog" aria-modal="true" aria-label={`Edit ${editing.code}`}>
    <header class="we-head">
      <span>Edit <b>{editing.code}</b>{#if editing.scene} · {editing.scene}{/if}</span>
      <button class="we-x" onclick={cancel} aria-label="Cancel">✕</button>
    </header>
    <p class="we-hint">Body text only — the frontmatter (spine tags, screenshots, items) is off-limits. Goes live and is sent to Quinn.</p>
    <textarea class="we-md" bind:value={editing.md} spellcheck="true"></textarea>
    <label class="we-note-l">
      Why did you change it? <span class="we-opt">(optional, but it's what Quinn learns from)</span>
      <input class="we-note" bind:value={editing.note} placeholder="e.g. tightened the phrasing; players kept missing the bed" />
    </label>
    <div class="we-actions">
      <button class="we-cancel" onclick={cancel} disabled={saving}>Cancel</button>
      <button class="we-save" onclick={save} disabled={saving || !editing.md.trim()}>
        {saving ? "Saving…" : "Save & publish"}
      </button>
    </div>
  </div>
{/if}

{#if toast}
  <div class="we-toast" class:err={!toast.ok}>{toast.msg}</div>
{/if}

<style>
  /* Injected Edit buttons live in the Astro-rendered scenes, so style globally. */
  :global(.wt-edit-btn) {
    margin-left: auto;
    font-family: "Courier New", monospace;
    font-size: 0.66rem;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: #5a4d38;
    background: rgba(58, 48, 32, 0.08);
    border: 1px solid rgba(58, 48, 32, 0.3);
    border-radius: 4px;
    padding: 0.12rem 0.5rem;
    cursor: pointer;
  }
  :global(.wt-edit-btn:hover) {
    background: rgba(58, 48, 32, 0.16);
    border-color: rgba(58, 48, 32, 0.5);
  }
  :global(.wt-scene[data-overridden="true"] .wt-edit-btn::after) {
    content: " · edited";
    color: #8a4d08;
  }

  .we-scrim {
    position: fixed; inset: 0; z-index: 300; background: rgba(30, 22, 10, 0.5);
  }
  .we-panel {
    position: fixed; z-index: 301; left: 50%; top: 50%; transform: translate(-50%, -50%);
    width: min(680px, 94vw); max-height: 90vh; display: flex; flex-direction: column;
    background: #f3ead0; color: #2a2218; border: 1px solid #7a6e52; border-radius: 8px;
    box-shadow: 0 12px 40px rgba(30, 22, 10, 0.5);
    font-family: Georgia, "Times New Roman", serif; padding: 1rem 1.1rem 1.1rem;
  }
  .we-head { display: flex; align-items: center; justify-content: space-between; font-size: 0.95rem; }
  .we-head b { color: #3a3020; }
  .we-x { background: none; border: 0; font-size: 1.3rem; line-height: 1; cursor: pointer; color: #5a4d38; padding: 0.1rem 0.35rem; }
  .we-hint { margin: 0.35rem 0 0.6rem; font-size: 0.78rem; color: #5a4d38; }
  .we-md {
    width: 100%; min-height: 260px; flex: 1; resize: vertical;
    font-family: "Courier New", monospace; font-size: 0.85rem; line-height: 1.55;
    color: #2a2218; background: #fdf8ea; border: 1px solid #b6a878; border-radius: 5px; padding: 0.7rem 0.8rem;
  }
  .we-note-l { display: block; margin: 0.7rem 0 0; font-size: 0.8rem; color: #5a4d38; }
  .we-opt { color: #8a7d60; font-style: italic; }
  .we-note {
    display: block; width: 100%; margin-top: 0.3rem; font-family: Georgia, serif; font-size: 0.85rem;
    color: #2a2218; background: #fdf8ea; border: 1px solid #b6a878; border-radius: 5px; padding: 0.45rem 0.6rem;
  }
  .we-actions { display: flex; justify-content: flex-end; gap: 0.6rem; margin-top: 0.9rem; }
  .we-cancel, .we-save {
    font-family: Georgia, serif; font-size: 0.85rem; padding: 0.45rem 1rem; border-radius: 5px; cursor: pointer;
  }
  .we-cancel { background: none; border: 1px solid #7a6e52; color: #5a4d38; }
  .we-save { background: #3a3020; border: 1px solid #241d12; color: #f3ead0; }
  .we-save:disabled, .we-cancel:disabled { opacity: 0.55; cursor: default; }

  .we-toast {
    position: fixed; z-index: 320; left: 50%; bottom: 1.4rem; transform: translateX(-50%);
    background: #2f5233; color: #eafaea; font-family: Georgia, serif; font-size: 0.85rem;
    padding: 0.55rem 1rem; border-radius: 6px; box-shadow: 0 6px 20px rgba(0, 0, 0, 0.35);
  }
  .we-toast.err { background: #6e2b25; color: #fbeae8; }
</style>
