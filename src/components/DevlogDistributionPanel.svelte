<script lang="ts">
  // Devlog + feature distribution planner for the marketing console.
  //
  // Split by design (see src/lib/marketingDistribution.ts for the full why):
  //   PUBLIC  — the post list + `audience` frontmatter, passed in as props.
  //             Already in the public repo, so serializing it changes nothing.
  //   PRIVATE — venues / cadence / research / calendar / posted log, fetched at
  //             RUNTIME from an admin-gated endpoint. Never build-time imported,
  //             so it never lands in dist/ or on the public CDN.
  //
  // This replaced an .astro version that read the private file at build time and
  // guarded on import.meta.env.DEV. That was safe but dev-only — it could never
  // show on the live site, which is what the owner actually wanted.
  import { onMount } from "svelte";
  import { auth } from "../lib/auth.svelte";
  import { isAdmin } from "../lib/tier";
  import {
    fetchDistribution,
    type Audience,
    type DistributionState,
    type Venue,
  } from "../lib/marketingDistribution";

  interface PostMeta {
    slug: string;
    title: string;
    audience: Audience;
    draft: boolean;
    pubDate: string;
    /** AI terms found in an AI-free audience. Computed at build time (needs the
     *  post body, which we deliberately do NOT ship to the client). */
    aiLeak: boolean;
  }

  let { posts = [] as PostMeta[] } = $props();

  let state = $state<DistributionState | null>(null);

  // manifesto last — it is a held bucket, not part of the active rotation.
  const CHANNEL_ORDER: Audience[] = ["players", "gamedev", "ai-dev", "manifesto"];
  const AUD_LABEL: Record<Audience, string> = {
    players: "Play My Game",
    gamedev: "Game Dev",
    "ai-dev": "AI Dev",
    manifesto: "Manifesto (held)",
    general: "General",
  };
  const TIMING_ORDER: Record<string, number> = { shipped: 0, "this-week": 1, soon: 2 };

  // Admin-only surface. In dev, initAuth() auto-mints an admin user, so this is
  // transparent locally; in prod it hides the panel from non-admins. The real
  // gate is server-side — this only avoids rendering a useless shell.
  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  onMount(() => {
    const ac = new AbortController();
    // Wait for initAuth() to settle so the token exists before the first fetch.
    const start = () => fetchDistribution(ac.signal).then((s) => (state = s));
    if (auth.authReady) start();
    else {
      const t = setInterval(() => {
        if (auth.authReady) {
          clearInterval(t);
          start();
        }
      }, 60);
      return () => {
        clearInterval(t);
        ac.abort();
      };
    }
    return () => ac.abort();
  });

  let dist = $derived(state?.status === "ok" ? state.data : null);
  let channels = $derived(dist?.channels ?? {});
  let venuesOf = $derived(
    (aud: Audience): Venue[] => (dist?.venues?.[aud] ?? []) as Venue[]
  );

  let joined = $derived(
    dist
      ? posts.map((p) => {
          const log = dist.posted?.[p.slug] ?? [];
          const postedIds = new Set(log.map((l) => l.venue));
          const venues = venuesOf(p.audience);
          return {
            ...p,
            venues: venues.map((v) => ({ ...v, done: postedIds.has(v.id) })),
            postedCount: venues.filter((v) => postedIds.has(v.id)).length,
            venueCount: venues.length,
          };
        })
      : []
  );

  let calSorted = $derived(
    [...(dist?.calendar ?? [])].sort(
      (a, b) => (TIMING_ORDER[a.timing] ?? 9) - (TIMING_ORDER[b.timing] ?? 9)
    )
  );

  let liveCount = $derived(joined.filter((p) => !p.draft).length);
  let draftCount = $derived(joined.filter((p) => p.draft).length);
  let leakCount = $derived(joined.filter((p) => p.aiLeak).length);
  const byChannel = (aud: Audience) => joined.filter((p) => p.audience === aud);
</script>

