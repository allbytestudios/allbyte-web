// Game versions (the "which build do I play" model).
//
// The owner and Arc work in exactly three places now (owner 2026-08-17):
//   local       — a local Godot export / `npm run dev`. NOT a deployed web
//                 channel, so it has no entry here.
//   prod        — the live public build everyone plays.  id "alpha"
//   prod debug  — same build with TestBridge hooks + debug HUD, Legend/admin.
//                 id "alpha-debug"
//
// The ids and S3 paths deliberately stay "alpha"/"alpha-debug": they're baked
// into channels.json keys, /godot/<channel>/ prefixes, the scoped CodeBuild
// deploy roles, sw.js and every existing ?v= link (the homepage PLAY button
// included). Renaming them is a coordinated cutover with Arc, not a relabel —
// so "prod"/"prod debug" is the vocabulary, "alpha"/"alpha-debug" is the wire
// format. `label` is player-facing copy, which is why prod reads "Episode One"
// rather than the internal channel name.
//
// Retired: develop + staging (owner 2026-08-17, branches simplified); Beta /
// Beta (Debug) content channels (2026-08-04, the game is free — no paid tier of
// builds). Anything still deep-linking a retired channel resolves to undefined
// in versionById() and safely falls back to the public build.
//
// THE DEBUG GATE IS NOW A CONTENT GATE (owner canon 2026-10-27, via Arc:
// CON_CLAUDE_APP_WEBSITE_DEBUG_GATED_SELECTOR.md). It used to unlock cheat/dev
// chrome only. It now also decides CONTENT SCOPE: the game's
// GlobalWorld.allows_episode_two() returns its `_debug_authorized`, so `debug`
// is what makes Episode Two / the Overworld reachable at all. Still client-side
// and still low stakes (server data is JWT-gated), but "debug" no longer means
// "developer chrome" — it means "this session sees Episode Two".
//
// AUTHORIZATION IS PRESENCE-BASED, NOT VALUE-BASED. The game computes
// `_debug_authorized` ONCE at boot from the `debug` query param OR a `debug`
// cookie, and ANY non-empty value counts — `debug=0` and `debug=false` both
// ENABLE it. There is no token comparison any more (the old shared-constant
// check is retired). Two consequences this module exists to encode:
//
//   1. Omitting the query is NOT the same as revoking access. A leftover
//      non-empty cookie silently keeps Episode Two unlocked, so ordinary
//      production has to actively CLEAR it — see clearDebugAuthorization().
//   2. Because it is read once at boot, a selection change cannot take effect
//      mid-session; the iframe has to be recreated.
//
// There is deliberately NO `?progress` parameter, no second export and no
// autoplay requirement. One artifact, one gate.

import { isAdmin, isTierAtLeast, type Tier } from "./tier";

type AuthUser = { tier?: Tier | string | null } | null | undefined;

/**
 * Channel ids still in service.
 *
 * REFINED MODEL (owner, 2026-10-27): there are exactly TWO artifacts — prod and
 * dev — and debug is an ORTHOGONAL modifier with a per-build default, not a
 * third channel. "alpha-debug" is therefore no longer a selection in its own
 * right; it survives only as a legacy wire id (scenario + save-tree deep-links,
 * channels.json keys) that resolves to the prod artifact with debug defaulted
 * ON, which is exactly what those links meant by it.
 */
export type ChannelId = "alpha" | "alpha-debug" | "dev";

/**
 * The debug channel every hook-driven deep-link must target — scenario jumps and
 * save-tree jumps need TestBridge (`_testImportSave` et al), which the public
 * build doesn't expose. Was "develop" until that channel was retired
 * (2026-08-17); imported rather than re-typed so a future rename is one edit and
 * can't silently strand a jump link on the public build.
 */
export const DEBUG_CHANNEL_ID: ChannelId = "alpha-debug";

/**
 * The stable "latest dev" pointer — the EXISTING `develop` channel path.
 *
 * Three routes were on the table and this is the only one that cannot drift:
 *
 *   /godot/dev/latest/   a new copy. Rejected: new machinery for something
 *                        that already exists.
 *   /godot/dev/<sha>/    resolve channels.json.develop.gitSha, then load the
 *                        immutable per-sha artifact. Reads well, but the two
 *                        halves are published by DIFFERENT scripts:
 *                        push-channel.js (what the [deploy-develop] CodeBuild
 *                        lane runs) writes /godot/develop/ and updates
 *                        channels.json — it does NOT write /godot/dev/<sha>/.
 *                        That path comes from publish-dev-build.js, a separate
 *                        invocation. So a CodeBuild develop deploy would move
 *                        the gitSha to a sha with no per-sha directory behind
 *                        it, and dev would 404.
 *   /godot/develop/      THIS. push-channel.js republishes it on every develop
 *                        build ("develop -> /godot/develop/, AUTO, every
 *                        build"), so it already is the auto-tracking pointer,
 *                        guaranteed by the same script that moves the channel
 *                        entry. No second publish to stay in step with.
 *
 * channels.json.develop still decides AVAILABILITY and reports the version;
 * it just isn't used to compute the path.
 *
 * `?build=<40-hex-sha>` still works and still wins — that pins one exact
 * artifact, strictly more specific than "latest".
 */
