<script lang="ts">
  import { auth } from "../lib/auth.svelte.ts";
  import { isAdmin } from "../lib/tier";
  import { onMount, onDestroy } from "svelte";
  import { listSessions, readSession, sendCommand, type LiveSession } from "../lib/devSession";

  // Watch panel for the dev-session bridge: the live state of the game the owner
  // is actually playing, as the agents see it. Read-only by default — the send
  // box below is inert until the game half's applier ships.
  // Design: Desktop/GameDev/APP_CLAUDE_DEV_SESSION_BRIDGE.md

  const POLL_MS = 2000;

  let loading = $state(true);
  let error = $state<string | null>(null);
  let sessions = $state<LiveSession[]>([]);
  let selectedId = $state<string | null>(null);
  let snapshot = $state<any>(null);
  let showRaw = $state(false);

  let cmdVerb = $state("");
  let cmdArgs = $state("{}");
  let cmdNote = $state<string | null>(null);

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));
  let timer: ReturnType<typeof setTimeout> | null = null;

  // The snapshot is Arc's _testGetCombatSnapshot, forwarded verbatim — the server
  // stores whatever the game sends. So render defensively: pull out what we can
  // recognise, and always offer the raw JSON rather than pretending to know a
  // schema that is still being built.
  let units = $derived(
    Array.isArray(snapshot?.state?.units) ? snapshot.state.units : [],
  );
  let scene = $derived(
    snapshot?.state?.scene ?? snapshot?.state?.gameState?.scene ?? null,
  );
  let stale = $derived(Number(snapshot?.staleSeconds ?? 0));

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
    await refreshSessions();
    loading = false;
    poll();
  });

  onDestroy(() => {
    if (timer) clearTimeout(timer);
    timer = null;
  });

  async function refreshSessions() {
    try {
      sessions = await listSessions();
      error = null;
      if (!selectedId && sessions.length) selectedId = sessions[0].sessionId;
      if (selectedId && !sessions.some((s) => s.sessionId === selectedId)) {
        selectedId = sessions.length ? sessions[0].sessionId : null;
        snapshot = null;
      }
    } catch (e: any) {
      error = String(e?.message || e);
    }
  }

  function poll() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(async () => {
      await tick();
      poll();
    }, POLL_MS);
  }

  // The session LIST is a table scan; the selected session's snapshot is a keyed
  // read. Polling both at 2s meant paying for a scan every beat to notice a new
  // tab — refresh the list every 5th beat instead. The live view stays at 2s.
  let listBeat = 0;

  async function tick() {
    if (!isAdmin(auth.currentUser)) return;
    try {
      if (selectedId) {
        snapshot = await readSession(selectedId);
        error = null;
      }
      if (listBeat++ % 5 === 0 || !selectedId) await refreshSessions();
    } catch (e: any) {
      error = String(e?.message || e);
    }
  }

  async function submitCommand(ev: Event) {
    ev.preventDefault();
    cmdNote = null;
    if (!selectedId || !cmdVerb.trim()) return;
    let args: Record<string, unknown>;
    try {
      args = JSON.parse(cmdArgs || "{}");
    } catch {
      cmdNote = "args must be valid JSON";
      return;
    }
    try {
      const out = await sendCommand(selectedId, cmdVerb.trim(), args);
      cmdNote = `queued as seq ${out.seq} — applies when the game half ships`;
      cmdVerb = "";
    } catch (e: any) {
      cmdNote = `failed: ${String(e?.message || e)}`;
    }
  }

  function ago(sec: number): string {
    if (!Number.isFinite(sec)) return "—";
    if (sec < 60) return `${Math.max(0, Math.round(sec))}s ago`;
    return `${Math.round(sec / 60)}m ago`;
  }
</script>

