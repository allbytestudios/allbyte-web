/**
 * Service worker for allbyte.studio.
 *
 * Primary job: cache the Godot HTML5 export under /godot/* so repeat visits
 * to /play/ skip the 60MB download + WASM compile. The dominant cost on
 * mobile is WASM compilation, but downloads are also significant on a
 * 4G/throttled connection — caching wins on both.
 *
 * Cache strategy:
 *   /godot/* with `v=` in the query, or ending .wasm/.pck
 *                      → cache-first. Self-versioned URLs evict naturally on
 *                        a version bump; the wasm/pck are huge, immutable
 *                        per-build artifacts (the whole reason this SW
 *                        exists). NOTE: self-eviction only works for exports
 *                        that actually carry the `?v=` query — push-channel
 *                        warns when an export's pck fetch is unversioned.
 *   everything else under /godot/ (index.html, engine index.js, audio
 *   worklets, splash, fonts…)
 *                      → network-first (falls back to cache when offline so
 *                        the PWA can still launch). Deploys must land: with
 *                        five channels sharing ONE cache name keyed on the
 *                        LIVE game version, a bare-named file on a dev/beta
 *                        channel would otherwise pin stale until the next
 *                        alpha promote bumps CACHE_NAME. Small files — the
 *                        revalidate cost is noise next to the wasm/pck wins.
 *   everything else    → pass through.
 *
 * Cache versioning: the CACHE_NAME constant below is bumped when this
 * worker's caching schema changes (e.g. if we add a new path to cache, or
 * change strategy). Game content versions self-evict via the URL query
 * string above. On activate, any caches that don't match CACHE_NAME are
 * deleted.
 *
 * Scope: registered at root with default scope "/". Intercepts /godot/*
 * regardless of which page initiated the navigation.
 */

// __BUILD_VERSION__ is replaced by scripts/inject-sw-version.js after Astro
// build, from src/data/game-version.json. In dev (when this file is read
// directly) the placeholder reaches the browser, but we don't register the
// SW on localhost anyway (see BaseLayout.astro), so it's harmless.
//
// Why versioning matters: Godot's engine.js fetches /godot/index.wasm and
// /godot/index.pck WITHOUT a version query string (the ?v= in
// index.html only versions the engine.js script tag, not internal asset
// fetches — see GODOT_CONFIG.fileSizes key/value mismatch in engine
// source). So a static cache name would serve stale WASM/PCK across
// deploys forever. Versioning the cache name and bumping it per release
// is what makes /play/ actually update on prod deploys.
const BUILD_VERSION = "__BUILD_VERSION__";
// CACHE_SCHEMA is bumped when the caching *rules* below change (independent of
// the game version). Because the activate handler deletes every cache whose
// name != CACHE_NAME, changing this string forces a one-time wipe of all prior
// caches on the next deploy. Bumped to "s2" on 2026-06-24 to evict stale
// public builds that were pinned cache-first under the old index.html-only
// network-first rule (the /play/ reload-loop bug).
// NOT bumped for the 2026-06-26 gzip-WASM change: toCacheable() (below) is
// backward-compatible — it normalizes new entries and leaves existing ones
// untouched — so there's no need to wipe caches. Bumping would force every
// returning user to re-download ~33MB (WASM+PCK+assets) for no benefit, since
// they already hold a working uncompressed WASM. New/cold loads pick up the
// gzip WASM naturally. (Cross-browser tested: caching a gzip-encoded response
// verbatim replays fine on Chromium/Firefox/WebKit, so the strip is defensive,
// not load-bearing — see tests/e2e/test_wasm_gzip_cache.py.)
const CACHE_SCHEMA = "s2";
const CACHE_NAME = `chronicles-godot-${CACHE_SCHEMA}-${BUILD_VERSION}`;

