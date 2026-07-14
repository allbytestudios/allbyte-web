// Tier-gated game versions (the "which build do I play" model).
//
// Two dimensions:
//   - content: Alpha (free) vs Beta+ (Initiate+, post-Alpha content)
//   - debug:   off (everyone at their content tier) vs on (Legend+ — TestBridge
//              hooks + debug HUD)
// → four builds, PLUS a fifth `develop` channel: the bleeding-edge develop-branch
// build (debug-only, Legend/admin), distinct from the *promoted* (staging) beta.
// Today only the Alpha pair exists (the game is pre-Alpha); the Beta pair and
// develop flip `available: true` once Arc/Port cut + deploy those exports.
// beta-debug + develop deploy via the fast lane (scripts/push-channel.js, driven
// by the game-side CI pipeline); alpha/beta go through the careful full deploy.
//
// IMPORTANT: the debug gate is client-side (low stakes — cheat/dev chrome only;
// server data is JWT-gated). The Beta+ gate is PAID CONTENT and must NOT rely on
// this alone — `/godot/*` is served openly on CloudFront, so a free user could
// load a Beta path directly. Beta builds need server-side gating (signed URLs /
// Lambda@Edge) before they go live. This module only decides what the UI offers.

import { isAdmin, isTierAtLeast, type Tier } from "./tier";

type AuthUser = { tier?: Tier | string | null } | null | undefined;

export interface GameVersion {
  id: "alpha" | "alpha-debug" | "beta" | "beta-debug" | "develop";
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
  { id: "alpha",       label: "Demo",            path: "/godot/public/index.html",     minTier: "default",  available: true },
  // Moving off the /godot/ root to a clean isolated subdir so it can be a proper
  // cloud channel with its own least-priv deploy role (2026-07-14). available:false
  // until the demo-debug CodeBuild project ships to the new path (pending Arc's
  // buildspec.web.yml); the one-click promote button will publish it at runtime.
  { id: "alpha-debug", label: "Demo (Debug)",    path: "/godot/alpha-debug/index.html", minTier: "legend",   available: false },
  { id: "beta",        label: "Beta",            path: "/godot/beta/index.html",       minTier: "initiate", available: false },
  { id: "beta-debug",  label: "Beta (Debug)",    path: "/godot/beta-debug/index.html", minTier: "legend",   available: false },
  { id: "develop",     label: "Develop (Debug)", path: "/godot/develop/index.html",    minTier: "legend",   available: false },
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
