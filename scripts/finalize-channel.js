#!/usr/bin/env node
/**
 * finalize-channel.js — close the sw.js loop after a BUTTON / CodeBuild promote.
 *
 * The manual `npm run promote` deploys AND runs finalize-web-deploy.js in one
 * shot, off the local build manifest. The /test/ demo-promote BUTTON deploys via
 * CodeBuild, where that manifest is ephemeral — so the finalize half never runs,
 * and `src/data/game-version.json` drifts behind what actually shipped to public.
 * That drift is the SW stale-cache-hang bug: push-channel stamps the deployed
 * sw.js from game-version.json, and the NEXT site CI deploy re-stamps sw.js from
 * the SAME (stale) game-version.json — so returning devices keep a cache keyed to
 * the wrong version and hang on boot.
 *
 * This wrapper reconstructs what finalize needs from the one durable record a
 * CodeBuild promote leaves behind: the live channels.json (push-channel merges
 * `{version, gitSha, deployedAt}` per channel). It reads the deployed version for
 * a channel, synthesizes the minimal manifest finalize-web-deploy.js consumes,
 * and delegates. Nothing here that finalize doesn't already do — it just sources
 * the version from channels.json instead of a local manifest.
 *
 * TWO-STEP PUBLIC-PROMOTE FLOW:
 *   1. Click the /test/ deploy button (CodeBuild deploys Demo + Demo-Debug).
 *   2. On the host, run:  npm run finalize:channel        (defaults to alpha)
 *      -> stamps game-version.json to the deployed public version, commits, and
 *         pushes; site CI then re-stamps sw.js to match. No more drift.
 *
 * Runs on the owner's machine (needs git push rights, like the other syncs).
 *
 *   node scripts/finalize-channel.js [--channel alpha] [--origin https://allbyte.studio]
 *                                    [--dry-run] [--no-push]
 *
 * game-version.json tracks the PUBLIC build, so the default channel is `alpha`
 * (-> /godot/public/), the anonymous homepage default.
 */

import { execSync } from "node:child_process";
import { writeFileSync, mkdtempSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}
function die(msg) {
  console.error(`[finalize-channel] ✗ ${msg}`);
  process.exit(1);
}

const channel = arg("--channel", "alpha");
const origin = arg("--origin", "https://allbyte.studio").replace(/\/+$/, "");
const passthrough = ["--dry-run", "--no-push"].filter((f) => process.argv.includes(f));

const url = `${origin}/godot/channels.json?cb=${Date.now()}`;
console.log(`[finalize-channel] reading ${url}`);

let channels;
try {
  const res = await fetch(url, { headers: { "Cache-Control": "no-cache" } });
  if (!res.ok) die(`channels.json fetch failed: HTTP ${res.status}`);
  channels = await res.json();
} catch (e) {
  die(`could not read channels.json (${e.message})`);
}

const entry = channels[channel];
if (!entry || !entry.version) {
  die(
    `channel '${channel}' not present in channels.json (have: ${Object.keys(channels).join(", ") || "none"}). ` +
      `Has the button promoted it yet?`
  );
}

// channels.json version is "<semver>-<shortsha>" (e.g. 0.7.2201-b7b2e032).
// finalize wants a clean vX.Y.Z; strip the sha suffix. finalize re-adds the "v".
const raw = String(entry.version);
const semver = raw.split("-")[0];
if (!/^\d+\.\d+\.\d+$/.test(semver)) {
  die(`deployed '${channel}' version '${raw}' -> '${semver}' is not a clean X.Y.Z; refusing (would corrupt the sw.js cache key).`);
}

// finalize reads manifest.version (deployed) + manifest.created (epoch seconds,
// = channels.json deployedAt). Synthesize the minimal manifest it consumes.
const manifest = { channel, version: semver, created: entry.deployedAt || null };
const tmp = join(mkdtempSync(join(tmpdir(), "finalize-ch-")), "build_manifest.json");
writeFileSync(tmp, JSON.stringify(manifest, null, 2));

console.log(
  `[finalize-channel] channel=${channel} deployed=${raw} -> game-version.json v${semver}` +
    `${passthrough.length ? ` (${passthrough.join(" ")})` : ""}`
);

try {
  execSync(`node scripts/finalize-web-deploy.js --manifest "${tmp}" ${passthrough.join(" ")}`.trim(), {
    cwd: REPO,
    stdio: "inherit",
  });
} catch {
  die("finalize-web-deploy.js failed (see output above).");
}