<div class="wrap">
  <header>
    <h1>Live session</h1>
    <p class="sub">
      The game as the agents see it. <code>/play/</code> registers a session when an admin
      loads it with the debug token; state streams up every 2 seconds.
    </p>
  </header>

  {#if loading}
    <p class="muted">Loading…</p>
  {:else if !viewerIsAdmin}
    <p class="muted">Admin only.</p>
  {:else}
    {#if error}
      <p class="err">{error}</p>
    {/if}

    {#if !sessions.length}
      <div class="empty">
        <p><strong>No live session.</strong></p>
        <p class="muted">
          Open <code>/play/</code> as an admin with the <code>?debug=</code> token. A session
          appears here once the game emits its first state snapshot — until Arc's
          <code>allbyte:state</code> emitter ships, that will not happen yet, and this panel
          staying empty is the expected result rather than a fault.
        </p>
      </div>
    {:else}
      <div class="sessions">
        {#each sessions as s (s.sessionId)}
          <button
            class="sess"
            class:active={s.sessionId === selectedId}
            onclick={() => { selectedId = s.sessionId; snapshot = null; tick(); }}
          >
            <span class="sid">{s.label || s.sessionId.slice(0, 8)}</span>
            <span class="meta">{s.channel || "—"} · {s.gameVersion || "—"}</span>
            <span class="meta">{ago(Number(s.staleSeconds ?? 0))}</span>
          </button>
        {/each}
      </div>

      {#if snapshot}
        <div class="bar" class:warn={stale > 10}>
          <span><b>Scene</b> {scene ?? "—"}</span>
          <span><b>Heartbeat</b> {ago(stale)}</span>
          <span><b>Commands</b> {snapshot.ackedSeq ?? 0}/{snapshot.cmdSeq ?? 0} acked</span>
        </div>

        {#if units.length}
          <table>
            <thead>
              <tr><th>Unit</th><th>HP</th><th>MP</th><th>Status</th><th>Mode</th></tr>
            </thead>
            <tbody>
              {#each units as u, i (u.id ?? u.name ?? i)}
                <tr>
                  <td>{u.name ?? u.id ?? "—"}</td>
                  <td>{u.hp ?? "—"}{u.hp_max ? ` / ${u.hp_max}` : ""}</td>
                  <td>{u.mp ?? "—"}{u.mp_max ? ` / ${u.mp_max}` : ""}</td>
                  <td>{Array.isArray(u.status) ? u.status.join(", ") || "—" : (u.status ?? "—")}</td>
                  <td>{u.current_mode ?? "—"}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {:else}
          <p class="muted">
            Session registered, no units in the snapshot yet — out of combat, or the emitter
            is sending a different shape. The raw view below is the truth.
          </p>
        {/if}

        {#if snapshot.lastResults?.length}
          <div class="results">
            <b>Last command results</b>
            <pre>{JSON.stringify(snapshot.lastResults, null, 2)}</pre>
          </div>
        {/if}

        <button class="link" onclick={() => (showRaw = !showRaw)}>
          {showRaw ? "Hide" : "Show"} raw snapshot
        </button>
        {#if showRaw}
          <pre class="raw">{JSON.stringify(snapshot.state, null, 2)}</pre>
        {/if}

        <form class="cmd" onsubmit={submitCommand}>
          <b>Send command</b>
          <p class="muted">
            Queues on the server now; the game applies it once the applier ships. Verb
            vocabulary is Arc's gamebridge set (<code>set_unit_stat</code>,
            <code>tune_skill</code>, <code>apply_status</code>, …).
          </p>
          <div class="row">
            <input placeholder="verb" bind:value={cmdVerb} />
            <input placeholder={'{"unit":"slime","stat":"atk","value":12}'} bind:value={cmdArgs} />
            <button type="submit" disabled={!cmdVerb.trim()}>Queue</button>
          </div>
          {#if cmdNote}<p class="note">{cmdNote}</p>{/if}
        </form>
      {:else}
        <p class="muted">Waiting for the first snapshot…</p>
      {/if}
    {/if}
  {/if}
</div>

<style>
  .wrap {
    padding: 1.5rem 1.75rem 3rem;
    color: var(--text, #d7dde5);
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    max-width: 1100px;
  }
  h1 { font-size: 1.15rem; margin: 0 0 0.25rem; letter-spacing: 0.02em; }
  .sub { margin: 0 0 1.25rem; opacity: 0.75; font-size: 0.85rem; max-width: 70ch; }
  .muted { opacity: 0.65; font-size: 0.85rem; }
  .err { color: #ff8f7a; font-size: 0.85rem; }
  .empty {
    border: 1px solid var(--line, #263041);
    border-radius: 6px;
    padding: 1rem 1.15rem;
    max-width: 70ch;
  }
  .empty p { margin: 0 0 0.5rem; }
  .sessions { display: flex; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
  .sess {
    display: flex; flex-direction: column; gap: 0.15rem;
    background: var(--panel-2, #141a22);
    border: 1px solid var(--line, #263041);
    border-radius: 6px;
    padding: 0.5rem 0.75rem;
    color: inherit; cursor: pointer; text-align: left;
    font-family: inherit; font-size: 0.8rem;
  }
  .sess.active { border-color: var(--accent, #a7f3d0); }
  .sid { font-weight: 700; }
  .meta { opacity: 0.6; font-size: 0.72rem; }
  .bar {
    display: flex; flex-wrap: wrap; gap: 1.25rem;
    border: 1px solid var(--line, #263041);
    border-left: 3px solid var(--accent, #a7f3d0);
    border-radius: 4px;
    padding: 0.55rem 0.85rem;
    font-size: 0.8rem;
    margin-bottom: 1rem;
  }
  .bar.warn { border-left-color: #ffb454; }
  .bar b { opacity: 0.6; font-weight: 500; margin-right: 0.3rem; }
  table { border-collapse: collapse; width: 100%; font-size: 0.8rem; margin-bottom: 1rem; }
  th, td { text-align: left; padding: 0.35rem 0.6rem; border-bottom: 1px solid var(--line, #263041); }
  th { opacity: 0.6; font-weight: 500; }
  pre {
    background: var(--panel-2, #141a22);
    border: 1px solid var(--line, #263041);
    border-radius: 4px;
    padding: 0.75rem;
    overflow-x: auto;
    font-size: 0.75rem;
    max-height: 24rem;
  }
  .results { margin-bottom: 1rem; font-size: 0.8rem; }
  .link {
    background: none; border: none; padding: 0; color: var(--accent, #a7f3d0);
    cursor: pointer; font-family: inherit; font-size: 0.8rem; text-decoration: underline;
  }
  .cmd { margin-top: 1.5rem; border-top: 1px solid var(--line, #263041); padding-top: 1rem; }
  .cmd .row { display: flex; gap: 0.5rem; flex-wrap: wrap; }
  .cmd input {
    background: var(--panel-2, #141a22);
    border: 1px solid var(--line, #263041);
    border-radius: 4px; color: inherit; padding: 0.4rem 0.6rem;
    font-family: inherit; font-size: 0.8rem;
  }
  .cmd input:first-child { width: 12rem; }
  .cmd input:nth-child(2) { flex: 1; min-width: 18rem; }
  .cmd button[type="submit"] {
    background: var(--accent, #a7f3d0); color: #0b0f14; border: none;
    border-radius: 4px; padding: 0.4rem 0.9rem; cursor: pointer;
    font-family: inherit; font-size: 0.8rem; font-weight: 700;
  }
  .cmd button[disabled] { opacity: 0.4; cursor: default; }
  .note { font-size: 0.78rem; opacity: 0.8; margin: 0.5rem 0 0; }
  code { font-size: 0.9em; opacity: 0.9; }
</style>
