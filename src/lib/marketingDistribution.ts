// Marketing distribution strategy — the PRIVATE half of the devlog
// distribution panel.
//
// Invariant this module exists to enforce: the strategy content (venues,
// cadence, research, calendar, posted log) must never appear in the public
// GitHub repo OR in the static bundle on the public CDN. The site is static
// SSG behind CloudFront, and CloudFront objects are anonymously fetchable —
// verified: https://allbyte.studio/test-snapshot/*.json returns 200 with no
// auth. So a build-time import or a client-side tier check would both publish
// it. The only real gate is an authenticated runtime fetch.
//
//   dev  -> /api/marketing-distribution   (vite middleware in astro.config.mjs)
//   prod -> GET {API}/admin/marketing/distribution  (Bearer JWT, admin-only)
//
// The benign half — each post's `audience` frontmatter — stays in the repo and
// is passed to the panel as props. Only the join partner is private.

const API_BASE = "https://api.allbyte.studio";

export type Audience = "ai-dev" | "gamedev" | "players" | "general";

export interface Venue {
  id: string;
  url: string;
  note?: string;
}

export interface ChannelStrategy {
  label: string;
  viewpoint: string;
  approach: string;
  aiPosture: string;
  cadence: string;
  timeline: string;
  bestDays: string;
}

export interface CalendarBeat {
  n: number;
  what: string;
  timing: string;
  audience: Audience;
  capture: string;
  note?: string;
}

export interface Distribution {
  channels: Partial<Record<Audience, ChannelStrategy>>;
  venues: Partial<Record<Audience, Venue[]>>;
  calendar: CalendarBeat[];
  /** slug -> venues already posted to */
  posted: Record<string, { venue: string }[]>;
}

/** Why the panel has no data — lets it explain itself instead of rendering blank. */
export type DistributionState =
  | { status: "ok"; data: Distribution }
  | { status: "absent" } // private file missing (fresh clone, dev)
  | { status: "unauthorized" } // not admin, or no/expired token (prod)
  | { status: "error"; detail: string };

export async function fetchDistribution(signal?: AbortSignal): Promise<DistributionState> {
  // The dev path MUST keep its trailing slash: astro.config sets
  // trailingSlash: "always", and Astro 404s the slash-less form before the
  // vite middleware ever runs. (The prod API Gateway route has no such rule.)
  const url = import.meta.env.DEV
    ? "/api/marketing-distribution/"
    : `${API_BASE}/admin/marketing/distribution`;

  // In dev the vite middleware is unauthenticated and the token is the fake
  // "dev-local-token" that initAuth() mints, so sending it would be noise.
  const headers: Record<string, string> = import.meta.env.DEV
    ? {}
    : { Authorization: `Bearer ${localStorage.getItem("allbyte_token") ?? ""}` };

  try {
    const res = await fetch(url, { signal, headers, cache: "no-store" });
    if (res.status === 401 || res.status === 403) return { status: "unauthorized" };
    if (res.status === 404) return { status: "absent" };
    if (!res.ok) return { status: "error", detail: `HTTP ${res.status}` };
    return { status: "ok", data: (await res.json()) as Distribution };
  } catch (e) {
    if (signal?.aborted) return { status: "error", detail: "aborted" };
    return { status: "error", detail: e instanceof Error ? e.message : String(e) };
  }
}
