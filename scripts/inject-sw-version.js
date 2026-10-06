#!/usr/bin/env node
/**
 * Post-build step: replace the __BUILD_VERSION__ placeholder in dist/sw.js
 * with the actual game version from src/data/game-version.json.
 *
 * Why this exists: PWA browsers detect a service-worker update when the
 * sw.js bytes change. Without per-build content variation, the browser
 * never sees the SW as updated and never wipes the stale cache — so users
 * stay stuck on whichever game version they first loaded.
 *
 * The injected version is also used as the cache name (chronicles-godot-X),
 * so each deploy gets its own cache. The SW's activate handler purges any
 * caches that don't match the current name. Net result: every deploy
 * triggers an automatic update on next page navigation.
 *
 * Runs as the final step of `npm run build`, after Astro has copied
 * public/sw.js to dist/sw.js. Idempotent — running it twice on the same
 * dist is a no-op (placeholder is already gone after first replace).
 *
 * Fails loudly (exit 1) rather than silently if anything is missing,
 * because shipping a SW with __BUILD_VERSION__ literally in the cache
 * name would silently break the update mechanism.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const swPath = join(root, "dist", "sw.js");
const versionPath = join(root, "src", "data", "game-version.json");
const PLACEHOLDER = "__BUILD_VERSION__";

/**
 * BUILD_VERSION = the current game version, full stop. The SW caches
 * /godot/* (the heavy WASM + PCK bytes); we want that cache to invalidate
 * ONLY when the game itself changes — not on every git commit.
 *
 * Earlier version of this script combined `${gameVersion}-${gitShortSha}`
 * so every web-side commit triggered a fresh SW + cache wipe. That made
 * the UpdateOverlay fire reliably but had a bad side effect: every
 * unrelated web-side push (a CSS tweak, a typo fix) blew away the user's
 * cached game and forced a ~60MB re-download on next visit. the owner
 * specifically flagged this on 2026-06-01.
 *
 * Web-side updates don't actually need the SW to fire — they're served
 * via normal HTTP cache (Astro emits `max-age=0, must-revalidate` for
 * HTML and content-hashed filenames for JS/CSS bundles). Users always
 * get fresh web code on page navigation regardless of SW state.
 *
 * Net: SW updates only when the game version bumps. Web-only deploys
 * leave the game cache intact.
 */
if (!existsSync(swPath)) {
  console.error(`[inject-sw-version] ${swPath} not found — did astro build run?`);
  process.exit(1);
}
if (!existsSync(versionPath)) {
  console.error(`[inject-sw-version] ${versionPath} not found`);
  process.exit(1);
}

let committed;
try {
  const data = JSON.parse(readFileSync(versionPath, "utf8"));
  committed = data.version;
  if (!committed || typeof committed !== "string") {
    throw new Error(`game-version.json has no usable "version" string`);
  }
} catch (err) {
  console.error(`[inject-sw-version] could not read version: ${err.message}`);
  process.exit(1);
}

/**
 * THE VERSION STAMPED HERE MUST BE WHAT IS ACTUALLY DEPLOYED, so it is read
 * from the live channels.json — not from the committed file.
 *
 * The race this removes (it is subtle and it bit us): a game promote runs
 * push-channel.js, which stamps the LIVE sw.js correctly and invalidates it, so
 * players are fine immediately. But the committed game-version.json still says
 * the OLD version until finalize-demo.yml catches up (10-min cron). Any site
 * deploy landing inside that window rebuilt sw.js from the stale committed
 * value and OVERWROTE the correct live stamp — reverting every returning player
 * to a cache key for a game that is no longer deployed, which is the
 * stale-cache boot hang. push-channel.js:315 warns about exactly this.
 *
 * Shortening the cron or firing a dispatch from CodeBuild would only make the
 * window smaller. Reading the deployed value instead makes the revert
 * IMPOSSIBLE: whatever order the deploys land in, sw.js is stamped with what is
 * serving. The committed file stays useful (the footer, and the fallback here)
 * but is no longer load-bearing for the cache key.
 *
 * Fallback is deliberate and loud: a build with no network (offline laptop, or
 * the very first deploy before channels.json exists) uses the committed value
 * rather than failing, because a correct-but-stale stamp is recoverable while a
 * failed build blocks everything. Set SW_VERSION_SOURCE=committed to force the
 * old behaviour.
 */
const CHANNELS_URL = process.env.CHANNELS_URL || "https://allbyte.studio/godot/channels.json";

/** channels.json carries "0.8.2756-913371dd"; sw.js wants the bare "v0.8.2756". */
function normalize(raw, likeCommitted) {
  const bare = String(raw).replace(/^v/, "").split("-")[0];
  return likeCommitted.startsWith("v") ? `v${bare}` : bare;
}

async function resolveDeployedVersion() {
  if (process.env.SW_VERSION_SOURCE === "committed") {
    console.log(`[inject-sw-version] SW_VERSION_SOURCE=committed — using ${committed}`);
    return committed;
  }
  try {
    const res = await fetch(CHANNELS_URL, {
      headers: { "Cache-Control": "no-cache" },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const json = await res.json();
    const live = (json.channels || json)?.alpha?.version;
    if (!live) throw new Error("no alpha channel version in channels.json");
    const resolved = normalize(live, committed);
    if (resolved !== committed) {
      // Expected right after a game promote, before finalize commits.
      console.log(
        `[inject-sw-version] deployed is ${resolved}, committed is ${committed} — ` +
          `stamping the DEPLOYED version (prevents reverting sw.js to a version nobody serves)`
      );
    } else {
      console.log(`[inject-sw-version] deployed matches committed (${resolved})`);
    }
    return resolved;
  } catch (err) {
    console.warn(
      `[inject-sw-version] could not read deployed version from ${CHANNELS_URL} ` +
        `(${err.message}) — falling back to committed ${committed}`
    );
    return committed;
  }
}

const version = await resolveDeployedVersion();

const sw = readFileSync(swPath, "utf8");
if (!sw.includes(PLACEHOLDER)) {
  // Already injected (idempotent re-run) or template was edited. The
  // latter case is the dangerous one — if someone removed the placeholder,
  // every deploy ships the same cache name and the update mechanism dies
  // silently. Don't allow shipping in that case.
  if (sw.includes("chronicles-godot-")) {
    console.log(`[inject-sw-version] placeholder already replaced; skipping`);
    process.exit(0);
  }
  console.error(
    `[inject-sw-version] ${PLACEHOLDER} not found in dist/sw.js AND no chronicles-godot-* cache name detected — sw.js template may be broken`
  );
  process.exit(1);
}

const updated = sw.replaceAll(PLACEHOLDER, version);
writeFileSync(swPath, updated);
console.log(`[inject-sw-version] injected version ${version} into ${swPath}`);
