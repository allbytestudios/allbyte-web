<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount } from "svelte";

  // ReadEndpoint output of the play-analytics stack (allbyte-studio-play-analytics,
  // us-east-1). Admin-gated server-side: verifies the JWT email claim.
  const READ_URL = "https://pdtoj70foi.execute-api.us-east-1.amazonaws.com/funnel";

  interface Funnel {
    totalSessions: number;
    bootedSessions: number;
    movedSessions: number;
    bootedNoMove: number;
    sceneCounts: Record<string, number>;
    referrers: Record<string, number>;
    medianDurationSec: number;
    generatedAt: number;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let data = $state<Funnel | null>(null);

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  onMount(async () => {
    let waited = 0;
    while (!auth.authReady && waited < 5000) {
      await new Promise((r) => setTimeout(r, 100));
      waited += 100;
    }
    if (!isAdmin(auth.currentUser)) {
      loading = false;
      return;
    }
    await load();
  });

  async function load() {
    loading = true;
    error = null;
    try {
      const res = await fetch(READ_URL, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${auth.authToken}` },
      });
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
      data = (await res.json()) as Funnel;
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  function pct(a: number, b: number): number {
    return b > 0 ? Math.round((a / b) * 100) : 0;
  }

  function fmtDuration(s: number): string {
    if (!s) return "—";
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
  }

  // Split sceneCounts into location scenes vs "m:" milestones.
  let locations = $derived(
    data
      ? Object.entries(data.sceneCounts)
          .filter(([k]) => !k.startsWith("m:"))
          .sort((a, b) => b[1] - a[1])
      : []
  );
  let milestones = $derived(
    data
      ? Object.entries(data.sceneCounts)
          .filter(([k]) => k.startsWith("m:"))
          .sort((a, b) => b[1] - a[1])
      : []
  );
  let referrers = $derived(
    data ? Object.entries(data.referrers).sort((a, b) => b[1] - a[1]) : []
  );

  function milestoneLabel(k: string): string {
    if (k === "m:moved") return "First move";
    if (k === "m:combat") return "Reached combat";
    if (k.startsWith("m:event_")) return `Story event ${k.slice("m:event_".length)}`;
    return k.slice(2);
  }

</script>

<div class="funnel">
  {#if loading}
    <p class="muted">Loading funnel…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to view play analytics.</p>
  {:else if error}
    <p class="err">Couldn’t load funnel: {error}</p>
    <button class="btn" onclick={load}>Retry</button>
  {:else if !data || data.totalSessions === 0}
    <p class="muted">No play sessions recorded yet. Data appears here as people open <code>/play/</code>.</p>
    <button class="btn" onclick={load}>Refresh</button>
  {:else}
    <div class="head">
      <span class="muted">Anonymous, aggregate. Updated {new Date(data.generatedAt * 1000).toLocaleString()}</span>
      <button class="btn" onclick={load}>Refresh</button>
    </div>

    <!-- Top-line funnel: arrived -> booted -> moved -->
    <div class="cards">
      <div class="card">
        <div class="num">{data.totalSessions}</div>
        <div class="lbl">Arrived <span class="sub">opened /play/</span></div>
      </div>
      <div class="card">
        <div class="num">{data.bootedSessions}</div>
        <div class="lbl">Booted <span class="sub">{pct(data.bootedSessions, data.totalSessions)}% of arrivals</span></div>
      </div>
      <div class="card">
        <div class="num">{fmtDuration(data.medianDurationSec)}</div>
        <div class="lbl">Median session</div>
      </div>
    </div>

    <!-- "Moved"/"never moved" cards removed 2026-06-25: movedSessions is sampled
         from the transient gameState.isMoving at a 4s poll, so it under-counts
         badly (a player who walked 4 scenes still read as "never moved"). Scenes
         reached (below) is the trustworthy starting-engagement signal. -->

    <div class="cols">
      <!-- Location funnel -->
      <section>
        <h3>Scenes reached <span class="sub">(distinct sessions)</span></h3>
        {#if locations.length === 0}
          <p class="muted">No scenes reached yet.</p>
        {:else}
          {#each locations as [scene, n]}
            <div class="bar-row">
              <span class="bar-label">{scene}</span>
              <div class="bar"><div class="fill" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
        {/if}
      </section>

      <!-- Milestones -->
      <section>
        <h3>Milestones <span class="sub">(distinct sessions)</span></h3>
        {#if milestones.length === 0}
          <p class="muted">No milestones yet.</p>
        {:else}
          {#each milestones as [k, n]}
            <div class="bar-row">
              <span class="bar-label">{milestoneLabel(k)}</span>
              <div class="bar"><div class="fill alt" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
        {/if}
      </section>

      <!-- Referrers -->
      <section>
        <h3>Where they came from</h3>
        {#if referrers.length === 0}
          <p class="muted">No referrer data.</p>
        {:else}
          {#each referrers as [host, n]}
            <div class="bar-row">
              <span class="bar-label">{host}</span>
              <div class="bar"><div class="fill ref" style="width:{pct(n, data.totalSessions)}%"></div></div>
              <span class="bar-n">{n}</span>
            </div>
          {/each}
        {/if}
      </section>
    </div>
  {/if}
</div>

<style>
  .funnel {
    background: #0a0e17;
    color: #e0e7ff;
    font-family: "Courier New", monospace;
    padding: 1.25rem;
    max-width: 1100px;
    margin: 0 auto;
  }
  .muted { color: rgba(224, 231, 255, 0.55); }
  .err { color: #f87171; }
  .sub { color: rgba(224, 231, 255, 0.45); font-weight: normal; font-size: 0.78rem; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .btn {
    background: transparent; color: #a7f3d0; border: 1px solid rgba(167, 243, 208, 0.35);
    border-radius: 4px; padding: 0.3rem 0.7rem; font-family: inherit; cursor: pointer;
  }
  .btn:hover { background: rgba(167, 243, 208, 0.1); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 0.75rem; }
  .card {
    background: #131a26; border: 1px solid rgba(167, 243, 208, 0.12);
    border-radius: 6px; padding: 0.9rem 1rem;
  }
  .card.warn { border-color: rgba(248, 113, 113, 0.5); }
  .num { font-size: 1.7rem; font-weight: 700; color: #a7f3d0; }
  .card.warn .num { color: #f87171; }
  .lbl { font-size: 0.82rem; margin-top: 0.2rem; }
  .lbl .sub { display: block; }
  .signal {
    margin: 1rem 0 0; padding: 0.6rem 0.8rem; border-radius: 6px;
    background: rgba(248, 113, 113, 0.1); border: 1px solid rgba(248, 113, 113, 0.4);
    color: #fca5a5; font-size: 0.85rem;
  }
  .cols { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; margin-top: 1.5rem; }
  h3 { color: #a7f3d0; font-size: 1rem; margin: 0 0 0.6rem; font-weight: 700; }
  .bar-row { display: grid; grid-template-columns: 9rem 1fr 2.5rem; align-items: center; gap: 0.5rem; margin: 0.3rem 0; font-size: 0.8rem; }
  .bar-label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .bar { background: rgba(167, 243, 208, 0.08); border-radius: 3px; height: 14px; overflow: hidden; }
  .fill { height: 100%; background: #a7f3d0; }
  .fill.alt { background: #fbbf24; }
  .fill.ref { background: #60a5fa; }
  .bar-n { text-align: right; color: rgba(224, 231, 255, 0.7); }
  code { background: rgba(167, 243, 208, 0.1); padding: 0 0.3rem; border-radius: 3px; }
</style>
