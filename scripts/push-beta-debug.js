#!/usr/bin/env node
/**
 * push-beta-debug.js — fast, non-interactive deploy of the beta-debug game
 * build to /godot/beta-debug/ on prod.
 *
 * Invoked by the game-side CI pipeline
 * (ChroniclesOfNesis/tools/ci/beta_debug_pipeline.sh) at the end of every local
 * build:   node push-beta-debug.js --manifest <abs path to build_manifest.json>
 * Contract: CON_CLAUDE_BETA_DEBUG_PIPELINE_CONTRACT.md (Arc, 2026-07-04).
 *
 *   Input:   --manifest <path>  (JSON; schema per the contract).
 *   Sources: base build  = the manifest's directory (WebBootstrap/export/beta/)
 *            zone packs   = <export>/packs/<name>.pck  (plain names; the
 *                           manifest lists them — hash-suffixed derivatives from
 *                           the alpha pipeline are ignored by construction).
 *   Dest:    obfuscate the base EXACTLY like prod, then
 *              base  -> s3://<bucket>/godot/beta-debug/
 *              packs -> s3://<bucket>/godot/beta-debug/packs/   (PackLoader
 *              fetches packs/<name>.pck?v=<ver> relative to the page)
 *            invalidate ONLY /godot/beta-debug/*.
 *            Flip gameVersions.ts beta-debug available:true on first success.
 *
 * Isolation: only ever writes /godot/beta-debug/* — cannot touch alpha, beta,
 * or alpha-debug. Non-interactive, env-credentialed, idempotent; the caller
 * serializes invocations (single-instance flock), so no locking here.
 *
 * Defense in depth (the game-side pipeline already enforces both, but we double
 * check): refuse if test_gate != "pass" or mixed_build == true, and verify the
 * sha256 of the base pck + every pack before upload.
 *
 * Security posture (owner-approved): the build is encrypted like prod; the
 * /godot/beta-debug/ path is admin/Legend-gated in the UI only (no edge auth) —
 * fine for owner validation, NOT a subscriber-facing feature.
 *
 * Exit 0 = deployed. Non-zero = push-failed (the pipeline records it).
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync, readdirSync } from "fs";
import { createHash } from "crypto";
import { gzipSync } from "zlib";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const bucket = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const region = process.env.AWS_REGION || "us-east-1";
const stackName = process.env.CLOUDFORMATION_STACK || "allbyte-studio-site";
const dryRun = process.argv.includes("--dry-run");
const DEST = "godot/beta-debug"; // S3 key prefix (and CloudFront path)

function die(msg) {
  console.error(`[push-beta-debug] ERROR: ${msg}`);
  process.exit(1);
}
function run(cmd) {
  if (dryRun) { console.log(`[dry-run] ${cmd}`); return; }
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}
function capture(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

// --- args --------------------------------------------------------------
const mi = process.argv.indexOf("--manifest");
if (mi === -1 || !process.argv[mi + 1]) die("missing --manifest <path>");
const manifestPath = process.argv[mi + 1];
if (!existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);

let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
catch (e) { die(`manifest is not valid JSON: ${e.message}`); }

// --- gate checks (defense in depth; pipeline already blocks these) -----
if (manifest.channel && manifest.channel !== "beta-debug")
  die(`manifest channel is '${manifest.channel}', expected 'beta-debug'`);
if (manifest.test_gate !== "pass")
  die(`test_gate is '${manifest.test_gate}', refusing (only 'pass' deploys)`);
if (manifest.mixed_build === true)
  die("mixed_build=true (base/packs mtime skew) — refusing to ship a stale-SW-risk build");

const baseDir = dirname(manifestPath);            // .../WebBootstrap/export/beta/
const packsDir = join(dirname(baseDir), "packs"); // .../WebBootstrap/export/packs/
const version = manifest.version || "(unstamped)";
console.log(`\n[push-beta-debug] deploying ${version} -> s3://${bucket}/${DEST}/${dryRun ? "  (DRY RUN)" : ""}`);
console.log(`[push-beta-debug] base=${baseDir}\n[push-beta-debug] packs=${packsDir}`);

// --- sha256 verification of base + packs -------------------------------
function verify(path, expected, label) {
  if (!existsSync(path)) die(`${label} missing on disk: ${path}`);
  if (!expected) { console.log(`[push-beta-debug] (no sha256 in manifest for ${label}; skipping verify)`); return; }
  const got = sha256(path);
  if (got !== expected) die(`sha256 mismatch for ${label}: manifest ${expected.slice(0,12)}… vs disk ${got.slice(0,12)}…`);
  console.log(`[push-beta-debug] sha256 OK — ${label}`);
}
const basePck = join(baseDir, (manifest.base && manifest.base.path) || "index.pck");
verify(basePck, manifest.base && manifest.base.sha256, "base index.pck");
const packEntries = (manifest.packs || []).map((p) => (typeof p === "string" ? { path: p } : p));
for (const p of packEntries) verify(join(packsDir, p.path), p.sha256, `pack ${p.path}`);

// --- 1. obfuscate the base build (idempotent; XORs the wasm key + shim) -
const baseIndex = join(baseDir, "index.html");
const baseJs = join(baseDir, "index.js");
const baseWasm = join(baseDir, "index.wasm");
const shimPath = join(baseDir, "pck-key-shim.js");
if (!existsSync(baseIndex)) die(`base index.html missing: ${baseIndex}`);

if (process.env.SKIP_GODOT_OBFUSCATION === "1") {
  console.log("[push-beta-debug] SKIP_GODOT_OBFUSCATION=1 — shipping base verbatim.");
} else if (!dryRun) {
  console.log("[push-beta-debug] running Godot key obfuscator on base build...");
  try { execSync(`node "${join(root, "scripts", "obfuscate-godot-export.js")}" "${baseDir}"`, { stdio: "inherit" }); }
  catch { die("obfuscator refused — fix local state per its message; aborting (nothing uploaded)."); }
} else {
  console.log(`[dry-run] node scripts/obfuscate-godot-export.js "${baseDir}"`);
}

// Cache-bust gate: the index.js must carry the versioned fetch (.wasm?v=) or a
// stale cached wasm becomes a mismatched-pair crash instead of a clean miss.
if (!dryRun && existsSync(baseJs) && !/\.wasm\?v=/.test(readFileSync(baseJs, "utf8")))
  die("base index.js is MISSING the .wasm?v= cache-bust — build predates it or an export path drifted; refusing.");

// shim/HTML consistency gate (reproduces the 2026-05-31 black-screen bug if skewed).
if (!dryRun) {
  const shimExists = existsSync(shimPath);
  const htmlRefsShim = readFileSync(baseIndex, "utf8").includes("pck-key-shim.js");
  if (shimExists !== htmlRefsShim)
    die(`shim/HTML mismatch — shim ${shimExists ? "exists" : "missing"}, index.html ${htmlRefsShim ? "references" : "does not reference"} it; refusing.`);
}

// --- 2. sync the base build -> godot/beta-debug/ -----------------------
// Immutable for content-stable assets; index.html must-revalidate so updates
// land. index.wasm excluded and uploaded gzip-encoded (CloudFront won't
// auto-compress >10MB). Pipeline artifacts (manifest, DEPLOY_READY, *.gz)
// excluded so they never reach the public path.
run(
  `aws s3 sync "${baseDir}" s3://${bucket}/${DEST} ` +
    `--region ${region} ` +
    `--cache-control "public, max-age=31536000, immutable" ` +
    `--exclude "index.html" --exclude "index.wasm" ` +
    `--exclude "build_manifest.json" --exclude "DEPLOY_READY" ` +
    `--exclude "*.gz" --exclude ".gitkeep" --exclude "packs/*"`
);
run(
  `aws s3 cp "${baseIndex}" s3://${bucket}/${DEST}/index.html ` +
    `--region ${region} --cache-control "public, max-age=0, must-revalidate" ` +
    `--content-type "text/html"`
);

// index.wasm gzip-encoded (~36MB -> ~9MB).
if (existsSync(baseWasm)) {
  const gzPath = `${baseWasm}.gz`;
  if (dryRun) {
    console.log(`[dry-run] gzip + upload ${baseWasm} -> s3://${bucket}/${DEST}/index.wasm (Content-Encoding: gzip)`);
  } else {
    const raw = readFileSync(baseWasm);
    writeFileSync(gzPath, gzipSync(raw, { level: 9 }));
    try {
      run(
        `aws s3 cp "${gzPath}" s3://${bucket}/${DEST}/index.wasm ` +
          `--region ${region} --cache-control "public, max-age=31536000, immutable" ` +
          `--content-type "application/wasm" --content-encoding "gzip"`
      );
    } finally { try { unlinkSync(gzPath); } catch { /* best-effort */ } }
  }
}

