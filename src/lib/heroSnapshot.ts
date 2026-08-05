// Pre-captured viewport snapshot for the homepage → /play pixel transition.
//
// Rasterizing the DOM (snapdom) takes ~300ms, and importing the snapdom chunk
// adds more on first use — doing both AFTER the Play click is what made Play feel
// laggy. So we PRIME the snapshot ahead of the click (on an idle beat after the
// homepage settles, and again on Play hover/press) and stash it here; the
// transition consumes it instantly with zero capture on the click.
//
// The snapshot is only reused while it still matches the current viewport size,
// scroll position, and is fresh — otherwise the transition captures on the fly
// (its existing fallback), so a stale frame is never shown.

let snap: HTMLCanvasElement | null = null;
let atW = 0, atH = 0, atX = 0, atY = 0, atTs = 0;
let inFlight = false;

const FRESH_MS = 10_000;

function viewportMatches(): boolean {
  return (
    !!snap &&
    atW === window.innerWidth &&
    atH === window.innerHeight &&
    atX === (window.scrollX || 0) &&
    atY === (window.scrollY || 0) &&
    Date.now() - atTs < FRESH_MS
  );
}

/** Capture the current viewport and stash it — no-op if a matching fresh snapshot
 *  already exists or a capture is already running. Safe to call liberally. */
export function primeHeroSnapshot(): void {
  if (typeof window === "undefined" || inFlight || viewportMatches()) return;
  const w = window.innerWidth, h = window.innerHeight;
  const x = window.scrollX || 0, y = window.scrollY || 0;
  const scale = Math.min(1, 900 / w);
  inFlight = true;
  import("@zumer/snapdom")
    .then(async ({ snapdom }) => {
      const r = await snapdom(document.body, {
        scale,
        dpr: 1,
        fast: true,
        embedFonts: false,
        backgroundColor: "#050608",
        exclude: [".pixfx"],
        clip: { x, y, width: w, height: h },
      });
      const c = await r.toCanvas();
      snap = c; atW = w; atH = h; atX = x; atY = y; atTs = Date.now();
    })
    .catch(() => { /* leave snap as-is; the transition falls back to on-the-fly capture */ })
    .finally(() => { inFlight = false; });
}

/** Return a primed snapshot iff it still matches the current viewport, else null
 *  (the transition then captures on the fly). */
export function takeHeroSnapshot(): HTMLCanvasElement | null {
  if (typeof window === "undefined") return null;
  return viewportMatches() ? snap : null;
}

/** Drop the cached snapshot (e.g. on resize — its dimensions no longer fit). */
export function invalidateHeroSnapshot(): void {
  snap = null;
}
