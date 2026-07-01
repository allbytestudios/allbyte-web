#!/usr/bin/env node
/**
 * deploy-history.js — generates src/data/changelog.json (the public /changelog/
 * "What's new" feed) by joining:
 *   - the PUBLIC releases: every commit to src/data/game-version.json in this
 *     repo is a game build that shipped to the live site (version + ship date).
 *   - Arc's game-side manifest: ChroniclesOfNesis/tickets/deploy_manifest.ndjson
 *     — per-version game commits, typed (feat/fix/test/...).
 *
 * For each public release, "what's new" = every manifest commit whose build
 * number (the globally-monotonic last version component) falls in
 * (previousPublicRelease, thisRelease]. So dev iterations between public ships
 * roll up into the release that actually carried them.
 *
 * The manifest lives in the Chronicles repo (dev-only). Like the other asset
 * syncs, this runs locally and commits changelog.json; CI builds from the
 * committed file. If the manifest isn't reachable, it leaves the existing
 * changelog.json untouched and exits 0 (so CI never depends on it).
 *
 *   npm run changelog
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const OUT = join(REPO, "src", "data", "changelog.json");
const CHRONICLES = process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis";
const MANIFEST = join(CHRONICLES, "tickets", "deploy_manifest.ndjson");

// Build number = the last dotted component of vX.Y.Z (a global monotonic counter).
const buildNum = (v) => parseInt(String(v).replace(/^v/, "").split(".").pop(), 10);

// The repo is public. Game-side commit subjects sometimes name the owner; the
// pre-push hook blocks the literal name in tracked content, so scrub it here so
// regenerating the changelog never reintroduces it.
const scrub = (s) =>
  String(s ?? "")
    .replace(/\bDrew's\b/g, "the owner's")
    .replace(/\bDrew\b/g, "the owner");

function git(args) {
  return execSync(`git ${args}`, { cwd: REPO, encoding: "utf8" }).trim();
}

// Public releases: each commit that changed game-version.json, oldest->newest,
// resolved to the version it set. Deduped on consecutive identical versions.
function publicReleases() {
  const log = git(`log --reverse --format=%cI%x09%H -- src/data/game-version.json`);
  const out = [];
  for (const line of log.split("\n").filter(Boolean)) {
    const [iso, sha] = line.split("\t");
    let version;
    try {
      version = JSON.parse(git(`show ${sha}:src/data/game-version.json`)).version;
    } catch { continue; }
    if (!version) continue;
    if (!version.startsWith("v")) version = "v" + version;
    if (out.length && out[out.length - 1].version === version) continue;
    out.push({ version, date: iso.slice(0, 10), num: buildNum(version) });
  }
  return out;
}

function main() {
  if (!existsSync(MANIFEST)) {
    console.warn(`Manifest not found at ${MANIFEST} — leaving changelog.json untouched.`);
    process.exit(0);
  }
  const records = readFileSync(MANIFEST, "utf8")
    .split(/\r?\n/).filter(Boolean)
    .map((l) => JSON.parse(l))
    .map((r) => ({ ...r, num: buildNum(r.version) }))
    .sort((a, b) => a.num - b.num);

  const releases = publicReleases();
  const out = [];
  let skipped = 0;

  for (let i = 0; i < releases.length; i++) {
    const rel = releases[i];
    const prevNum = i > 0 ? releases[i - 1].num : -Infinity;
    // every manifest commit in (prevPublic, thisPublic]
    const changes = [];
    for (const rec of records) {
      if (rec.num > prevNum && rec.num <= rel.num) {
        for (const c of rec.commits || []) changes.push({ type: c.type, scope: c.scope, subject: scrub(c.subject), sha: c.sha });
      }
    }
    if (changes.length === 0) { skipped++; continue; }
    out.push({ version: rel.version, date: rel.date, changes });
  }

  out.reverse(); // newest first
  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), releases: out }, null, 2) + "\n");
  console.log(`changelog.json: ${out.length} releases with changes (${skipped} empty releases skipped), from ${records.length} manifest records.`);
}

main();
