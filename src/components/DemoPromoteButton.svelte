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
  // What prod is on RIGHT NOW — i.e. what this promote would replace.
  //
  // This used to read channels.json's `develop` entry and present it as the
  // version about to ship. That entry is dead: develop was retired as a
  // deployed channel on 2026-08-17 and nothing has written to it since, so it
  // sat at 0.8.2356 while prod moved on — the button showed a stale number for
  // a correct build. There is no honest pre-flight version to show anyway,
  // because CodeBuild exports from develop's HEAD and the version isn't known
  // until it builds; `result.version` reports the real one once it starts.
  let liveVersion = $state<string | null>(null);

  let confirming = $state(false);
  let submitting = $state(false);
  let error = $state<string | null>(null);
  let result = $state<PromoteResult | null>(null);
  let statuses = $state<Record<string, BuildStatus>>({});
  let verificationTimedOut = $state(false);
  let verificationUnavailable = $state(false);
  let statusError = $state<string | null>(null);
  let pollStartedAt = 0;
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
      if (r.ok) liveVersion = (await r.json())?.alpha?.version ?? null;
    } catch { /* best-effort */ }
  });

  onDestroy(() => { if (poll) clearInterval(poll); });

  async function doPromote() {
    confirming = false;
    submitting = true;
    error = null;
    result = null;
    statuses = {};
    resolvedSha = undefined;
    verificationTimedOut = false;
    verificationUnavailable = false;
    statusError = null;
    try {
      result = await promoteDevelop(auth.authToken ?? "");
      startPolling();
    } catch (e: any) {
      error = e?.message ?? String(e);
    } finally {
      submitting = false;
    }
  }

  let resolvedSha = $state<string | undefined>(undefined);

  function activeIds(): string[] {
    return (result?.builds ?? [])
      .filter((b) => b.buildId)
      .map((b) => b.buildId as string);
  }

  function startPolling() {
    if (poll) clearInterval(poll);
    const ids = activeIds();
    if (!ids.length) return;
    pollStartedAt = Date.now();
    const tick = async () => {
      try {
        const s = await fetchBuildStatus(auth.authToken ?? "", ids);
        statusError = null;
        const map: Record<string, BuildStatus> = {};
        for (const b of s) map[b.id] = b;
        statuses = map;
        // The ref only becomes a commit once CodeBuild fetches source. Surface
        // the first one that resolves, so the card can say what actually shipped
        // rather than what we asked for.
        resolvedSha = s.find((b) => b.sha)?.sha ?? resolvedSha;
        const terminalBuilds = result?.builds.filter((item) => item.buildId) ?? [];
        const oldStatusApi = terminalBuilds.length > 0 && terminalBuilds.every((item) => {
          const status = map[item.buildId || ""];
          return status?.status === "SUCCEEDED" && !status.releaseVerification;
        });
        if (oldStatusApi) {
          verificationUnavailable = true;
          if (poll) clearInterval(poll);
          poll = null;
          return;
        }
        const failed = result?.builds.some((item) => {
          const status = map[item.buildId || ""]?.status;
          return ["FAILED", "FAULT", "TIMED_OUT", "STOPPED"].includes(status || "");
        });
        const verified = result?.builds.length && result.builds.every((item) => {
          const status = map[item.buildId || ""];
          return status?.status === "SUCCEEDED" && status.releaseVerification?.status === "verified";
        });
        if (failed || verified) {
          if (poll) clearInterval(poll);
          poll = null;
        }
      } catch (e: any) {
        statusError = e?.message ?? String(e);
      }
      if (poll && Date.now() - pollStartedAt >= 15 * 60 * 1000) {
        verificationTimedOut = true;
        clearInterval(poll);
        poll = null;
      }
    };
    tick();
    poll = setInterval(tick, 15000);
  }

  function badge(b: { status: string; buildId?: string }): { label: string; cls: string } {
    if (b.status === "unavailable") return { label: "waiting on build project", cls: "wait" };
    if (b.status === "error") return { label: "error", cls: "err" };
    const live = b.buildId ? statuses[b.buildId]?.status : null;
    if (live === "SUCCEEDED" && statuses[b.buildId || ""]?.releaseVerification?.status === "verified")
      return { label: "live + verified", cls: "ok" };
    if (live === "SUCCEEDED") return { label: "game published; checking site", cls: "run" };
    if (live === "FAILED" || live === "FAULT" || live === "TIMED_OUT" || live === "STOPPED")
      return { label: live.toLowerCase(), cls: "err" };
    if (live === "IN_PROGRESS") return { label: "building…", cls: "run" };
    return { label: "started", cls: "run" };
  }

  function resultMessage(): string {
    const builds = result?.builds ?? [];
    const failed = builds.some((b) => {
      const status = b.buildId ? statuses[b.buildId]?.status : b.status;
      return b.status === "error" || ["FAILED", "FAULT", "TIMED_OUT", "STOPPED"].includes(status || "");
    });
    if (failed) return "Game build or upload failed. Open the failed build log before retrying.";
    if (statusError) return "The release status service returned an error; details are shown below.";
    if (builds.some((b) => b.status === "unavailable")) return "The configured game build project is unavailable; no release was started.";
    if (builds.length && builds.every((b) => b.status === "error")) return "The release could not start. See the CodeBuild start error above.";
    if (verificationTimedOut) return "The game build passed, but live game, service-worker, and What's New checks did not agree within 15 minutes.";
    if (verificationUnavailable) return "The game build passed, but this status service has not been updated to report live webapp verification.";
    if (builds.length && builds.every((b) => b.buildId && statuses[b.buildId]?.releaseVerification?.status === "verified"))
      return "Release verified: the deployed game source, service worker, and What's New page agree.";
    return "Game build is running or published. Waiting for live site and What's New verification.";
  }

  function clearResult() {
    if (poll) clearInterval(poll);
    poll = null;
    result = null;
    error = null;
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
        Rebuilds the <b>Demo</b> from develop's current commit and deploys it. One build
        for everyone — the dev surface is unlocked by a <code>?debug</code> token, not by a
        separate download. It goes live once its boot-smoke passes.{#if liveVersion} Prod is
        currently on <code>{liveVersion}</code>.{/if}
      </p>

      {#if !result}
        {#if !confirming}
          <button class="btn danger" onclick={() => (confirming = true)} disabled={submitting}>
            Promote develop → public Demo
          </button>
        {:else}
          <div class="confirm">
            <p><b>Confirm:</b> promote develop's current commit to the <b>public Demo</b>?
              This ships to the live demo{#if liveVersion}, replacing
              <code>{liveVersion}</code>{/if}.</p>
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
            {#if resolvedSha}<span class="sub">({resolvedSha.slice(0, 8)})</span>{/if}</p>
          <ul class="builds">
            {#each result.builds as b (b.channel)}
              {@const bd = badge(b)}
              <li>
                <span class="ch">{b.label}</span>
                <span class="st {bd.cls}">{bd.label}</span>
                {#if b.buildId && statuses[b.buildId]?.phase}<span class="phase">{statuses[b.buildId].phase}</span>{/if}
                {#if b.buildId}
                  <a class="build-log" href={`https://us-east-1.console.aws.amazon.com/codesuite/codebuild/projects/${encodeURIComponent(b.buildId.split(":")[0])}/build/${encodeURIComponent(b.buildId)}/?region=us-east-1`} target="_blank" rel="noreferrer">Build logs</a>
                {/if}
                {#if b.error}<span class="berr">{b.error}</span>{/if}
                {#if b.buildId && statuses[b.buildId]?.releaseVerification?.pending.length}
                  <span class="pending-detail">Waiting on: {statuses[b.buildId].releaseVerification?.pending.join(", ")}</span>
                {/if}
              </li>
            {/each}
          </ul>
          <p class="finalize-note">{resultMessage()}</p>
          {#if statusError}<p class="berr">Status check error: {statusError}</p>{/if}
          {#if verificationTimedOut || verificationUnavailable}
            <p class="note">Run <code>npm run verify:release</code> from the web repository for a fresh browser smoke and a saved JSON report.</p>
          {/if}
          <button class="btn" onclick={clearResult}>Done</button>
        </div>
      {/if}

      {#if error}<p class="err">Couldn’t promote: {error}</p>{/if}

      <p class="note">
        develop stays the debug test lane; this doesn’t touch it. The build boot-smoke-gates —
        one that doesn’t boot never reaches the channel. A single lane
        (<code>allbyte-godot-alpha</code>) is deployed; “Waiting on build project” would mean
        it had gone missing. The old <code>alpha-debug</code> lane was retired 2026-09-10: it
        only advanced when someone remembered to promote it, so it drifted ~50 builds behind
        prod while every scenario jump loaded it.
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
  code { background: var(--paperblend); padding: 0 0.35rem; border-radius: 3px; color: var(--crimson); }
  .btn {
    background: transparent; color: var(--crimson); border: 1px solid var(--rule);
    border-radius: 5px; padding: 0.5rem 0.9rem; font-family: inherit; font-size: 0.88rem; cursor: pointer;
  }
  .btn:hover:not(:disabled) { background: var(--paperblend); }
  .btn:disabled { opacity: 0.5; cursor: default; }
  .btn.danger { color: var(--sem-danger); border-color: var(--sem-danger); }
  .btn.danger:hover:not(:disabled) { background: rgba(248, 113, 113, 0.12); }
  .confirm { background: rgba(248, 113, 113, 0.08); border: 1px solid rgba(248, 113, 113, 0.35); border-radius: 6px; padding: 0.85rem 1rem; }
  .confirm p { margin: 0 0 0.8rem; font-size: 0.88rem; line-height: 1.5; }
  .row { display: flex; gap: 0.6rem; }
  .result .muted { margin: 0 0 0.7rem; }
  .builds { list-style: none; padding: 0; margin: 0 0 1rem; display: flex; flex-direction: column; gap: 0.5rem; }
  .builds li { display: flex; align-items: center; gap: 0.7rem; font-size: 0.85rem; }
  .ch { min-width: 8rem; color: var(--ink); }
  .st { padding: 0.12rem 0.5rem; border-radius: 4px; font-size: 0.76rem; border: 1px solid transparent; }
  .st.run { color: var(--sem-warn); background: rgba(251, 191, 36, 0.12); border-color: var(--sem-warn); }
  .st.ok { color: var(--crimson); background: var(--panel); border-color: var(--panel); }
  .st.err { color: var(--sem-danger); background: rgba(248, 113, 113, 0.12); border-color: var(--sem-danger); }
  .st.wait { color: var(--ink-soft); background: rgba(255, 255, 255, 0.05); border-color: rgba(255, 255, 255, 0.12); }
  .berr { color: var(--sem-danger); font-size: 0.74rem; }
  .pending-detail { color: var(--sem-warn); font-size: 0.74rem; }
  .phase { color: var(--ink-soft); font-size: 0.72rem; }
  .build-log { color: var(--ink-soft); font-size: 0.72rem; }
  .finalize-note {
    margin: 0.7rem 0 0;
    padding: 0.55rem 0.7rem;
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--sem-warn);
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
  .err { color: var(--sem-danger); font-size: 0.85rem; margin-top: 0.6rem; }
  .note { color: var(--ink-soft); font-size: 0.74rem; line-height: 1.55; margin-top: 1.1rem; }
</style>