export const DEV_LATEST_PATH = "/godot/develop/index.html";

/**
 * The `debug` value currently in the address bar, if any.
 *
 * NOT a token any more — the game's shared-constant comparison is retired and
 * authorization is presence-based (see the header). This is read so an existing
 * deep-link (scenario jump, save-tree jump) keeps forwarding whatever value it
 * already carries, rather than having it rewritten underneath it.
 *
 * Never persisted here. Read from the URL and forwarded verbatim.
 */
export function currentDebugValue(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("debug");
}

/** What we send when the SELECTION (not the URL) is asking for debug scope. */
export const DEBUG_ENABLE_VALUE = "1";

/**
 * Cookie the game reads for debug authorization at boot. Cleared — never set —
 * by the wrapper: the game owns writing it, we only have to be able to revoke.
 */
const DEBUG_COOKIE = "debug";

/**
 * Paths the cookie may have been written at. A cookie is only deletable by a
 * request whose path matches the one it was set with, and the game runs at
 * /godot/public/ while this wrapper runs at /play/ — so clearing just "/" is
 * not enough to guarantee revocation. Clearing a path that was never used is a
 * harmless no-op, so the list is deliberately generous.
 */
const DEBUG_COOKIE_PATHS = ["/", "/godot", "/godot/", "/godot/public", "/godot/public/"];

/** True if a non-empty `debug` cookie is visible to this document. */
export function hasDebugCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .map((c) => c.trim())
    .some((c) => {
      const eq = c.indexOf("=");
      if (eq < 0) return false;
      return c.slice(0, eq) === DEBUG_COOKIE && c.slice(eq + 1).length > 0;
    });
}

/**
 * Actively REVOKE debug authorization before an ordinary-production boot.
 *
 * Omitting `?debug` is not revocation: authorization is presence-based, so a
 * `debug` cookie left behind by an earlier debug session silently keeps
 * Episode Two unlocked on what the player chose as plain production. This is
 * the one place that difference is handled, and it must run BEFORE the iframe
 * mounts — the game reads the cookie once, at boot.
 *
 * Same-origin throughout (the game is served from /godot/ on this origin), so
 * document.cookie reaches it. Expiry is set in the past AND max-age=0 because
 * some browsers honour only one of the two.
 */
export function clearDebugAuthorization(): void {
  if (typeof document === "undefined") return;
  const past = "Thu, 01 Jan 1970 00:00:00 GMT";
  for (const path of DEBUG_COOKIE_PATHS) {
    document.cookie = `${DEBUG_COOKIE}=; path=${path}; expires=${past}; max-age=0; SameSite=Lax`;
  }
  // Also without an explicit path, which targets the current document's path.
  document.cookie = `${DEBUG_COOKIE}=; expires=${past}; max-age=0; SameSite=Lax`;
}

// --- effective debug: a per-build DEFAULT, overridable either way ------------
//
// Refined model (owner 2026-10-27). Debug is orthogonal to the artifact:
//
//   prod  default OFF   — ?debug=1 turns it ON   (prod-with-debug)
//   dev   default ON    — ?debug=0 turns it OFF  (dev-without-debug)
//
// THE WRAPPER AND THE GAME READ `debug` IN OPPOSITE WAYS, AND THAT IS THE WHOLE
// POINT OF THIS FUNCTION. Out here, `?debug=0` is a deliberate OFF switch — the
// only way to express "dev without Episode Two". Inside the game, authorization
// is PRESENCE-based, so a forwarded `debug=0` would ENABLE exactly what the user
// just asked to turn off. So an OFF result must never be expressed by passing a
// value along: it is omit-the-query AND clear-the-cookie, identical to plain
// prod. The wrapper translates intent; it never relays this param verbatim.

/** Values that mean "explicitly off" to the WRAPPER (never sent to the game). */
const DEBUG_OFF_VALUES = new Set(["0", "false", "off", "no"]);

/** Per-build default: dev ships with Episode Two visible, prod does not. */
export function defaultDebugFor(id: string | null | undefined): boolean {
  return id === "dev" || id === DEBUG_CHANNEL_ID;
}

/**
 * Effective debug for a selection, after the per-build default and any URL
 * override. `null`/unknown selection falls back to the prod default (OFF).
 */
