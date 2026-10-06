// Which public URLs search engines should ignore.
//
// WHY ONE MODULE: two things have to agree about this, forever — the
// `<meta name="robots">` tag BaseLayout emits, and the sitemap's filter. If
// they drift, the site simultaneously tells Google "don't index this" and
// "here is a list of pages to index", which is the exact contradiction that
// makes crawl behaviour unpredictable. So both import this predicate rather
// than each keeping a list.
//
// Plain .mjs, not .ts, on purpose: astro.config.mjs imports it in a bare Node
// context (no TS pipeline) while .astro components import it through Vite.
// Keeping it dependency-free JS is what lets a single file serve both.
//
// NOT ACCESS CONTROL. noindex only asks a well-behaved crawler to skip a page
// that is still fully reachable by URL. Anything genuinely sensitive needs auth
// or must not be in the public deployment at all — see /test/ pages that gate
// on admin tier at runtime.

/** URL prefixes that stay reachable but must not appear in search results. */
export const NOINDEX_PREFIXES = [
  // Dev Console and everything beneath it: ticket tree, tests, decisions,
  // scenario launcher, play-funnel, marketing queue, dialogue editor, traffic,
  // bug reports, vignettes, cards — plus /test/session/ (the Live Session
  // view). All subscriber/admin-facing tooling, none of it a player surface.
  "/test/",
  // Admin user management.
  "/admin/",
  // The whole Development Journal, not just drafts (owner 2026-10-06).
  //
  // This overrides the original handoff, which kept finished posts indexable.
  // The decision is that devlog and Builder's Workshop material should be
  // "navigable but not directly/easily found" — reachable for anyone who goes
  // looking via the studio link, absent from search for everyone else. The
  // posts are engineering and process writing; a stranger searching for a
  // tactical RPG should meet the game, not an account of how it was built.
  //
  // Still fully public and still linked — this is about what SEARCH surfaces,
  // not about taking anything down.
  "/devlog/",
  // Long-form architecture + infrastructure-cost writeup. Same category as the
  // devlogs: studio/engineering material, deliberately not a player entry
  // point. (Linked from the README, which is where its audience arrives from.)
  "/self-hosting-with-claude/",
  // The changelog is currently a raw engineering feed (per-commit game build
  // notes). It stays public — the homepage hero links to it for "what's new" —
  // but it is not what a prospective player should meet in search results.
  // Revisit if it is ever replaced by a curated player-facing release-notes
  // page, at which point this entry should go.
  "/changelog/",
  // Legend-tier private post board: auth-gated, so indexing it would only ever
  // surface a login wall.
  "/legends_square/",
];

/**
 * Individual URLs that are reachable but are not DESTINATIONS — nothing a
 * search result should ever land a stranger on.
 *
 * Found while generating the first sitemap: route discovery is indiscriminate,
 * so the initial output advertised a redirect stub and three transactional
 * dead-ends as though they were content.
 */
export const NOINDEX_PATHS = [
  // Redirect stub only: Music folded into /artwork/#music on 2026-06-18. The
  // page is a meta-refresh whose canonical already points at /artwork/, so
  // listing it would ask Google to index a doorway to another page. It already
  // carries its own inline noindex — this entry is what keeps the SITEMAP
  // consistent with that, which is the half that was contradicting itself.
  "/music/",
  // Email-flow landing pages. They are the end of a one-time click from an
  // inbox, meaningless out of that context, and arriving at one from a search
  // result tells a visitor nothing about the game.
  "/notify-confirmed/",
  "/notify-error/",
  "/unsubscribed/",
];

/**
 * True when `pathname` should carry noindex and be absent from the sitemap.
 *
 * Draft devlog posts are NOT covered here — draft state lives in frontmatter,
 * not in the URL, so the devlog route passes `noindex` explicitly and the
 * sitemap filter scans frontmatter. See astro.config.mjs.
 */
export function isNoIndexPath(pathname) {
  if (!pathname) return false;
  // Normalise: the site runs trailingSlash:"always", but a sitemap entry or a
  // caller may hand us either form.
  const p = pathname.endsWith("/") ? pathname : `${pathname}/`;
  if (NOINDEX_PATHS.includes(p)) return true;
  return NOINDEX_PREFIXES.some((prefix) => p.startsWith(prefix));
}
