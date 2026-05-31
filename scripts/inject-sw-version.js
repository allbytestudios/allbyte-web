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
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const swPath = join(root, "dist", "sw.js");
const versionPath = join(root, "src", "data", "game-version.json");
const PLACEHOLDER = "__BUILD_VERSION__";

/**
 * Build a version string that changes whenever ANYTHING about the site
 * changes — game version bump OR site code edit. Format:
 *   <game-version>-<git-short-sha>
 * e.g. v0.6.1457-a1b2c3d4
 *
 * Without the git SHA, pushes that didn't bump game-version.json would
 * leave sw.js byte-identical and browsers would skip the SW update —
 * meaning UpdateOverlay never fires and users stay on stale caches.
 *
 * Falls back to a timestamp if git isn't available (e.g. running outside
 * a worktree); spurious updates from a timestamp are mild — at worst a
 * brief "Updating..." flash, content still correct.
 */
function shortBuildId() {
  if (process.env.GITHUB_SHA) {
    return process.env.GITHUB_SHA.slice(0, 8);
  }
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
  } catch {
    return `t${Date.now()}`;
  }
}

if (!existsSync(swPath)) {
  console.error(`[inject-sw-version] ${swPath} not found — did astro build run?`);
  process.exit(1);
}
if (!existsSync(versionPath)) {
  console.error(`[inject-sw-version] ${versionPath} not found`);
  process.exit(1);
}

let version;
try {
  const data = JSON.parse(readFileSync(versionPath, "utf8"));
  const gameVersion = data.version;
  if (!gameVersion || typeof gameVersion !== "string") {
    throw new Error(`game-version.json has no usable "version" string`);
  }
  // Combine with the build ID so every site commit triggers an update,
  // not just game-version bumps.
  version = `${gameVersion}-${shortBuildId()}`;
} catch (err) {
  console.error(`[inject-sw-version] could not read version: ${err.message}`);
  process.exit(1);
}

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