export function effectiveDebug(selectionId: string | null | undefined): boolean {
  const raw = currentDebugValue();
  if (raw !== null && raw !== "") {
    return !DEBUG_OFF_VALUES.has(raw.trim().toLowerCase());
  }
  return defaultDebugFor(selectionId);
}

export interface GameVersion {
  id: ChannelId;
  label: string;
  /** iframe path for this build */
  path: string;
  /** minimum tier that unlocks it */
  minTier: Tier;
  /** whether the build artifact is deployed yet */
  available: boolean;
}

// Ordered least → richest, so "last unlocked" = the natural default.
// Labels are DISPLAY text (dropdown); the ids/paths/deploy channels stay "alpha"
// etc. so the deploy pipeline + channels.json + ?v= links are unaffected.
export const GAME_VERSIONS: GameVersion[] = [
  // prod — what every visitor gets.
  { id: "alpha",       label: "Episode One",        path: "/godot/public/index.html",      minTier: "default", available: true },
  // prod debug — the SAME single deploy as prod. There is one build (0.8.2440+)
  // and the dev surface is unlocked by ?debug=<token> at call time, NOT by
  // loading a different artifact. So this id maps to the public path too: it
  // survives only as the wire-format marker that a link WANTS the debug surface
  // (scenario + save-tree jumps, the console log shipper), never as a separate
  // download.
  //
  // It pointed at /godot/alpha-debug/index.html until 2026-09-10, which quietly
  // undid the single-build design: every scenario and save-tree jump loaded a
  // separately-deployed artifact that only got promoted when someone remembered
  // to. It had drifted to 0.8.2592 while prod ran 0.8.2642 — ~50 builds of QA
  // against stale code. Owner: "1 deploy with param".
  { id: "alpha-debug", label: "Episode One (Debug)", path: "/godot/public/index.html", minTier: "legend",  available: false },
  // dev — the STABLE "latest dev" pointer (owner 2026-10-27). Deliberately not
  // a pinned ?build=<sha>: Arc publishes each develop build to this one path, so
  // "dev" always serves the newest without anyone re-pinning a sha per deploy.
  // Its artifact is separate from prod's; debug defaults ON here (see
  // defaultDebugFor), which is what makes Episode Two reachable by default.
  // The path is a LITERAL (not DEV_LATEST_PATH) on purpose: push-channel.js
  // regex-parses this table for channel -> S3 dest and only sees string literals.
  { id: "dev",         label: "Latest development",  path: "/godot/develop/index.html", minTier: "legend",  available: false },
];

export function isUnlocked(v: GameVersion, user: AuthUser): boolean {
  // "default" = free for everyone, including logged-out visitors.
  if (v.minTier === "default") return true;
  return isAdmin(user) || isTierAtLeast(user, v.minTier);
}

// Runtime availability overlay. `available: true` in the static table marks a
// build the full pipeline always deploys (alpha/alpha-debug). Everything else
// is published at RUNTIME by the deploy script into /godot/channels.json — the
// frontend fetches that and a channel is "available" if it's hardcoded true OR
// listed there. This is what keeps deploys fully agent-free: a push
// self-publishes its own availability, no source flip / commit / rebuild.
export type RuntimeChannels = Record<string, unknown> | null | undefined;

// "dev" is published under the channels.json key "develop" — push-channel.js
// and the [deploy-develop] CodeBuild lane own that key, so it is mapped here
// rather than renamed on the wire.
const RUNTIME_KEY: Partial<Record<ChannelId, string>> = { dev: "develop" };

export function isAvailable(v: GameVersion, runtime?: RuntimeChannels): boolean {
  return v.available || !!(runtime && runtime[RUNTIME_KEY[v.id] ?? v.id]);
}

/** Deployed builds, for rendering the picker (locked ones shown disabled as upsell). */
export function pickerVersions(runtime?: RuntimeChannels): GameVersion[] {
  return GAME_VERSIONS.filter((v) => isAvailable(v, runtime));
}

export function versionById(id: string): GameVersion | undefined {
  return GAME_VERSIONS.find((v) => v.id === id);
}

/** The richest deployed build the user can actually play (their default selection). */
export function defaultVersion(user: AuthUser, runtime?: RuntimeChannels): GameVersion {
  // dev is opt-in only (?v=dev / the picker): never let "richest unlocked" hand
  // a Legend patron the unstable latest-development build by default.
  const unlocked = GAME_VERSIONS.filter(
    (v) => v.id !== "dev" && isAvailable(v, runtime) && isUnlocked(v, user),
  );
  return unlocked.length ? unlocked[unlocked.length - 1] : GAME_VERSIONS[0];
}