self.addEventListener("install", (event) => {
  // New worker takes over without waiting for tabs to close. Acceptable
  // because the cache is content-addressed (URL-with-version), so an old
  // tab won't be served stale resources by the new worker.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys
        .filter((k) => k.startsWith("chronicles-") && k !== CACHE_NAME)
        .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith("/godot/")) return;

  // Cache-first ONLY for what's safe to pin: self-versioned URLs (`?v=` —
  // a version bump changes the URL and evicts naturally) and the huge
  // immutable per-build artifacts (.wasm/.pck). Everything else under
  // /godot/ — entry-point index.html, engine index.js, audio worklets,
  // splash, fonts — revalidates on every load (network-first, cache
  // fallback offline). Five channels share ONE cache name keyed on the
  // LIVE version, so a bare-named small file on a dev/beta channel would
  // otherwise pin stale until the next alpha promote bumps CACHE_NAME —
  // the generalization of the 2026-06-24 /play/ reload loop, where the
  // old index.html-only network-first rule left /godot/public/index.html
  // pinned. (NOT a CACHE_SCHEMA bump: entries moved to network-first are
  // simply revalidated instead of served, so no wipe is needed.)
  // Dev channels (develop, beta-debug) redeploy fresh wasm/pck under a STABLE
  // BUILD_VERSION (no finalize/version bump) — and the pck is fetched WITHOUT a
  // ?v= bust — so cache-first would pin a stale pck against a fresh wasm/shim
  // across rebuilds: MD5/mask mismatch -> "memory access out of bounds" until the
  // user manually clears site data (the 2026-07-10 develop stale-cache report).
  // Route ALL dev-channel requests through a REVALIDATING network fetch: `cache:
  // "no-cache"` forces a conditional request even against immutable browser-cache
  // entries, so returning admins always get the current, self-consistent build
  // (304 when unchanged, offline still falls back to cache). Live channels keep
  // cache-first — their version bump rotates the ?v= URL and evicts naturally.
  const devChannel =
    url.pathname.startsWith("/godot/develop/") ||
    url.pathname.startsWith("/godot/beta-debug/");
  if (devChannel) {
    event.respondWith(networkFirst(event.request, { cache: "no-cache" }));
    return;
  }
  const versioned = url.searchParams.has("v");
  const immutableArtifact = url.pathname.endsWith(".wasm") || url.pathname.endsWith(".pck");
  if (versioned || immutableArtifact) {
    event.respondWith(cacheFirst(event.request));
    return;
  }
  event.respondWith(networkFirst(event.request));
});

// Re-wrap a response so it's safe to cache. A response that arrived from the
// network with a transfer Content-Encoding (gzip on index.wasm) has a body
// that's ALREADY been decoded by the browser, yet its headers still advertise
// `content-encoding` + the compressed `content-length`. Cached verbatim and
// replayed from cache, the browser re-applies the advertised decoding to the
// already-plain body → corrupt bytes (a black-screen WASM). Strip those two
// headers and re-wrap the decoded body so the cached entry is self-consistent
// plaintext. Responses without content-encoding pass through untouched (the
// common case — pck, audio, images).
async function toCacheable(response) {
  if (!response.headers.has("content-encoding")) return response;
  const body = await response.arrayBuffer();
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-length");
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only persist successful, same-origin responses. Don't poison the cache
  // with 404s or opaque responses (those would have `type: "opaque"`).
  if (response.ok && response.type === "basic") {
    // Clone before consumption — Response bodies can only be read once. The
    // network `response` is returned to the page intact (it decodes normally);
    // the clone is normalized to plaintext for the cache.
    toCacheable(response.clone())
      .then((cacheable) => cache.put(request, cacheable))
      .catch(() => {
        // Cache writes can fail under quota pressure; that's OK, the user
        // just doesn't get the next-load speedup. Don't break the request.
      });
  }
  return response;
}

async function networkFirst(request, init) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request, init);
    if (response.ok) {
      toCacheable(response.clone())
        .then((cacheable) => cache.put(request, cacheable))
        .catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