// Orphan-shim cleanup: if the obfuscator self-healed the shim away, drop the
// stale S3 copy so a cached old HTML can't load it and scramble the key.
if (!dryRun && !existsSync(shimPath)) {
  try { execSync(`aws s3 rm s3://${bucket}/${DEST}/pck-key-shim.js --region ${region}`, { stdio: "inherit" }); }
  catch { /* absent is the steady state */ }
}

// --- 3. sync the zone packs -> godot/beta-debug/packs/ -----------------
// Plain-named packs only (Laria.pck, Overworld.pck). The manifest is
// authoritative; fall back to a plain-.pck glob if it lists none.
let packNames = packEntries.map((p) => p.path);
if (packNames.length === 0 && existsSync(packsDir))
  packNames = readdirSync(packsDir).filter((f) => f.endsWith(".pck"));
if (packNames.length === 0) {
  console.warn("[push-beta-debug] ⚠ no packs listed/found — beta feature (Laria→Overworld) will dead-end.");
} else {
  console.log(`[push-beta-debug] uploading ${packNames.length} pack(s) -> ${DEST}/packs/`);
  for (const name of packNames) {
    const src = join(packsDir, name);
    if (!existsSync(src)) die(`pack listed but missing on disk: ${src}`);
    run(
      `aws s3 cp "${src}" s3://${bucket}/${DEST}/packs/${name} ` +
        `--region ${region} --cache-control "public, max-age=31536000, immutable"`
    );
  }
}

