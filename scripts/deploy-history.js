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
 * to S3 by publish-deploy-manifest.js. Local and hosted records are merged by
 * version and commit SHA: either source can contain newer deploys than the other.
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

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { mergeDeployManifests } from "./lib/deploy-manifest.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO = join(__dirname, "..");
const OUT = join(REPO, "src", "data", "changelog.json");
const CHRONICLES = process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis";
const MANIFEST = join(CHRONICLES, "tickets", "deploy_manifest.ndjson");
const MANIFEST_URL =
  process.env.DEPLOY_MANIFEST_URL || "https://allbyte.studio/test-snapshot/tickets/deploy_manifest.ndjson";
const REQUIRE_MANIFEST = process.argv.includes("--require-manifest");
const REQUIRE_CURRENT = process.argv.includes("--require-current");

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

// The game repo, when it happens to be on this machine. Arc's manifest is the
// designed source precisely because CI has no game checkout — this is a local
// FALLBACK for releases the manifest never recorded, not a replacement.
//
// It exists because the manifest went quiet after v0.8.2642 (2026-09-09) and
// the public feed then skipped every release for five weeks: deploy-history
// drops any release with zero changes, so those builds were never emitted at
// all. changelog.json is a committed artifact, so regenerating locally is
// enough to publish them.
const GAME_VERSION_FILE = "WebBootstrap/Autoload/World.gd";

// Takes an argv ARRAY, not a command string. execSync shells out through
// cmd.exe on Windows, which does not treat single quotes as quoting — and the
// pickaxe argument below carries both spaces and double quotes, so a shell
// round-trip mangles it and every lookup silently returns nothing.
function gameGit(args) {
  try {
    return execFileSync("git", args, {
      cwd: CHRONICLES,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 64 * 1024 * 1024,
    }).trim();
  } catch {
    return "";
  }
}

const gameRepoAvailable = () => existsSync(join(CHRONICLES, ".git")) && !!gameGit(["rev-parse", "--git-dir"]);

// Which game commit set this WEB_VERSION. The version string is a constant in
// World.gd, so the pickaxe finds the exact bump commit; that bump is the anchor
// for "everything since the previous release".
const shaCache = new Map();
function resolveGameSha(version) {
  const bare = String(version).replace(/^v/, "");
  if (shaCache.has(bare)) return shaCache.get(bare);
  // --all: a release can be cut from a branch that is not an ancestor of the
  // current HEAD, and the default walk would never see its bump commit.
  const sha = gameGit([
    "log", "--all", `-SWEB_VERSION = "${bare}"`, "--format=%H", "-n1", "--", GAME_VERSION_FILE,
  ]).split(/\r?\n/)[0] || null;
  shaCache.set(bare, sha);
  return sha;
}

// Reproduce what a manifest record would have carried: the commits between the
// previous release's bump and this one's, parsed as conventional commits.
function deriveChanges(prevSha, sha) {
  // BOTH anchors are required. With no lower bound the range is the entire
  // history of the repo, which produced a single "release" of 3097 commits
  // before this guard existed — a feed entry that is worse than the missing
  // one it replaced. An unbounded release is skipped, not guessed at.
  if (!sha || !prevSha) return [];
  const range = `${prevSha}..${sha}`;
  const log = gameGit(["log", range, "--no-merges", "--format=%H%x09%s"]);
  if (!log) return [];
  const out = [];
  for (const line of log.split(/\r?\n/).filter(Boolean)) {
    const [full, subject] = line.split("\t");
    if (!subject) continue;
    const m = /^(\w+)(?:\(([^)]+)\))?!?:\s*(.+)$/.exec(subject);
    out.push({
      type: m ? m[1] : undefined,
      scope: m ? m[2] : undefined,
      subject: scrub(m ? m[3] : subject),
      sha: (full || "").slice(0, 8),
    });
  }
  return out;
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
    // Dedupe on the VERSION, not just consecutive repeats. A build can ship,
    // be superseded, then ship again (2442 -> 2356 -> 2442 on 2026-08-20/21),
    // and the consecutive-only check let the second copy through — the public
    // feed then listed the same release twice with an identical 361-change body.
    // Keep the FIRST occurrence: the changelog records when content first
    // reached players, and a re-ship carries no new content to announce.
    if (out.some((r) => r.version === version)) continue;
    out.push({ version, date: iso.slice(0, 10), num: buildNum(version) });
  }
  return out;
}