{#if viewerIsAdmin}
  <section class="ddp">
    <header class="ddp-head">
      <h2>
        Devlog &amp; Feature Distribution
        <span class="priv">private · admin-only</span>
      </h2>
      <p class="ddp-sub">
        Where each devlog goes, what game-feature beats are queued, and what's still
        un-posted. Audience tags live in each post's <code>audience</code> frontmatter;
        the venue/cadence/calendar strategy is fetched at runtime and never ships in the
        build.
      </p>
      {#if dist}
        <div class="ddp-stats">
          <span>{liveCount} live</span><span>{draftCount} draft</span>
          {#if leakCount > 0}<span class="warn">⚠ {leakCount} AI-leak</span>{/if}
        </div>
      {/if}
    </header>

    {#if state === null}
      <p class="ddp-msg">Loading strategy…</p>
    {:else if state.status === "absent"}
      <p class="ddp-msg">
        No strategy data. Expected <code>private/marketing/devlog-distribution.json</code>
        (gitignored) in dev, or the uploaded object in prod — run
        <code>npm run push-marketing-strategy</code>.
      </p>
    {:else if state.status === "unauthorized"}
      <p class="ddp-msg">Admin sign-in required to load the distribution strategy.</p>
    {:else if state.status === "error"}
      <p class="ddp-msg err">Couldn't load strategy — {state.detail}</p>
    {:else}
      <div class="ddp-timeline">
        {#each CHANNEL_ORDER as aud}
          {@const c = channels[aud]}
          <article class="tl tl-{aud}">
            <h3>
              {c?.label ?? AUD_LABEL[aud]}
              <span class="posture">{c?.aiPosture}</span>
            </h3>
            <p class="tl-blurb">{c?.viewpoint}</p>
            <dl>
              <div><dt>Approach</dt><dd>{c?.approach}</dd></div>
              <div><dt>Cadence</dt><dd>{c?.cadence}</dd></div>
              <div><dt>Timeline</dt><dd>{c?.timeline}</dd></div>
              <div><dt>Best days</dt><dd>{c?.bestDays}</dd></div>
            </dl>
          </article>
        {/each}
      </div>

      {#if calSorted.length > 0}
        <div class="ddp-cal">
          <h3 class="group-title">
            Feature &amp; devlog beats <span class="count">{calSorted.length}</span>
          </h3>
          <ul class="cal-list">
            {#each calSorted as b}
              <li class="cal-row">
                <span class="t-badge t-{b.timing}">{b.timing}</span>
                <span class="aud-badge aud-{b.audience}">{AUD_LABEL[b.audience] ?? b.audience}</span>
                <span class="cal-what"
                  >{b.what}{#if b.note}<em class="cal-note"> — {b.note}</em>{/if}</span
                >
                <span class="cap cap-{b.capture}">
                  {b.capture === "ready"
                    ? "✓ master"
                    : b.capture === "free"
                      ? "◐ free clip"
                      : b.capture === "needed"
                        ? "○ needs clip"
                        : "— text"}
                </span>
              </li>
            {/each}
          </ul>
        </div>
      {/if}

      {#each CHANNEL_ORDER as aud}
        {@const list = byChannel(aud)}
        {#if list.length > 0}
          <div class="ddp-group">
            <h3 class="group-title">
              {AUD_LABEL[aud]} posts <span class="count">{list.length}</span>
            </h3>
            <ul class="post-list">
              {#each list as p}
                <li class="post-row" class:is-draft={p.draft} class:is-leak={p.aiLeak}>
                  <div class="pr-main">
                    <span class="pr-title">{p.title}</span>
                    {#if p.draft}<span class="badge draft">draft</span>{/if}
                    {#if p.aiLeak}<span
                        class="badge leak"
                        title="AI terms found in an AI-free audience — scrub or re-tag before syndicating"
                        >⚠ AI terms</span
                      >{/if}
                  </div>
                  <div class="pr-venues">
                    {#if p.draft}
                      <span class="muted">publish first</span>
                    {:else}
                      {#each p.venues as v}
                        <a
                          class="chip"
                          class:done={v.done}
                          href={v.url}
                          target="_blank"
                          rel="noopener"
                          title={v.note}>{v.done ? "✓ " : ""}{v.id}</a
                        >
                      {/each}
                      {#if p.venueCount > 0}
                        <span class="pr-progress">{p.postedCount}/{p.venueCount}</span>
                      {/if}
                    {/if}
                  </div>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/each}
    {/if}
  </section>
{/if}

<style>
  .ddp { background: #0d1320; border: 1px solid rgba(167,243,208,0.14); border-radius: 8px; padding: 1.25rem 1.4rem 1.5rem; margin: 0 auto 1.5rem; max-width: 1100px; font-family: "Courier New", monospace; color: #cdd6e4; }
  .ddp-head h2 { margin: 0 0 0.35rem; color: #a7f3d0; font-size: 1.1rem; letter-spacing: 0.02em; }
  .priv { font-size: 0.62rem; color: #6f7c8d; background: rgba(148,163,184,0.12); padding: 0.1rem 0.45rem; border-radius: 999px; vertical-align: middle; }
  .ddp-sub { margin: 0 0 0.6rem; font-size: 0.78rem; line-height: 1.5; color: #8b97a8; }
  .ddp-sub code { color: #a7f3d0; background: rgba(167,243,208,0.08); padding: 0.05rem 0.3rem; border-radius: 3px; }
  .ddp-stats { display: flex; gap: 0.75rem; font-size: 0.75rem; color: #9aa6b6; }
  .ddp-stats .warn { color: #fbbf24; }
  .ddp-msg { font-size: 0.78rem; color: #8b97a8; margin: 0.5rem 0 0; line-height: 1.5; }
  .ddp-msg.err { color: #fbbf24; }
  .ddp-msg code { color: #a7f3d0; background: rgba(167,243,208,0.08); padding: 0.05rem 0.3rem; border-radius: 3px; }

  .ddp-timeline { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.75rem; margin: 1rem 0 1.4rem; }
  .tl { background: #111a2b; border: 1px solid rgba(255,255,255,0.06); border-top-width: 2px; border-radius: 6px; padding: 0.75rem 0.85rem; }
  .tl-players { border-top-color: #f0abfc; } .tl-gamedev { border-top-color: #7dd3fc; } .tl-ai-dev { border-top-color: #a7f3d0; }
  /* held bucket — muted on purpose so it does not read as active work */
  .tl-manifesto { border-top-color: #94a3b8; opacity: 0.72; }
  .tl h3 { margin: 0 0 0.3rem; font-size: 0.9rem; color: #e7ecf5; display: flex; flex-wrap: wrap; gap: 0.4rem; align-items: baseline; }
  .posture { font-size: 0.6rem; color: #93a0b1; font-weight: normal; }
  .tl-blurb { margin: 0 0 0.55rem; font-size: 0.74rem; line-height: 1.45; color: #93a0b1; }
  .tl dl { margin: 0; display: flex; flex-direction: column; gap: 0.4rem; }
  .tl dt { font-size: 0.62rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6f7c8d; }
  .tl dd { margin: 0.1rem 0 0; font-size: 0.72rem; line-height: 1.4; color: #c7d1de; }

  .ddp-cal { margin-bottom: 1.3rem; }
  .cal-list { list-style: none; margin: 0.4rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.3rem; }
  .cal-row { display: flex; align-items: baseline; gap: 0.5rem; flex-wrap: wrap; background: #0f1626; border: 1px solid rgba(255,255,255,0.05); border-radius: 5px; padding: 0.4rem 0.6rem; font-size: 0.76rem; }
  .cal-what { flex: 1; min-width: 12rem; color: #dbe3ee; overflow-wrap: anywhere; }
  .cal-note { color: #8b97a8; font-style: italic; }
  .t-badge, .aud-badge, .cap { font-size: 0.6rem; padding: 0.08rem 0.4rem; border-radius: 999px; flex: none; white-space: nowrap; }
  .t-shipped { background: rgba(110,231,183,0.15); color: #6ee7b7; } .t-this-week { background: rgba(251,191,36,0.15); color: #fbbf24; } .t-soon { background: rgba(148,163,184,0.15); color: #94a3b8; }
  .aud-manifesto { background: rgba(148,163,184,0.13); color: #94a3b8; }
  .aud-players { background: rgba(240,171,252,0.13); color: #f0abfc; } .aud-gamedev { background: rgba(125,211,252,0.13); color: #7dd3fc; } .aud-ai-dev { background: rgba(167,243,208,0.13); color: #a7f3d0; }
  .cap { color: #8b97a8; } .cap-ready { color: #6ee7b7; } .cap-free { color: #7dd3fc; } .cap-needed { color: #fbbf24; }

  .ddp-group { margin-bottom: 1.1rem; }
  .group-title { font-size: 0.82rem; color: #7dd3fc; margin: 0 0 0.45rem; letter-spacing: 0.03em; }
  .group-title .count { color: #6f7c8d; font-size: 0.72rem; }
  .post-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.35rem; }
  .post-row { display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; background: #0f1626; border: 1px solid rgba(255,255,255,0.05); border-radius: 5px; padding: 0.5rem 0.7rem; }
  .post-row.is-draft { opacity: 0.62; } .post-row.is-leak { border-color: rgba(251,191,36,0.5); }
  .pr-main { display: flex; align-items: center; gap: 0.5rem; min-width: 0; flex: 1; }
  .pr-title { font-size: 0.8rem; color: #e2e8f0; overflow-wrap: anywhere; }
  .badge { font-size: 0.62rem; padding: 0.08rem 0.4rem; border-radius: 999px; flex: none; }
  .badge.draft { background: rgba(148,163,184,0.15); color: #94a3b8; } .badge.leak { background: rgba(251,191,36,0.15); color: #fbbf24; }
  .pr-venues { display: flex; align-items: center; gap: 0.35rem; flex-wrap: wrap; }
  .chip { font-size: 0.68rem; text-decoration: none; padding: 0.1rem 0.45rem; border-radius: 4px; background: rgba(125,211,252,0.08); color: #7dd3fc; border: 1px solid rgba(125,211,252,0.2); }
  .chip.done { background: rgba(167,243,208,0.14); color: #6ee7b7; border-color: rgba(110,231,183,0.4); }
  .chip:hover { filter: brightness(1.25); }
  .pr-progress { font-size: 0.68rem; color: #6f7c8d; margin-left: 0.15rem; }
  .muted { font-size: 0.72rem; color: #6f7c8d; font-style: italic; }

  @media (max-width: 760px) { .ddp-timeline { grid-template-columns: 1fr; } .ddp { padding: 1rem; } }
</style>
