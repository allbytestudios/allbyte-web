#!/usr/bin/env node
/**
 * finalize-web-deploy.js — the web-side tail of a LIVE game deploy.
 *
 * After push-channel.js has pushed a live/player-facing build to S3, this closes
 * the loop so the deploy is cache-safe AND self-documenting, with no agent in it:
 *
 *   1. Stamp src/data/game-version.json to the version that was ACTUALLY
 *      deployed (read from the same build manifest push-channel used — NOT a
 *      local `sync` that may be a build ahead of what shipped to public). This
 *      is the source of truth the service worker keys its cache name on, so
 *      committing it advances CACHE_NAME and force-purges stale /godot/* caches
 *      on returning devices (the fix for the mismatched-wasm/pck boot crash).
 *   2. Regenerate src/data/changelog.json from the deploy manifest
 *      (scripts/deploy-history.js) so /changelog/ reflects the new release.
 *   3. Commit both as ONE release commit and push → the site CI rebuild stamps
 *      the new version into dist/sw.js and ships the changelog. CI never reverts
 *      sw.js to a stale version again, because the committed version now matches
 *      what's live.
 *
 * deploy-history.js reads the COMMITTED git history of game-version.json, so the
 * version is committed BEFORE the changelog is regenerated, then the changelog
 * is folded into the same commit (git commit --amend).
 *
 * Runs locally (owner's machine) — it needs git push rights and the Chronicles
 * manifest, exactly like the other asset syncs. Invoked by `npm run promote`
 * after a successful live push; can also be run standalone.
 *
 *   node scripts/finalize-web-deploy.js --manifest <build_manifest.json> [--dry-run] [--no-push]
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const VERSION_FILE = join(REPO, "src", "data", "game-version.json");
const CHANGELOG = "src/data/changelog.json";
const VERSION_REL = "src/data/game-version.json";

const dryRun = process.argv.includes("--dry-run");
const noPush = process.argv.includes("--no-push");

function die(msg) {
  console.error(`[finalize] ✗ ${msg}`);
  process.exit(1);
}
function run(cmd) {
  return execSync(cmd, { cwd: REPO, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
}
function porcelain(pathspec) {
  return run(`git status --porcelain -- "${pathspec}"`).trim();
}

// --- manifest -> deployed version --------------------------------------------
const mi = process.argv.indexOf("--manifest");
if (mi === -1 || !process.argv[mi + 1]) die("missing --manifest <path>");
const manifestPath = process.argv[mi + 1];
if (!existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  die(`manifest is not valid JSON: ${e.message}`);
}

let version = String(manifest.version || "").trim();
if (!version || version === "(unstamped)") {
  die("manifest has no stamped version — refusing to finalize an unversioned live build (this would corrupt the sw.js cache key).");
}
if (!version.startsWith("v")) version = "v" + version;
if (!/^v\d+\.\d+\.\d+$/.test(version)) {
  console.warn(`[finalize] ⚠ version '${version}' is not a clean vX.Y.Z — the changelog build-number rollup + ?v= cache-bust assume that shape.`);
}
// manifest.created is epoch seconds (same field channels.json uses for deployedAt).
const buildDate = manifest.created
  ? new Date(manifest.created * 1000).toISOString()
  : new Date().toISOString();

// --- 1. stamp game-version.json ----------------------------------------------
const current = existsSync(VERSION_FILE) ? JSON.parse(readFileSync(VERSION_FILE, "utf8")) : {};
const next = { version, buildDate };
const versionChanged = current.version !== next.version;

console.log(`[finalize] deployed=${version}  committed=${current.version || "(none)"}  ${versionChanged ? "→ bump" : "(unchanged)"}`);

if (dryRun) {
  console.log(`[finalize] [dry-run] would write ${VERSION_REL}:\n${JSON.stringify(next, null, 2)}`);
  console.log("[finalize] [dry-run] would regenerate changelog, then commit + push. Diff of what changed vs committed:");
  writeFileSync(VERSION_FILE, JSON.stringify(next, null, 2) + "\n");
  run(`node scripts/deploy-history.js --require-manifest`);
  process.stdout.write(run(`git --no-pager diff -- ${VERSION_REL} ${CHANGELOG}`) + "\n");
  run(`git checkout -- ${VERSION_REL} ${CHANGELOG}`); // restore working tree
  console.log("[finalize] [dry-run] working tree restored — nothing committed or pushed.");
  process.exit(0);
}

writeFileSync(VERSION_FILE, JSON.stringify(next, null, 2) + "\n");

// --- 2. commit the version bump (deploy-history reads COMMITTED history) ------
let releaseCommitted = false;
if (porcelain(VERSION_REL)) {
  run(`git add ${VERSION_REL}`);
  run(`git commit -q -m "release ${version} (live deploy)

Auto-stamped by finalize-web-deploy.js from the deploy manifest so the sw.js
cache key matches the shipped /godot/* assets (returning devices purge stale
cache) and /changelog/ picks up the release.

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`);
  releaseCommitted = true;
  console.log(`[finalize] committed release ${version}.`);
} else {
  console.log(`[finalize] game-version.json already at ${version} — no release commit.`);
}

// --- 3. regenerate the changelog (now sees the committed version) ------------
run(`node scripts/deploy-history.js --require-manifest`);

let pushNeeded = releaseCommitted;
if (porcelain(CHANGELOG)) {
  run(`git add ${CHANGELOG}`);
  if (releaseCommitted) {
    run(`git commit -q --amend --no-edit`); // fold changelog into the release commit
    console.log("[finalize] folded changelog.json into the release commit.");
  } else {
    run(`git commit -q -m "changelog: refresh from deploy manifest

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"`);
    pushNeeded = true;
    console.log("[finalize] committed changelog refresh.");
  }
} else {
  console.log("[finalize] changelog.json unchanged.");
}

// --- 4. push → triggers the site CI rebuild (re-stamps sw.js, ships changelog)
if (!pushNeeded) {
  console.log("[finalize] nothing to push — already up to date.");
  process.exit(0);
}
if (noPush) {
  console.log("[finalize] --no-push: committed locally; run `git push` to trigger the CI deploy.");
  process.exit(0);
}
console.log("[finalize] pushing → site CI will rebuild + re-stamp sw.js + ship the changelog...");
run(`git push`);
console.log(`[finalize] ✅ finalized ${version}: version + changelog committed and pushed.`);
