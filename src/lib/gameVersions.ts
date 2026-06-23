// Tier-gated game versions (the "which build do I play" model).
//
// Two dimensions:
//   - content: Alpha (free) vs Beta+ (Initiate+, post-Alpha content)
//   - debug:   off (everyone at their content tier) vs on (Legend+ — TestBridge
//              hooks + debug HUD)
// → four builds. Today only the Alpha pair exists (the game is pre-Alpha); the
// Beta pair flips `available: true` once Arc/Port cut + deploy those exports.
//
// IMPORTANT: the debug gate is client-side (low stakes — cheat/dev chrome only;
// server data is JWT-gated). The Beta+ gate is PAID CONTENT and must NOT rely on
// this alone — `/godot/*` is served openly on CloudFront, so a free user could
// load a Beta path directly. Beta builds need server-side gating (signed URLs /
// Lambda@Edge) before they go live. This module only decides what the UI offers.

import { isAdmin, isTierAtLeast, type Tier } from "./tier";

type AuthUser = { tier?: Tier | string | null } | null | undefined;

export interface GameVersion {
  id: "alpha" | "alpha-debug" | "beta" | "beta-debug";
  label: string;
  /** iframe path for this build */
  path: string;
  /** minimum tier that unlocks it */
  minTier: Tier;
  /** whether the build artifact is deployed yet */
  available: boolean;
}

// Ordered least → richest, so "last unlocked" = the natural default.
export const GAME_VERSIONS: GameVersion[] = [
  { id: "alpha",       label: "Alpha",          path: "/godot/public/index.html",     minTier: "default",  available: true },
  { id: "alpha-debug", label: "Alpha · Debug",  path: "/godot/index.html",            minTier: "legend",   available: true },
  { id: "beta",        label: "Beta+",          path: "/godot/beta/index.html",       minTier: "initiate", available: false },
  { id: "beta-debug",  label: "Beta+ · Debug",  path: "/godot/beta-debug/index.html", minTier: "legend",   available: false },
];

export function isUnlocked(v: GameVersion, user: AuthUser): boolean {
  // "default" = free for everyone, including logged-out visitors.
  if (v.minTier === "default") return true;
  return isAdmin(user) || isTierAtLeast(user, v.minTier);
}

/** Deployed builds, for rendering the picker (locked ones shown disabled as upsell). */
export function pickerVersions(): GameVersion[] {
  return GAME_VERSIONS.filter((v) => v.available);
}

export function versionById(id: string): GameVersion | undefined {
  return GAME_VERSIONS.find((v) => v.id === id);
}

/** The richest deployed build the user can actually play (their default selection). */
export function defaultVersion(user: AuthUser): GameVersion {
  const unlocked = GAME_VERSIONS.filter((v) => v.available && isUnlocked(v, user));
  return unlocked.length ? unlocked[unlocked.length - 1] : GAME_VERSIONS[0];
}
