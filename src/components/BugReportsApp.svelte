<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { BUG_READ_URL as READ_URL } from "../lib/bugReports";
  import { onMount } from "svelte";

  interface Report {
    reportId: string;
    ts?: number;
    createdAt?: string;
    text: string;
    category?: string;
    status?: string;
    recentLogs?: string[];
    meta?: Record<string, any>;
    snapshotKey?: string;
    snapshotUrl?: string;
    userId?: string;
    email?: string;
    tier?: string;
  }

  let loading = $state(true);
  let error = $state<string | null>(null);
  let reports = $state<Report[]>([]);
  let generatedAt = $state<number | null>(null);
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
      const data = await res.json();
      reports = (data.reports ?? []) as Report[];
      generatedAt = data.generatedAt ?? null;
    } catch (err: any) {
      error = err?.message ?? String(err);
    } finally {
      loading = false;
    }
  }

  function fmtDate(iso?: string, ts?: number): string {
    const d = iso ? new Date(iso) : ts ? new Date(ts * 1000) : null;
    return d && !isNaN(d.getTime()) ? d.toLocaleString() : "—";
  }

  function who(r: Report): string {
    if (r.email) return `${r.email}${r.tier ? ` · ${r.tier}` : ""}`;
    if (r.userId) return `user ${r.userId.slice(0, 8)}`;
    return "anonymous";
  }

  // Coarse "OS Browser" from the UA — same idea as playAnalytics, just for display.
  function shortUA(ua?: string): string {
    if (!ua) return "";
    const s = ua.toLowerCase();
    let os = "Other";
    if (/iphone|ipad|ipod/.test(s)) os = "iOS";
    else if (s.includes("android")) os = "Android";
    else if (s.includes("windows")) os = "Windows";
    else if (s.includes("mac os") || s.includes("macintosh")) os = "macOS";
    else if (s.includes("linux")) os = "Linux";
    let br = "Other";
    if (s.includes("edg")) br = "Edge";
    else if (s.includes("firefox") || s.includes("fxios")) br = "Firefox";
    else if (s.includes("crios") || s.includes("chrome")) br = "Chrome";
    else if (s.includes("safari")) br = "Safari";
    return `${os} ${br}`;
  }
</script>

