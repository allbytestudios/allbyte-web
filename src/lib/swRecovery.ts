// Stale game-cache recovery.
//
// Returning visitors can carry a service worker + Cache-API entries from an
// older game build. After a deploy that changes the WASM / encrypts the PCK /
// rotates the obfuscation mask, that stale cache dead-ends the boot — either
// the engine's SW-registration path rejects with "Service worker already
// exists" and never reloads, or a cached old WASM fails the new encrypted PCK's
// MD5 check. Both present to the user as "stuck on loading forever."
//
// The current nothreads builds install NO service worker on a clean load, so
// any registration that exists is necessarily stale and safe to clear. (If a
// future build enables threads / cross-origin-isolation it WILL register a COI
// service worker legitimately — revisit this assumption then.)
//
// Service workers + Cache Storage are per-origin, so clearing from any page
// (the /play wrapper, the homepage) also clears the /godot/-scoped game SW.

/**
 * Unregister all service workers for this origin and delete all Cache-API
 * caches. Best-effort and idempotent. Resolves to true if anything was cleared
 * (so the caller can decide whether a reload is needed).
 */
export async function clearStaleGameCaches(): Promise<boolean> {
  let cleared = false;
  try {
    if (typeof navigator !== "undefined" && navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      if (regs.length) {
        cleared = true;
        await Promise.all(regs.map((r) => r.unregister().catch(() => {})));
      }
    }
  } catch {
    /* best-effort */
  }
  try {
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      if (keys.length) {
        cleared = true;
        await Promise.all(keys.map((k) => caches.delete(k).catch(() => {})));
      }
    }
  } catch {
    /* best-effort */
  }
  return cleared;
}
