/**
 * Service worker for allbyte.studio.
 *
 * Primary job: cache the Godot HTML5 export under /godot/* so repeat visits
 * to /play/ skip the 60MB download + WASM compile. The dominant cost on
 * mobile is WASM compilation, but downloads are also significant on a
 * 4G/throttled connection — caching wins on both.
 *
 * Cache strategy:
 *   /godot/index.html  → network-first (deploys must land; falls back to
 *                        cache when offline so the PWA can still launch).
 *   /godot/*           → cache-first. Godot's engine fetches index.wasm and
 *                        index.pck with `?v=<game-version>` query strings
 *                        (see GODOT_CONFIG.fileSizes in index.html), so a
 *                        game version bump changes the URL and naturally
 *                        evicts the old cache entry on next request.
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

const CACHE_NAME = "chronicles-godot-v1";

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

  // index.html (and its bare-slash form) revalidates on every deploy in
  // prod — keep that contract by going network-first.
  if (url.pathname === "/godot/index.html" || url.pathname === "/godot/") {
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
