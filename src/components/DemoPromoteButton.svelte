<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";
  import {
    promoteDevelop, fetchBuildStatus,
    type PromoteResult, type BuildStatus,
  } from "../lib/demoPromote";

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));
  let ready = $state(false);
  let developVersion = $state<string | null>(null);

  let confirming = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let result = $state<PromoteResult | null>(null);
  let statuses = $state<Record<string, BuildStatus>>({});
  let poll: ReturnType<typeof setInterval> | null = null;

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    ready = true;
    try {
      const r = await fetch("/godot/channels.json", { cache: "no-store" });
      if (r.ok) developVersion = (await r.json())?.develop?.version ?? null;
    } catch { /* best-effort */ }
  });

  onDestroy(() => { if (poll) clearInterval(poll); });

  async function doPromote() {
    confirming = false;
    submitting = true;
    error = null;
    result = null;
    statuses = {};
    try {
      result = await promoteDevelop(auth.authToken ?? "");
      startPolling();
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      submitting = false;
    }
  }

  function activeIds(): string[] {
    return (result?.builds ?? [])
      .filter((b) => b.buildId)
      .map((b) => b.buildId as string);
  }

  function startPolling() {
    if (poll) clearInterval(poll);
    const ids = activeIds();
    if (!ids.length) return;
    const tick = async () => {
      try {
        const s = await fetchBuildStatus(auth.authToken ?? "", ids);
        const map: Record<string, BuildStatus> = {};
        for (const b of s) map[b.id] = b;
        statuses = map;
        const done = s.every((b) => b.status && b.status !== "IN_PROGRESS");
        if (done && poll) { clearInterval(poll); poll = null; }
      } catch { /* keep last */ }
    };
    tick();
    poll = setInterval(tick, 5000);
  }

  function badge(b: { status: string; buildId?: string }): { label: string; cls: string } {
    if (b.status === "unavailable") return { label: "waiting on build project", cls: "wait" };
    if (b.status === "error") return { label: "error", cls: "err" };
    const live = b.buildId ? statuses[b.buildId]?.status : null;
    if (live === "SUCCEEDED") return { label: "deployed ✓", cls: "ok" };
    if (live === "FAILED" || live === "FAULT" || live === "TIMED_OUT" || live === "STOPPED")
      return { label: live.toLowerCase(), cls: "err" };
    if (live === "IN_PROGRESS") return { label: "building…", cls: "run" };
    return { label: "started", cls: "run" };
  }
</script>

