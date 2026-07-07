#!/usr/bin/env node
/**
 * promote.js — one command to ship a LIVE (player-facing) game build, agent-free.
 *
 *   npm run promote -- --channel alpha         # newest ready build for that channel
 *   npm run promote -- --manifest <path>       # a specific build manifest
 *   npm run promote -- --channel alpha --dry-run
 *
 * It chains the two halves that used to be a manual ritual (and used to need an
 * agent to remember step 2):
 *   1. push-channel.js --promote  → uploads /godot/<path>/* to S3, stamps sw.js,
 *      updates channels.json, invalidates CloudFront, runs the prod smoke.
 *   2. finalize-web-deploy.js     → stamps game-version.json to the DEPLOYED
 *      version + regenerates the changelog + commits & pushes, so the site CI
 *      rebuild re-stamps sw.js (returning devices purge stale cache) and ships
 *      /changelog/. Cache-safe + self-documenting, no agent in the loop.
 *
 * Dev channels (develop/beta-debug) don't use this — they auto-deploy via the
 * watcher / cloud CodeBuild and stay self-versioned (not committed to the web
 * repo). This is only for the deliberate live promote.
 *
 * Env: EXPORT_ROOT (default: Chronicles WebBootstrap/export) — where build
 *      manifests live, same as deploy-watcher.js.
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const EXPORT_ROOT =
  process.env.EXPORT_ROOT ||
  join(homedir(), "Desktop", "GameDev", "ChroniclesOfNesis", "WebBootstrap", "export");

const DEV_CHANNELS = new Set(["develop", "beta-debug"]);

function die(msg) {
  console.error(`[promote] ✗ ${msg}`);
  process.exit(1);
}
function argVal(flag) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : null;
}

const dryRun = process.argv.includes("--dry-run");
const noPush = process.argv.includes("--no-push");
let manifestPath = argVal("--manifest");
const channel = argVal("--channel");

// --- resolve the manifest ----------------------------------------------------
if (!manifestPath) {
  if (!channel) die("pass --channel <alpha|alpha-debug|beta> or --manifest <path>");
  if (!existsSync(EXPORT_ROOT)) die(`EXPORT_ROOT not found: ${EXPORT_ROOT} (set EXPORT_ROOT env)`);
  // Newest build_manifest.json under EXPORT_ROOT/*/ whose channel matches.
  const candidates = [];
  for (const name of readdirSync(EXPORT_ROOT)) {
    const mf = join(EXPORT_ROOT, name, "build_manifest.json");
    if (!existsSync(mf)) continue;
    try {
      if (JSON.parse(readFileSync(mf, "utf8")).channel === channel) {
        candidates.push({ mf, mtime: statSync(mf).mtimeMs });
      }
    } catch {
      /* ignore unreadable manifest */
    }
  }
  if (!candidates.length) die(`no build_manifest.json for channel '${channel}' under ${EXPORT_ROOT}`);
  candidates.sort((a, b) => b.mtime - a.mtime);
  manifestPath = candidates[0].mf;
  console.log(`[promote] resolved newest '${channel}' build: ${manifestPath}`);
}
if (!existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (e) {
  die(`manifest is not valid JSON: ${e.message}`);
}
if (DEV_CHANNELS.has(manifest.channel)) {
  die(`channel '${manifest.channel}' is a DEV channel — it auto-deploys via the watcher and stays self-versioned; promote is for LIVE channels only.`);
}

// --- 1. push-channel --promote ----------------------------------------------
const pcArgs = ["scripts/push-channel.js", "--promote", "--manifest", manifestPath];
if (dryRun) pcArgs.push("--dry-run");
console.log(`[promote] → push-channel ${manifest.channel} ${manifest.version || ""}${dryRun ? " (dry-run)" : ""}`);
const pc = spawnSync("node", pcArgs, { cwd: root, stdio: "inherit" });
if (pc.status !== 0) die(`push-channel failed (exit ${pc.status}) — NOT finalizing.`);

// --- 2. finalize-web-deploy --------------------------------------------------
// ONLY for the player-facing alpha pair. finalize stamps game-version.json —
// the GLOBAL service-worker cache key, download-gate key, and /changelog/
// input. Finalizing a beta promote would rekey every player's cache on the
// beta version (forcing a full ~75MB re-download against unchanged public
// assets) and publish beta releases to the public changelog. Beta stays
// self-versioned via its ?v= URLs, exactly like the dev channels.
const FINALIZE_CHANNELS = new Set(["alpha", "alpha-debug"]);
if (!FINALIZE_CHANNELS.has(manifest.channel)) {
  console.log(`[promote] ✅ ${manifest.channel} ${manifest.version || ""} promoted. (finalize skipped — only ${[...FINALIZE_CHANNELS].join("/")} stamp game-version.json + changelog.)`);
  process.exit(0);
}
const fArgs = ["scripts/finalize-web-deploy.js", "--manifest", manifestPath];
if (dryRun) fArgs.push("--dry-run");
if (noPush) fArgs.push("--no-push");
console.log(`[promote] → finalize (version + changelog + push)${dryRun ? " (dry-run)" : ""}`);
const fin = spawnSync("node", fArgs, { cwd: root, stdio: "inherit" });
if (fin.status !== 0) die(`finalize failed (exit ${fin.status}) — S3 is deployed but the web repo wasn't updated; run finalize-web-deploy.js manually.`);

console.log(`[promote] ✅ ${manifest.channel} ${manifest.version || ""} promoted + finalized.`);