// Merge the workstation checkout and hosted mirror. The local game checkout
// may lag behind cloud builds, so choosing it instead of the mirror freezes
// the public What's New feed at its last locally exported build.
async function loadManifest() {
  const sources = [];
  if (existsSync(MANIFEST)) {
    sources.push({ name: MANIFEST, body: readFileSync(MANIFEST, "utf8") });
    console.log(`manifest source: ${MANIFEST} (local)`);
  }
  try {
    const res = await fetch(`${MANIFEST_URL}${MANIFEST_URL.includes("?") ? "&" : "?"}cb=${Date.now()}`, {
      headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.text();
    // CloudFront rewrites 403/404 -> /index.html and serves it with HTTP 200, so
    // "ok" proves nothing. An absent mirror arrives as a page of site HTML;
    // sniff the first line rather than letting JSON.parse throw downstream.
    const first = body.split(/\r?\n/).find((l) => l.trim());
    let probe;
    try { probe = JSON.parse(first ?? ""); } catch { probe = null; }
    if (!probe?.version) throw new Error("mirror did not return ndjson (likely the CloudFront 404->index.html rewrite)");
    sources.push({ name: MANIFEST_URL, body });
    console.log(`manifest source: ${MANIFEST_URL} (S3 mirror)`);
  } catch (e) {
    console.warn(`Manifest mirror unavailable: ${e.message}`);
  }
  if (!sources.length) return null;
  return mergeDeployManifests(sources);
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
    if (!gameRepoAvailable()) {
      console.warn("Leaving changelog.json untouched.");
      return; // exit 0 — an ordinary build must never depend on the manifest
    }
    console.warn("No manifest; reconstructing every release from the game repo.");
  }
  const records = (raw ?? "")
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
    // FALLBACK: the manifest never recorded this release. Reconstruct it from
    // the game repo, if it is on this machine. Without this the release is
    // dropped silently and the public feed simply stops — which is exactly
    // what happened from v0.8.2642 (2026-09-09) onward.
    let derived = false;
    if (changes.length === 0 && gameRepoAvailable()) {
      const sha = resolveGameSha(rel.version);
      const prevSha = i > 0 ? resolveGameSha(releases[i - 1].version) : null;
      const found = deriveChanges(prevSha, sha);
      if (found.length) {
        changes.push(...found);
        derived = true;
      }
    }
    if (changes.length === 0) { skipped++; continue; }
    // `derived` is recorded so a reader can tell reconstructed history from
    // what the deploy pipeline actually reported at ship time.
    out.push({ version: rel.version, date: rel.date, changes, ...(derived ? { derived: true } : {}) });
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
  // Freshness canary. The real failure in Aug-Sep 2026 was not that the manifest
  // broke — it was that nothing NOTICED for a month: the public feed sat frozen
  // at 2026-08-05 while nine releases shipped, and the only evidence was a log
  // line no one read. This runs BEFORE the unchanged-early-return on purpose,
  // because "frozen" IS the unchanged case — a canary that stays quiet exactly
  // when the thing it guards has stopped would be worse than none.
  let deployed = null;
  try {
    deployed = JSON.parse(readFileSync(join(REPO, "src", "data", "game-version.json"), "utf8")).version;
  } catch {
    if (REQUIRE_CURRENT) throw new Error("Could not read src/data/game-version.json while --require-current is enabled.");
  }
  const newest = out.length ? out[0].version : null;
  if (deployed && deployed !== newest) {
    const message =
      `[deploy-history] newest changelog release is ${newest || "(none)"}, but the ` +
      `deployed game is ${deployed} — no manifest entry for the live build.`;
    if (REQUIRE_CURRENT) throw new Error(`${message} --require-current is enabled; refusing to publish stale What's New.`);
    console.warn(`[deploy-history] ⚠ ${message} The deploy emitter may have stopped appending.`);
  }

  let prev = null;
  try { prev = JSON.parse(readFileSync(OUT, "utf8")); } catch { /* first run */ }
  if (prev && JSON.stringify(prev.releases) === JSON.stringify(out)) {
    console.log(`changelog.json: unchanged (${out.length} releases) — leaving the file untouched.`);
    return;
  }

  writeFileSync(OUT, JSON.stringify({ generatedAt: new Date().toISOString(), releases: out }, null, 2) + "\n");
  console.log(`changelog.json: ${out.length} releases with changes (${skipped} empty releases skipped), from ${records.length} manifest records.`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => { console.error(`deploy-history failed: ${e.message}`); process.exit(1); });
}

export { loadManifest };
