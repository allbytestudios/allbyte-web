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
 * The manifest lives in the Chronicles repo (dev-only), so it is ALSO mirrored
 * to S3 by publish-deploy-manifest.js. Resolution order:
 *   1. CHRONICLES_DIR — authoritative, and a superset on a dev machine.
 *   2. the S3 mirror over HTTPS — the only copy a CI runner can see.
 * Without (2) this silently produced empty releases: finalize-demo.yml runs on a
 * GitHub runner with no Chronicles checkout, so every live promote from
 * 2026-07-06 to 08-06 shipped a release with zero changes and exit 0.
 *
 * Reaching NEITHER source leaves changelog.json untouched and exits 0, so an
 * ordinary build never depends on the manifest. Pass --require-manifest to make
 * that a hard error instead — the release path (finalize-web-deploy.js) does,
 * because silence there is what loses changelog entries.
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
const MANIFEST_URL =
  process.env.DEPLOY_MANIFEST_URL || "https://allbyte.studio/test-snapshot/tickets/deploy_manifest.ndjson";
const REQUIRE_MANIFEST = process.argv.includes("--require-manifest");

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

// Local checkout first (superset on a dev box), else the S3 mirror (the only
// copy CI can see). Returns null when neither is reachable.
async function loadManifest() {
  if (existsSync(MANIFEST)) {
    console.log(`manifest: ${MANIFEST} (local)`);
    return readFileSync(MANIFEST, "utf8");
  }
  try {
    const res = await fetch(MANIFEST_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    // CloudFront rewrites 403/404 -> /index.html and serves it with HTTP 200, so
    // "ok" proves nothing. An absent mirror arrives as a page of site HTML;
    // sniff the first line rather than letting JSON.parse throw downstream.
    const first = body.split(/\r?\n/).find((l) => l.trim());
    let probe;
    try { probe = JSON.parse(first ?? ""); } catch { probe = null; }
    if (!probe?.version) throw new Error("mirror did not return ndjson (likely the CloudFront 404->index.html rewrite)");
    console.log(`manifest: ${MANIFEST_URL} (S3 mirror)`);
    return body;
  } catch (e) {
    console.warn(`Manifest unreachable — local '${MANIFEST}' absent and mirror failed: ${e.message}`);
    return null;
  }
}

async function main() {
  const raw = await loadManifest();
  if (raw === null) {
    if (REQUIRE_MANIFEST) {
      console.error(
        "--require-manifest: refusing to ship a release with no manifest. Regenerating now would " +
          "publish a version with an empty 'what's new'. Fix the manifest source, then re-run.",
      );
      process.exitCode = 1;
      return;
    }
    console.warn("Leaving changelog.json untouched.");
    return; // exit 0 — an ordinary build must never depend on the manifest
  }
  const records = raw
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

  // IDEMPOTENT WRITE. `generatedAt` changes on every run, so writing
  // unconditionally makes the file differ every time even when no release
  // changed — and finalize-web-deploy.js commits + pushes any diff it sees.
  // With the S3 mirror in place the scheduled reconcile now ALWAYS regenerates
  // successfully, which turned that into a commit + site deploy every ~10
  // minutes (6 "changelog: refresh from deploy manifest" commits in 6 hours,
  // 2026-08-07). Only rewrite when the RELEASES actually changed; otherwise
  // keep the previous file byte-for-byte, timestamp included.
  let prev = null;
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first run */ }
  if (prev && JSON.stringify(prev.releases) === JSON.stringify(out)) {
    console.log(`changelog.json: unchanged (${out.length} releases) — leaving the file untouched.`);
    return;
  }

  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), releases: out }, null, 2) + "\n");
  console.log(`changelog.json: ${out.length} releases with changes (${skipped} empty releases skipped), from ${records.length} manifest records.`);
}

main().catch((e) => { console.error(`deploy-history failed: ${e.message}`); process.exit(1); });