<div class="promote">
  {#if !ready}
    <p class="muted">Loading…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to promote builds.</p>
  {:else}
    <div class="card">
      <h3>Promote develop → live</h3>
      <p class="lead">
        Rebuilds the <b>release</b> (public <b>Demo</b>, debug compiled out) and <b>Demo&nbsp;Debug</b>
        variants from develop's current commit{#if developVersion} (<code>{developVersion}</code>){/if}
        and deploys each. The public Demo goes live once its boot-smoke passes.
      </p>

      {#if !result}
        {#if !confirming}
          <button class="btn danger" onclick={() => (confirming = true)} disabled={submitting}>
            Promote develop → Demo + Demo&nbsp;Debug
          </button>
        {:else}
          <div class="confirm">
            <p><b>Confirm:</b> promote develop{#if developVersion} <code>{developVersion}</code>{/if}
              to the <b>public Demo</b> and Demo&nbsp;Debug? This ships to the live demo.</p>
            <div class="row">
              <button class="btn danger" onclick={doPromote} disabled={submitting}>
                {submitting ? "Starting…" : "Yes, promote"}
              </button>
              <button class="btn" onclick={() => (confirming = false)} disabled={submitting}>Cancel</button>
            </div>
          </div>
        {/if}
      {:else}
        <div class="result">
          <p class="muted">Promoting <code>{result.version}</code>
            <span class="sub">({result.promotingSha?.slice(0, 8)})</span></p>
          <ul class="builds">
            {#each result.builds as b (b.channel)}
              {@const bd = badge(b)}
              <li>
                <span class="ch">{b.label}</span>
                <span class="st {bd.cls}">{bd.label}</span>
                {#if b.error}<span class="berr">{b.error}</span>{/if}
              </li>
            {/each}
          </ul>
          <p class="finalize-note">
            ✓ Nothing to run — once the <b>Demo</b> deploys, the <b>Finalize&nbsp;Demo</b> Action
            reconciles <code>game-version.json</code> + <code>sw.js</code> automatically
            (within&nbsp;~10&nbsp;min). Need it instant? Run the <b>Finalize&nbsp;Demo</b> workflow.
          </p>
          <button class="btn" onclick={() => { result = null; error = null; }}>Done</button>
        </div>
      {/if}

      {#if error}<p class="err">Couldn’t promote: {error}</p>{/if}

      <p class="note">
        develop stays the debug test lane; this doesn’t touch it. Each target boot-smoke-gates —
        a build that doesn’t boot never reaches its channel. “Waiting on build project” means the
        channel’s CodeBuild project isn’t deployed yet (pending Arc’s <code>buildspec.web.yml</code>).
      </p>
    </div>
  {/if}
</div>

<style>
  .promote {
    background: var(--panel); color: var(--ink); font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    padding: 1.25rem; max-width: 720px; margin: 0 auto;
  }
  .muted { color: var(--ink-soft); }
  .sub { color: var(--ink-soft); }
  .card { background: #131a26; border: 1px solid var(--rule); border-radius: 8px; padding: 1.25rem 1.4rem; }
  h3 { color: var(--crimson); font-size: 1.05rem; margin: 0 0 0.5rem; }
  .lead { font-size: 0.9rem; line-height: 1.55; color: var(--ink-soft); margin: 0 0 1.1rem; }
  .lead b { color: var(--ink); }
  code { background: var(--rule); padding: 0 0.35rem; border-radius: 3px; color: var(--crimson); }
  .btn {
    background: transparent; color: var(--crimson); border: 1px solid var(--rule);
    border-radius: 5px; padding: 0.5rem 0.9rem; font-family: inherit; font-size: 0.88rem; cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--rule); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.danger { color: #fca5a5; border-color: rgba(248, 113, 113, 0.5); }
  .btn.danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.12); }
  .confirm { background: rgba(248, 113, 113, 0.08); border: 1px solid rgba(248, 113, 113, 0.35); border-radius: 6px; padding: 0.85rem 1rem; }
  .confirm p { margin: 0 0 0.8rem; font-size: 0.88rem; line-height: 1.5; }
  .row { display: flex; gap: 0.6rem; }
  .result .muted { margin: 0 0 0.7rem; }
  .builds { list-style: none; padding: 0; margin: 0 0 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .builds li { display: flex; align-items: center; gap: 0.7rem; font-size: 0.85rem; }
  .ch { min-width: 8rem; color: var(--ink); }
  .st { padding: 0.12rem 0.5rem; border-radius: 4px; font-size: 0.76rem; border: 1px solid transparent; }
  .st.run { color: #fbbf24; background: rgba(251, 191, 36, 0.12); border-color: rgba(251, 191, 36, 0.35); }
  .st.ok { color: var(--crimson); background: var(--panel); border-color: var(--panel); }
  .st.err { color: #f87171; background: rgba(248, 113, 113, 0.12); border-color: rgba(248, 113, 113, 0.4); }
  .st.wait { color: var(--ink-soft); background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.12); }
  .berr { color: rgba(248, 113, 113, 0.8); font-size: 0.74rem; }
  .finalize-note {
    margin: 0.7rem 0 0;
    padding: 0.55rem 0.7rem;
    font-size: 0.78rem;
    line-height: 1.45;
    color: rgba(253, 224, 71, 0.9);
    background: rgba(253, 224, 71, 0.08);
    border: 1px solid rgba(253, 224, 71, 0.3);
    border-radius: 6px;
  }
  .finalize-note code {
    color: #fde047;
    background: rgba(253, 224, 71, 0.12);
    padding: 0.05rem 0.3rem;
    border-radius: 3px;
  }
  .err { color: #f87171; font-size: 0.85rem; margin-top: 0.6rem; }
  .note { color: var(--ink-soft); font-size: 0.74rem; line-height: 1.55; margin-top: 1.1rem; }
</style>
