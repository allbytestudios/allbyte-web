// Shared tier enum + helpers for auth gating.
//
// Backend (MeFunction) returns tier as one of these strings. During the
// transition from the old `string | null` shape to this enum, isTierAtLeast
// accepts a nullish tier for backward compatibility — a null or unknown tier
// is treated as "default" (the lowest rank).

export type Tier = "default" | "initiate" | "hero" | "legend" | "admin";

export const TIER_ORDER: Tier[] = [
  "default",
  "initiate",
  "hero",
  "legend",
  "admin",
];

export function tierRank(t: Tier | string | null | undefined): number {
  if (!t) return 0;
  const idx = TIER_ORDER.indexOf(t as Tier);
  return idx >= 0 ? idx : 0;
}

export function isTierAtLeast(
  user: { tier?: Tier | string | null } | null | undefined,
  required: Tier
): boolean {
  if (!user) return false;
  return tierRank(user.tier) >= tierRank(required);
}

export function isAdmin(
  user: { tier?: Tier | string | null } | null | undefined
): boolean {
  return user?.tier === "admin";
}

export function tierLabel(t: Tier | string | null | undefined): string {
  if (!t || t === "default") return "Free";
  return t[0].toUpperCase() + t.slice(1);
}

export function tierColor(t: Tier | string | null | undefined): string {
  switch (t) {
    case "admin":
      return "#f472b6"; // magenta
    case "legend":
      return "#f97316"; // orange
    case "hero":
      return "#fbbf24"; // amber
    case "initiate":
      return "#a7f3d0"; // engine cyan
    case "default":
    default:
      return "#9ca3af"; // grey
  }
}
