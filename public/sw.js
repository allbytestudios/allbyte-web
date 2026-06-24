/**
 * Service worker for allbyte.studio.
 *
 * Primary job: cache the Godot HTML5 export under /godot/* so repeat visits
 * to /play/ skip the 60MB download + WASM compile. The dominant cost on
 * mobile is WASM compilation, but downloads are also significant on a
 * 4G/throttled connection — caching wins on both.
 *
 * Cache strategy:
 *   /godot/**​/index.html (and bare dir form) → network-first (deploys must
 *                        land; falls back to cache when offline so the PWA
 *                        can still launch). This covers BOTH the root debug
 *                        build (/godot/index.html) and variant subdirs like
 *                        the public build (/godot/public/index.html).
 *   /godot/*           → cache-first. Godot's engine fetches index.wasm and
 *                        index.pck with `?v=<game-version>` query strings
 *                        (see GODOT_CONFIG.fileSizes in index.html), so a
 *                        game version bump changes the URL and naturally
 *                        evicts the old cache entry on next request. NOTE:
 *                        this self-eviction only works for exports that
 *                        actually carry the `?v=` query — the public build
 *                        must too, or its bare-named assets pin stale (the
 *                        export-side half of the 2026-06-24 /play/ loop fix).
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

  // Any build entry point under /godot/ must revalidate on every deploy so a
  // separately-redeployed Godot export is picked up: the root debug build
  // (/godot/index.html) AND variant subdirs like the public build
  // (/godot/public/index.html), plus their bare-slash forms. The original
  // rule only matched /godot/index.html exactly, which left
  // /godot/public/index.html cache-first and pinned stale — the root of the
  // 2026-06-24 /play/ reload loop (direct loads resolve to the public build).
  if (url.pathname.endsWith("/index.html") || url.pathname.endsWith("/")) {
    event.respondWith(networkFirst(event.request));
    return;
  }
  // Everything else under /godot/ — the big WASM, PCK, audio worklets,
  // engine JS, splash images, font subset — is cache-first.
  event.respondWith(cacheFirst(event.request));
});

async function cacheFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  // Only persist successful, same-origin responses. Don't poison the cache
  // with 404s or opaque responses (those would have `type: "opaque"`).
  if (response.ok && response.type === "basic") {
    // Clone before consumption — Response bodies can only be read once.
    cache.put(request, response.clone()).catch(() => {
      // Cache writes can fail under quota pressure; that's OK, the user
      // just doesn't get the next-load speedup. Don't break the request.
    });
  }
  return response;
}

async function networkFirst(request) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  } catch (err) {
    const cached = await cache.match(request);
    if (cached) return cached;
    throw err;
  }
}
