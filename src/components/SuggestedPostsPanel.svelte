<script lang="ts">
  // "What should I post next?" — the forward-looking half of the marketing console.
  //
  // The other panels are all backward-looking: MarketingHistoryPanel says what
  // went out, DevlogDistributionPanel says where each post still *could* go,
  // MarketingQueueApp holds clips. None of them rank. This one does.
  //
  // Same public/private split as DevlogDistributionPanel (see
  // src/lib/marketingDistribution.ts for the invariant):
  //   PUBLIC  — post metadata (title/audience/draft/pubDate/tags) passed in as
  //             props from the .astro page; already committed to the public repo.
  //   PUBLIC  — src/data/marketing-posts.json (channel staleness), also committed.
  //   PRIVATE — venues / calendar / posted log, fetched at RUNTIME from the
  //             admin-gated endpoint. Never build-time imported, so nothing from
  //             the strategy lands in dist/ or on the public CDN.
  import { onMount } from "svelte";
  import { auth } from "../lib/auth.svelte";
  import { isAdmin } from "../lib/tier";
  import marketingPosts from "../data/marketing-posts.json";
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
    tags: string[];
  }

  let { posts = [] as PostMeta[], limit = 7 } = $props();

  let state = $state<DistributionState | null>(null);

  const AUD_LABEL: Record<Audience, string> = {
    players: "Play My Game",
    gamedev: "Game Dev",
    "ai-dev": "AI Dev",
    manifesto: "Manifesto (held)",
    general: "General",
  };

  let viewerIsAdmin = $derived(isAdmin(auth.currentUser));

  onMount(() => {
    const ac = new AbortController();
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

  // ---------------------------------------------------------------- staleness
  type LoggedPost = { date: string; platform: string; source: string; subreddit?: string };
  const logged: LoggedPost[] = ((marketingPosts?.posts ?? []) as LoggedPost[]).filter(
    (p) => p?.date && p?.platform
  );

  const DAY_MS = 86_400_000;
  const todayMs = Math.floor(Date.now() / DAY_MS) * DAY_MS;
  const parse = (d: string) => Date.parse(`${d}T00:00:00Z`);
  const daysSince = (d: string) => Math.round((todayMs - parse(d)) / DAY_MS);
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

  /** A venue id is either a subreddit ("r/godot") or a standalone channel
   *  ("HackerNews", "itch-devlog"). Both resolve to a key we can look up in the
   *  public post log, which stores reddit as platform="reddit" + subreddit. */
  function venueKey(id: string): string {
    const m = /^r\/(.+)$/i.exec(id);
    return m ? `reddit:${norm(m[1])}` : `plat:${norm(id)}`;
  }
  function postKeys(p: LoggedPost): string[] {
    const k = [`plat:${norm(p.platform)}`];
    if (p.subreddit) k.push(`reddit:${norm(p.subreddit)}`);
    return k;
  }

  /** venueKey -> days since the last post there (null = never posted). */
  const lastPostByKey: Record<string, string> = (() => {
    const m: Record<string, string> = {};
    for (const p of logged)
      for (const k of postKeys(p)) if (!m[k] || p.date > m[k]) m[k] = p.date;
    return m;
  })();

  /** A never-touched venue is maximally starved, but capping it keeps the other
   *  signals (audience balance, capture readiness) from being drowned out. */
  const NEVER_DAYS = 90;
  const STALE_CAP = 60;
  function venueStale(id: string): { days: number; ever: boolean } {
    const last = lastPostByKey[venueKey(id)];
    return last ? { days: daysSince(last), ever: true } : { days: NEVER_DAYS, ever: false };
  }

  // ------------------------------------------------------- audience balance
  /** Which audience each venue belongs to, from the private strategy. */
  let venueAudience = $derived.by(() => {
    const m: Record<string, Audience> = {};
    for (const [aud, vs] of Object.entries(dist?.venues ?? {}))
      for (const v of (vs ?? []) as Venue[]) m[venueKey(v.id)] = aud as Audience;
    return m;
  });

  /** Recent posts attributable to an audience. Only venue-shaped posts (reddit
   *  subs, named channels) can be attributed; the broadcast channels
   *  (threads/bluesky/mastodon/discord/x) aren't audience-specific, so they're
   *  deliberately excluded rather than smeared across all three. */
  const BALANCE_WINDOW = 45;
  let audienceRecent = $derived.by(() => {
    const m: Record<string, number> = {};
    for (const p of logged) {
      if (daysSince(p.date) > BALANCE_WINDOW) continue;
      for (const k of postKeys(p)) {
        const aud = venueAudience[k];
        if (aud) m[aud] = (m[aud] ?? 0) + 1;
      }
    }
    return m;
  });
  const BALANCE_FULL = 3; // >=3 recent posts = that audience is well fed

  // ---------------------------------------------------- visual readiness
  const STOP = new Set(
    ("the a an and or of to in on for my me i with without is are was were it its this that " +
      "how why what when from into at by as be been but not no yes you your " +
      "can cant get got one two all use using whole day out own new about").split(" ")
  );
  /** Crude singularisation so "clouds" in a title matches "cloud shader" in a
   *  beat. Full stemming would be overkill for a dozen headlines. */
  const stem = (w: string) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);
  const words = (s: string) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, " ")
        .split(/[\s-]+/)
        .filter((w) => w.length > 2 && !STOP.has(w))
        .map(stem)
    );

  const CAPTURE_SCORE: Record<string, number> = {
    ready: 1,
    free: 0.7,
    text: 0.5,
    none: 0.5,
    unmatched: 0.45,
    needed: 0,
  };

  /** Domain words so common here they carry no matching signal — without this,
   *  "godot" + "pipeline" in a tag list matches almost any gamedev beat. */
  const GENERIC = new Set(
    "godot game games web browser pixel dev build post devlog claude agent agents ai pipeline studio".split(
      " "
    )
  );
  const distinctive = (s: string) => new Set([...words(s)].filter((w) => !GENERIC.has(w)));

  /** How many calendar beats mention each term — a term used by only one beat
   *  ("autoplay", "parallax") is a real signal; one used by several isn't. */
  let beatTermFreq = $derived.by(() => {
    const f: Record<string, number> = {};
    for (const b of dist?.calendar ?? [])
      for (const w of distinctive(b.what ?? "")) f[w] = (f[w] ?? 0) + 1;
    return f;
  });
  const isRare = (w: string, freq: Record<string, number>) => w.length >= 5 && (freq[w] ?? 0) <= 1;

  /** Best-matching calendar beat for a post: same audience, plus either one
   *  rare shared term or two ordinary ones. Deliberately precision-first — a
   *  wrong "capture ready" badge is worse than no badge, so most posts match
   *  nothing and are reported as text posts. */
  function matchBeat(p: PostMeta) {
    const freq = beatTermFreq;
    const pw = distinctive(`${p.title} ${p.tags.join(" ")}`);
    let best: { beat: any; score: number } | null = null;
    for (const b of dist?.calendar ?? []) {
      if (b.audience !== p.audience) continue;
      const shared = [...distinctive(b.what ?? "")].filter((w) => pw.has(w));
      const rare = shared.filter((w) => isRare(w, freq));
      if (rare.length === 0 && shared.length < 2) continue;
      const s = shared.length + 2 * rare.length;
      if (!best || s > best.score) best = { beat: b, score: s };
    }
    return best?.beat ?? null;
  }

  // ----------------------------------------------------------------- ranking
  // Weights. Staleness dominates by design (the owner's first question is
  // "which channel is starving"); recency of pubDate is a tiebreak ONLY —
  // the bar is specificity, not how recently the work happened.
  const W_STALE = 100;
  const W_BALANCE = 40;
  const W_CAPTURE = 25;
  const W_RECENCY = 5;
  const DOMINANCE_PENALTY = 15; // per already-picked post of the same audience

  let ranked = $derived.by(() => {
    if (!dist) return [];

    const live = posts.filter((p) => !p.draft && p.audience !== "manifesto");
    // pubDate rank -> 0..1, newest = 1. Rank, not raw age, so a big calendar gap
    // can't turn the tiebreak into a primary signal.
    const byDate = [...live].sort((a, b) => a.pubDate.localeCompare(b.pubDate));
    const dateRank: Record<string, number> = {};
    byDate.forEach((p, i) => (dateRank[p.slug] = byDate.length > 1 ? i / (byDate.length - 1) : 1));

    const scored = live
      .map((p) => {
        const postedIds = new Set((dist.posted?.[p.slug] ?? []).map((l) => l.venue));
        // A published devlog IS, by definition, on the own blog — every post here
        // is non-draft (see `live` above), so the own-blog venue is already
        // satisfied. Without this it reads as "never posted", maxing the
        // staleness score and floating blog-only (general) posts to the top.
        postedIds.add("own-blog");
        const all = (dist.venues?.[p.audience] ?? []) as Venue[];
        const open = all
          .filter((v) => !postedIds.has(v.id))
          .map((v) => ({ ...v, ...venueStale(v.id) }))
          .sort((a, b) => b.days - a.days);
        if (open.length === 0) return null;

        const top = open[0];
        const staleScore = Math.min(top.days, STALE_CAP) / STALE_CAP;
        const recent = audienceRecent[p.audience] ?? 0;
        const balanceScore = 1 - Math.min(recent, BALANCE_FULL) / BALANCE_FULL;
        const beat = matchBeat(p);
        // No matching beat = no queued visual for it. Treat as a text post
        // (shippable now) rather than claiming a capture exists.
        const capture: string = beat?.capture ?? "unmatched";
        const captureScore = CAPTURE_SCORE[capture] ?? 0.5;

        return {
          ...p,
          open,
          top,
          beat,
          capture,
          visualNeeded: capture === "needed",
          recentForAudience: recent,
          base:
            W_STALE * staleScore +
            W_BALANCE * balanceScore +
            W_CAPTURE * captureScore +
            W_RECENCY * (dateRank[p.slug] ?? 0),
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null);

    // Greedy pick with an audience-dominance penalty so one audience can't own
    // the whole list even when its venues are the stalest.
    const picked: any[] = [];
    const used: Record<string, number> = {};
    const pool = [...scored];
    while (picked.length < limit && pool.length > 0) {
      let bestI = 0;
      let bestS = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const s = pool[i].base - DOMINANCE_PENALTY * (used[pool[i].audience] ?? 0);
        if (s > bestS) {
          bestS = s;
          bestI = i;
        }
      }
      const p = pool.splice(bestI, 1)[0];
      used[p.audience] = (used[p.audience] ?? 0) + 1;
      picked.push({ ...p, score: Math.round(bestS), reasons: reasonsFor(p) });
    }
    return picked;
  });

  function reasonsFor(p: any): { text: string; kind: string }[] {
    const out: { text: string; kind: string }[] = [];
    if (!p.top.ever) out.push({ text: `never posted to ${p.top.id}`, kind: "stale" });
    else if (p.top.days >= 14)
      out.push({ text: `${p.top.id} not posted in ${p.top.days} days`, kind: "stale" });
    else out.push({ text: `${p.top.id} last hit ${p.top.days}d ago`, kind: "warm" });

    if (p.recentForAudience === 0)
      out.push({ text: `${AUD_LABEL[p.audience]} channel starved`, kind: "stale" });
    else if (p.recentForAudience < BALANCE_FULL)
      out.push({
        text: `only ${p.recentForAudience} ${AUD_LABEL[p.audience]} post${p.recentForAudience === 1 ? "" : "s"} in ${BALANCE_WINDOW}d`,
        kind: "warm",
      });

    if (p.capture === "ready") out.push({ text: "capture ready", kind: "good" });
    else if (p.capture === "free") out.push({ text: "free clip available", kind: "good" });
    else if (p.capture === "needed") out.push({ text: "needs a clip first", kind: "warn" });
    else if (p.capture === "unmatched")
      out.push({ text: "no capture beat — ships as text", kind: "warm" });
    else out.push({ text: "text post — no clip needed", kind: "good" });
    return out;
  }

  // -------------------------------------------------- stale-channel summary
  /** The other half of the decision: which channels are coldest right now.
   *  Union of the logged channels and every venue the strategy knows about. */
  let staleChannels = $derived.by(() => {
    const rows: { name: string; days: number; ever: boolean }[] = [];
    const seen = new Set<string>();
    for (const [aud, vs] of Object.entries(dist?.venues ?? {})) {
      if (aud === "manifesto") continue;
      for (const v of (vs ?? []) as Venue[]) {
        const k = venueKey(v.id);
        if (seen.has(k)) continue;
        seen.add(k);
        rows.push({ name: v.id, ...venueStale(v.id) });
      }
    }
    for (const p of logged) {
      const k = `plat:${norm(p.platform)}`;
      if (seen.has(k) || norm(p.platform) === "reddit") continue;
      seen.add(k);
      rows.push({ name: p.platform, days: daysSince(lastPostByKey[k]), ever: true });
    }
    return rows.sort((a, b) => b.days - a.days || a.name.localeCompare(b.name));
  });
</script>

{#if viewerIsAdmin}
  <section class="snp">
    <header class="snp-head">
      <h2>
        Suggested Next Posts
        <span class="priv">private · admin-only</span>
      </h2>
      <p class="snp-sub">
        Ranked answer to "what should I go post right now". Scored on channel staleness
        first, then audience balance, then whether a visual already exists — publish date
        is only a tiebreak. The bar is specificity, not recency: an older devlog about a
        concrete thing is a perfectly good post.
      </p>
    </header>

    {#if state === null}
      <p class="snp-msg">Loading strategy…</p>
    {:else if state.status === "absent"}
      <p class="snp-msg">
        No strategy data — can't rank without venues. Expected
        <code>private/marketing/devlog-distribution.json</code> (gitignored) in dev, or the
        uploaded object in prod.
      </p>
    {:else if state.status === "unauthorized"}
      <p class="snp-msg">Admin sign-in required to load the distribution strategy.</p>
    {:else if state.status === "error"}
      <p class="snp-msg err">Couldn't load strategy — {state.detail}</p>
    {:else if ranked.length === 0}
      <p class="snp-msg">
        Nothing to suggest — every live post has been sent to all of its venues.
      </p>
    {:else}
      <ol class="sug-list">
        {#each ranked as s, i}
          <li class="sug" class:needs-visual={s.visualNeeded}>
            <div class="sug-rank">{i + 1}</div>
            <div class="sug-body">
              <div class="sug-top">
                <a class="sug-title" href="/devlog/{s.slug}/">{s.title}</a>
                <span class="aud-badge aud-{s.audience}">{AUD_LABEL[s.audience]}</span>
                <span class="score" title="composite rank score">{s.score}</span>
              </div>
              <div class="sug-venues">
                <span class="lbl">post to</span>
                {#each s.open as v}
                  <a class="chip" href={v.url} target="_blank" rel="noopener" title={v.note}
                    >{v.id}<span class="chip-age">{v.ever ? `${v.days}d` : "never"}</span></a
                  >
                {/each}
              </div>
              <div class="sug-why">
                {#each s.reasons as r}
                  <span class="why why-{r.kind}">{r.text}</span>
                {/each}
                <span class="vis vis-{s.visualNeeded ? 'needed' : 'ok'}">
                  {s.visualNeeded ? "○ visual needed" : "✓ can ship today"}
                </span>
              </div>
            </div>
          </li>
        {/each}
      </ol>

      <div class="snp-block">
        <h3 class="block-title">
          Coldest channels <span class="block-sub">days since last post · the other half of the call</span>
        </h3>
        <ul class="chan-list">
          {#each staleChannels as c}
            <li class="chan" class:cold={!c.ever || c.days >= 14}>
              <span class="chan-name">{c.name}</span>
              <span class="chan-age">{c.ever ? `${c.days}d` : "never"}</span>
            </li>
          {/each}
        </ul>
      </div>
    {/if}
  </section>
{/if}

<style>
  .snp { background: #0d1320; border: 1px solid var(--rule); border-radius: 8px; padding: 1.25rem 1.4rem 1.5rem; margin: 0 auto 1.5rem; max-width: 1100px; font-family: "Iowan Old Style", "Palatino Linotype", Georgia, serif; color: #cdd6e4; }
  .snp-head h2 { margin: 0 0 0.35rem; color: var(--crimson); font-size: 1.1rem; letter-spacing: 0.02em; }
  .priv { font-size: 0.62rem; color: #6f7c8d; background: rgba(148,163,184,0.12); padding: 0.1rem 0.45rem; border-radius: 999px; vertical-align: middle; }
  .snp-sub { margin: 0 0 0.6rem; font-size: 0.78rem; line-height: 1.5; color: #8b97a8; }
  .snp-msg { font-size: 0.78rem; color: #8b97a8; margin: 0.5rem 0 0; line-height: 1.5; }
  .snp-msg.err { color: #fbbf24; }
  .snp-msg code, .snp-sub code { color: var(--crimson); background: var(--rule); padding: 0.05rem 0.3rem; border-radius: 3px; overflow-wrap: anywhere; }

  .sug-list { list-style: none; margin: 0.8rem 0 0; padding: 0; display: flex; flex-direction: column; gap: 0.45rem; }
  .sug { display: flex; gap: 0.7rem; background: #0f1626; border: 1px solid rgba(255,255,255,0.05); border-left: 2px solid var(--crimson); border-radius: 5px; padding: 0.55rem 0.7rem; }
  .sug.needs-visual { border-left-color: #fbbf24; }
  .sug-rank { font-size: 0.85rem; color: #6f7c8d; flex: none; width: 1.2rem; text-align: right; line-height: 1.4; }
  .sug-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 0.3rem; }
  .sug-top { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.45rem; }
  .sug-title { font-size: 0.82rem; color: #e2e8f0; text-decoration: none; overflow-wrap: anywhere; }
  .sug-title:hover { color: var(--crimson); }
  .score { font-size: 0.62rem; color: #6f7c8d; margin-left: auto; flex: none; }
  .aud-badge { font-size: 0.6rem; padding: 0.08rem 0.4rem; border-radius: 999px; flex: none; white-space: nowrap; }
  .aud-players { background: rgba(240,171,252,0.13); color: #f0abfc; }
  .aud-gamedev { background: rgba(125,211,252,0.13); color: #7dd3fc; }
  .aud-ai-dev { background: var(--rule); color: var(--crimson); }
  .aud-general { background: rgba(148,163,184,0.13); color: var(--ink-soft); }

  .sug-venues { display: flex; flex-wrap: wrap; align-items: center; gap: 0.3rem; }
  .lbl { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.06em; color: #6f7c8d; }
  .chip { font-size: 0.68rem; text-decoration: none; padding: 0.1rem 0.45rem; border-radius: 4px; background: rgba(125,211,252,0.08); color: #7dd3fc; border: 1px solid rgba(125,211,252,0.2); overflow-wrap: anywhere; }
  .chip:hover { filter: brightness(1.25); }
  .chip-age { color: #6f7c8d; margin-left: 0.3rem; font-size: 0.6rem; }

  .sug-why { display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .why, .vis { font-size: 0.63rem; padding: 0.08rem 0.4rem; border-radius: 999px; background: rgba(148,163,184,0.12); color: var(--ink-soft); overflow-wrap: anywhere; }
  .why-stale { background: rgba(251,146,60,0.14); color: #fdba74; }
  .why-warm { background: rgba(148,163,184,0.13); color: var(--ink-soft); }
  .why-good { background: rgba(110,231,183,0.13); color: var(--crimson); }
  .why-warn { background: rgba(251,191,36,0.14); color: #fbbf24; }
  .vis-ok { background: rgba(110,231,183,0.13); color: var(--crimson); }
  .vis-needed { background: rgba(251,191,36,0.14); color: #fbbf24; }

  .snp-block { margin-top: 1.3rem; }
  .block-title { font-size: 0.82rem; color: #7dd3fc; margin: 0 0 0.5rem; letter-spacing: 0.03em; }
  .block-sub { color: #6f7c8d; font-size: 0.7rem; font-weight: normal; letter-spacing: 0; }
  .chan-list { list-style: none; margin: 0; padding: 0; display: flex; flex-wrap: wrap; gap: 0.3rem; }
  .chan { display: inline-flex; align-items: baseline; gap: 0.4rem; background: #0f1626; border: 1px solid rgba(255,255,255,0.05); border-radius: 5px; padding: 0.25rem 0.5rem; font-size: 0.7rem; color: #cdd6e4; max-width: 100%; }
  .chan.cold { border-color: rgba(251,146,60,0.28); }
  .chan-name { overflow-wrap: anywhere; }
  .chan-age { color: #8b97a8; font-size: 0.63rem; }

  @media (max-width: 640px) {
    .snp { padding: 1rem 0.85rem 1.2rem; }
    .sug { gap: 0.45rem; padding: 0.5rem 0.55rem; }
    .score { margin-left: 0; }
  }
</style>
