// Tier-gated game versions (the "which build do I play" model).
//
// The whole game is free (Episode One = the public Alpha build). The remaining
// dimension is debug: off (everyone) vs on (Legend/admin — TestBridge hooks +
// debug HUD). So the player-facing list is just Episode One, plus the
// debug/dev channels (alpha-debug, develop, staging) for Legend/admin. The
// Beta / Beta (Debug) content channels were retired 2026-08-04 (the game is
// free — no paid content tier of builds).
// alpha-debug + develop + staging deploy via the fast lane
// (scripts/push-channel.js, driven by the game-side CI pipeline); alpha goes
// through the careful full deploy.
//
// The debug gate is client-side (low stakes — cheat/dev chrome only; server
// data is JWT-gated). This module only decides what the UI offers.

import { isAdmin, isTierAtLeast, type Tier } from "./tier";

type AuthUser = { tier?: Tier | string | null } | null | undefined;

export interface GameVersion {
  id: "alpha" | "alpha-debug" | "develop" | "staging";
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
  { id: "alpha",       label: "Episode One",       path: "/godot/public/index.html",     minTier: "default",  available: true },
  // Moving off the /godot/ root to a clean isolated subdir so it can be a proper
  // cloud channel with its own least-priv deploy role (2026-07-14). available:false
  // until the demo-debug CodeBuild project ships to the new path (pending Arc's
  // buildspec.web.yml); the one-click promote button will publish it at runtime.
  { id: "alpha-debug", label: "Episode One (Debug)", path: "/godot/alpha-debug/index.html", minTier: "legend",   available: false },
  { id: "develop",     label: "Develop (Debug)", path: "/godot/develop/index.html",    minTier: "legend",   available: false },
  // Frozen tagged QA cut (0.8.x line) off origin/staging — Quinn re-baselines here.
  // Debug featureset (TestBridge hooks for her driver), Legend/admin-gated, runtime
  // availability via channels.json. Deploys via the fast lane ([deploy-staging]).
  { id: "staging",     label: "Staging (QA)",    path: "/godot/staging/index.html",    minTier: "legend",   available: false },
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