<div class="reports">
  {#if loading}
    <p class="muted">Loading reports…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only. Sign in with the owner account to view bug reports.</p>
  {:else if error}
    <p class="err">Couldn’t load reports: {error}</p>
    <button class="btn" onclick={load}>Retry</button>
  {:else if reports.length === 0}
    <p class="muted">
      No bug reports yet. They appear here as players submit them in-game
      (<code>Options → Report a Bug</code> on <code>/play/</code>).
    </p>
    <button class="btn" onclick={load}>Refresh</button>
  {:else}
    <div class="head">
      <span class="muted">
        {reports.length} report{reports.length === 1 ? "" : "s"} · newest first ·
        updated {fmtDate(undefined, generatedAt ?? undefined)}
      </span>
      <button class="btn" onclick={load}>Refresh</button>
    </div>

    {#each reports as r (r.reportId)}
      <article class="rpt">
        <header class="rpt-head">
          <span class="cat">{r.category ?? "other"}</span>
          <span class="status status-{r.status ?? 'new'}">{r.status ?? "new"}</span>
          <span class="when">{fmtDate(r.createdAt, r.ts)}</span>
          <span class="who">{who(r)}</span>
          {#if r.meta?.channel}
            <span class="chip">
              {r.meta.channel}{r.meta?.gameVersion ? ` · ${r.meta.gameVersion}` : ""}
            </span>
          {/if}
        </header>

        <p class="rpt-text">{r.text}</p>

        <div class="rpt-meta">
          {#if r.meta?.scene}<span>scene <b>{r.meta.scene}</b></span>{/if}
          {#if r.meta?.viewport}<span>{r.meta.viewport}</span>{/if}
          {#if r.meta?.userAgent}<span title={r.meta.userAgent}>{shortUA(r.meta.userAgent)}</span>{/if}
          {#if r.meta?.url}<span class="url" title={r.meta.url}>{r.meta.url}</span>{/if}
        </div>

        <div class="rpt-actions">
          {#if r.snapshotUrl}
            <a class="btn snap" href={r.snapshotUrl} target="_blank" rel="noopener">⤓ save snapshot</a>
          {:else if r.snapshotKey}
            <span class="muted small">snapshot on file (link expired — refresh)</span>
          {/if}
          {#if r.recentLogs && r.recentLogs.length}
            <details class="logs">
              <summary>{r.recentLogs.length} log line{r.recentLogs.length === 1 ? "" : "s"}</summary>
              <pre>{r.recentLogs.join("\n")}</pre>
            </details>
          {/if}
        </div>
      </article>
    {/each}
  {/if}
</div>

<style>
  .reports {
    background: var(--panel);
    color: var(--ink);
    font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif;
    padding: 1.25rem;
    max-width: 1000px;
    margin: 0 auto;
  }
  .muted { color: var(--ink-soft); }
  .muted.small { font-size: 0.75rem; }
  .err { color: var(--sem-danger); }
  code { background: var(--paperblend); padding: 0 0.3rem; border-radius: 3px; }
  .head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; gap: 1rem; flex-wrap: wrap; }
  .btn {
    background: transparent; color: var(--crimson); border: 1px solid var(--rule);
    border-radius: 4px; padding: 0.3rem 0.7rem; font-family: inherit; cursor: pointer;
    text-decoration: none; display: inline-block; font-size: 0.8rem;
  }
  .btn:hover { background: var(--paperblend); }

  .rpt {
    background: #131a26; border: 1px solid var(--rule);
    border-radius: 6px; padding: 0.85rem 1rem; margin-bottom: 0.85rem;
  }
  .rpt-head {
    display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap;
    font-size: 0.76rem; color: var(--ink-soft); margin-bottom: 0.5rem;
  }
  .cat {
    text-transform: uppercase; letter-spacing: 0.04em; font-weight: 700;
    color: var(--sem-warn); background: rgba(251, 191, 36, 0.12);
    border: 1px solid rgba(251, 191, 36, 0.3); border-radius: 3px; padding: 0.05rem 0.4rem;
  }
  .status {
    border-radius: 3px; padding: 0.05rem 0.4rem; border: 1px solid var(--rule);
  }
  .status-new { color: var(--crimson); background: var(--paperblend); }
  .when { color: var(--ink-soft); }
  .who { color: var(--sem-info); }
  .chip {
    margin-left: auto; color: #c084fc; background: rgba(192, 132, 252, 0.1);
    border: 1px solid rgba(192, 132, 252, 0.25); border-radius: 3px; padding: 0.05rem 0.4rem;
  }
  .rpt-text {
    white-space: pre-wrap; word-break: break-word; margin: 0 0 0.6rem;
    font-family: system-ui, sans-serif; font-size: 0.95rem; line-height: 1.5; color: var(--ink);
  }
  .rpt-meta {
    display: flex; flex-wrap: wrap; gap: 0.4rem 1rem;
    font-size: 0.74rem; color: var(--ink-soft); margin-bottom: 0.5rem;
  }
  .rpt-meta b { color: var(--crimson); font-weight: 700; }
  .rpt-meta .url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 100%; }
  .rpt-actions { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
  .snap { font-size: 0.76rem; }
  .logs { font-size: 0.76rem; color: var(--ink-soft); }
  .logs summary { cursor: pointer; color: var(--crimson); }
  .logs pre {
    margin: 0.4rem 0 0; padding: 0.6rem; background: var(--panel);
    border: 1px solid var(--rule); border-radius: 4px;
    overflow-x: auto; max-height: 240px; font-size: 0.72rem; line-height: 1.45;
  }
</style>
