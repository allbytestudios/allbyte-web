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
// The debug gate is client-side (low stakes — cheat/dev chrome only; server
// data is JWT-gated). This module only decides what the UI offers.

import { isAdmin, isTierAtLeast, type Tier } from "./tier";

type AuthUser = { tier?: Tier | string | null } | null | undefined;

/** Channel ids still in service. "alpha" = prod, "alpha-debug" = prod debug. */
export type ChannelId = "alpha" | "alpha-debug";

/**
 * The debug channel every hook-driven deep-link must target — scenario jumps and
 * save-tree jumps need TestBridge (`_testImportSave` et al), which the public
 * build doesn't expose. Was "develop" until that channel was retired
 * (2026-08-17); imported rather than re-typed so a future rename is one edit and
 * can't silently strand a jump link on the public build.
 */
export const DEBUG_CHANNEL_ID: ChannelId = "alpha-debug";

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
  // prod debug — same content, TestBridge hooks + debug HUD. This is the build
  // every scenario / save-tree jump targets (the hooks are what make the jump
  // work), so it must stay the one debug channel we keep. Sits on its own
  // isolated subdir with a least-priv deploy role (2026-07-14); available:false
  // because the pipeline publishes its availability at RUNTIME via channels.json.
  { id: "alpha-debug", label: "Episode One (Debug)", path: "/godot/alpha-debug/index.html", minTier: "legend",  available: false },
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
export function isAvailable(v: GameVersion, runtime?: RuntimeChannels): boolean {
  return v.available || !!(runtime && runtime[v.id]);
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
  const unlocked = GAME_VERSIONS.filter((v) => isAvailable(v, runtime) && isUnlocked(v, user));
  return unlocked.length ? unlocked[unlocked.length - 1] : GAME_VERSIONS[0];
}