// --- 4. invalidate ONLY /godot/beta-debug/* ----------------------------
function distributionId() {
  if (process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID) return process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID;
  try {
    const id = capture(
      `aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} ` +
        `--query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text`
    );
    if (id && id !== "None") return id;
  } catch { /* fall through */ }
  return null;
}
const dist = distributionId();
if (!dist) {
  console.warn(`[push-beta-debug] ⚠ CloudFront distribution ID not resolved — run manually:\n  aws cloudfront create-invalidation --distribution-id <ID> --paths "/${DEST}/*"`);
} else {
  run(`aws cloudfront create-invalidation --distribution-id ${dist} --paths "/${DEST}/*"`);
}

// --- 5. flip gameVersions.ts beta-debug available:true (first success) --
const gvPath = join(root, "src", "lib", "gameVersions.ts");
if (existsSync(gvPath)) {
  const gv = readFileSync(gvPath, "utf8");
  const betaDebugLine = /(\{\s*id:\s*"beta-debug".*?available:\s*)false(\s*\})/s;
  if (betaDebugLine.test(gv)) {
    if (dryRun) {
      console.log("[dry-run] would flip gameVersions.ts beta-debug available:false -> true");
    } else {
      writeFileSync(gvPath, gv.replace(betaDebugLine, "$1true$2"));
      console.log(
        "\n[push-beta-debug] ✅ flipped gameVersions.ts beta-debug available:true.\n" +
        "  → COMMIT + PUSH this so the frontend redeploys and the version picker offers it.\n" +
        "    (Until then the assets are live at /godot/beta-debug/ but not selectable in /play.)"
      );
    }
  } else {
    console.log("[push-beta-debug] gameVersions.ts beta-debug already available:true (or format changed) — no flip.");
  }
}

console.log(`\n[push-beta-debug] ✅ deployed ${version} to /${DEST}/${dryRun ? " (dry run — nothing uploaded)" : ""}.`);
