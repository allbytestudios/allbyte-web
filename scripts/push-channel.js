#!/usr/bin/env node
/**
 * push-channel.js — the single, channel-driven deployer for every game build.
 *
 * All five builds deploy the same way; the only real difference between them is
 * an export flag (debug on/off, content tier — the Godot `custom_features`).
 * The target PATH for each channel is read from src/lib/gameVersions.ts (the
 * single source of truth), so this script never hardcodes paths:
 *
 *   alpha        -> /godot/public/    (on-demand, live)      --promote
 *   alpha-debug  -> /godot/           (on-demand, live)      --promote
 *   beta         -> /godot/beta/      (on-demand, live)      --promote
 *   beta-debug   -> /godot/beta-debug/(on-demand, dev)
 *   develop      -> /godot/develop/   (AUTO, every build)
 *
 * Invocation:  node push-channel.js --manifest <build_manifest.json> [--promote]
 * Contract: CON_CLAUDE_BETA_DEBUG_PIPELINE_CONTRACT.md (retargeted to develop).
 *
 * SAFETY — the auto lane can't clobber the live game. `develop` fires on every
 * Arc build, unattended. Deploying a LIVE/player-facing channel (alpha,
 * alpha-debug, beta) therefore REQUIRES an explicit `--promote`; the dev
 * channels (develop, beta-debug) deploy freely. The auto pipeline never passes
 * --promote, so the worst a bad develop build can do is break /godot/develop/,
 * which only admin/Legend can select.
 *
 * Live deploys (--promote) additionally stamp sw.js (stale-cache-hang guard) and
 * run the post-deploy smoke; dev channels carry their own ?v= and skip both.
 *
 * Defense in depth (the game-side pipeline already enforces these): refuse if
 * test_gate != "pass" or mixed_build == true, and verify sha256 of the base pck
 * + every pack before upload.
 *
 * Non-interactive, env-credentialed, idempotent; the caller serializes runs.
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
const publicDir = join(root, "public");
const gvPath = join(root, "src", "lib", "gameVersions.ts");

const bucket = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const region = process.env.AWS_REGION || "us-east-1";
const stackName = process.env.CLOUDFORMATION_STACK || "allbyte-studio-site";
const dryRun = process.argv.includes("--dry-run");
const promote = process.argv.includes("--promote");

// Dev channels deploy freely; every other (live/player-facing) channel needs --promote.
const DEV_CHANNELS = new Set(["develop", "beta-debug"]);

function die(msg) { console.error(`[push-channel] ERROR: ${msg}`); process.exit(1); }
function run(cmd) {
  if (dryRun) { console.log(`[dry-run] ${cmd}`); return; }
  console.log(`> ${cmd}`); execSync(cmd, { stdio: "inherit" });
}
function capture(cmd) { return execSync(cmd, { encoding: "utf8" }).trim(); }
function sha256(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

// Channel -> S3 dest, parsed from gameVersions.ts (source of truth for paths).
function channelDestMap() {
  if (!existsSync(gvPath)) die(`gameVersions.ts not found: ${gvPath}`);
  const gv = readFileSync(gvPath, "utf8");
  const map = {};
  const re = /\{\s*id:\s*"([^"]+)"[^}]*?path:\s*"([^"]+)"/g;
  let m;
  while ((m = re.exec(gv))) {
    // "/godot/public/index.html" -> "godot/public"; "/godot/index.html" -> "godot"
    map[m[1]] = m[2].replace(/^\//, "").replace(/\/index\.html$/, "");
  }
  return map;
}

// --- args + manifest ---------------------------------------------------
const mi = process.argv.indexOf("--manifest");
if (mi === -1 || !process.argv[mi + 1]) die("missing --manifest <path>");
const manifestPath = process.argv[mi + 1];
if (!existsSync(manifestPath)) die(`manifest not found: ${manifestPath}`);
let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
catch (e) { die(`manifest is not valid JSON: ${e.message}`); }

// --- channel resolution + promote guard --------------------------------
const channel = manifest.channel;
if (!channel || !/^[a-z0-9-]+$/.test(channel)) die(`manifest channel '${channel}' missing or not a safe slug`);
const DESTS = channelDestMap();
const DEST = DESTS[channel];
if (!DEST) die(`channel '${channel}' is not a known build in gameVersions.ts (${Object.keys(DESTS).join(", ")})`);
const isLive = !DEV_CHANNELS.has(channel);
if (isLive && !promote)
  die(`channel '${channel}' is a LIVE/player-facing build (${"/" + DEST + "/"}). Pass --promote to deploy it — the auto lane never does, so it can't clobber the live game.`);

// --- gate checks (defense in depth) ------------------------------------
if (manifest.test_gate !== "pass") die(`test_gate is '${manifest.test_gate}', refusing (only 'pass' deploys)`);
if (manifest.mixed_build === true) die("mixed_build=true (base/packs mtime skew) — refusing (stale-SW risk)");

const baseDir = dirname(manifestPath);            // …/export/<variant>/
const packsDir = join(dirname(baseDir), "packs"); // …/export/packs/
const version = manifest.version || "(unstamped)";
console.log(`\n[push-channel] channel=${channel}${isLive ? " (LIVE, --promote)" : ""} deploying ${version} -> s3://${bucket}/${DEST}/${dryRun ? "  (DRY RUN)" : ""}`);

// --- sha256 verification -----------------------------------------------
function verify(path, expected, label) {
  if (!existsSync(path)) die(`${label} missing on disk: ${path}`);
  if (!expected) { console.log(`[push-channel] (no sha256 for ${label}; skipping verify)`); return; }
  const got = sha256(path);
  if (got !== expected) die(`sha256 mismatch for ${label}: manifest ${expected.slice(0,12)}… vs disk ${got.slice(0,12)}…`);
  console.log(`[push-channel] sha256 OK — ${label}`);
}
const basePck = join(baseDir, (manifest.base && manifest.base.path) || "index.pck");
verify(basePck, manifest.base && manifest.base.sha256, "base index.pck");
const packEntries = (manifest.packs || []).map((p) => (typeof p === "string" ? { path: p } : p));
for (const p of packEntries) verify(join(packsDir, p.path), p.sha256, `pack ${p.path}`);

// --- obfuscate the base build (idempotent) -----------------------------
const baseIndex = join(baseDir, "index.html");
const baseJs = join(baseDir, "index.js");
const baseWasm = join(baseDir, "index.wasm");
const shimPath = join(baseDir, "pck-key-shim.js");
if (!existsSync(baseIndex)) die(`base index.html missing: ${baseIndex}`);
if (process.env.SKIP_GODOT_OBFUSCATION === "1") {
  console.log("[push-channel] SKIP_GODOT_OBFUSCATION=1 — shipping base verbatim.");
} else if (!dryRun) {
  console.log("[push-channel] running Godot key obfuscator on base build...");
  const obf = `node "${join(root, "scripts", "obfuscate-godot-export.js")}" "${baseDir}"`;
  const runObf = () => execSync(obf, { stdio: ["ignore", "inherit", "pipe"], encoding: "utf8" });
  try { runObf(); }
  catch (e) {
    // Self-heal the one recoverable refusal: the game-side pipeline obfuscated,
    // then re-exported the WASM, orphaning the shim (stale SHA marker). This env
    // has the key, so the obfuscator's own prescribed fix — delete the shim and
    // re-obfuscate the fresh export — is safe and deterministic. Any OTHER
    // refusal (missing key, etc.) still hard-aborts.
    const msg = String((e && e.stderr) || "") + String((e && e.stdout) || "");
    const staleShim = /re-exported after obfuscation|different WASM|Delete pck-key-shim\.js/.test(msg);
    if (staleShim && existsSync(shimPath)) {
      console.log("[push-channel] stale shim (re-export after obfuscation) — deleting shim + re-obfuscating once...");
      try { unlinkSync(shimPath); } catch { /* best-effort */ }
      try { runObf(); }
      catch { die("obfuscator still refused after stale-shim recovery — aborting (nothing uploaded)."); }
    } else {
      die("obfuscator refused — fix local state per its message; aborting (nothing uploaded).");
    }
  }
} else { console.log(`[dry-run] node scripts/obfuscate-godot-export.js "${baseDir}"`); }

if (!dryRun && existsSync(baseJs) && !/\.wasm\?v=/.test(readFileSync(baseJs, "utf8")))
  die("base index.js is MISSING the .wasm?v= cache-bust — refusing (stale-cache mismatch risk).");
if (!dryRun) {
  const shimExists = existsSync(shimPath);
  const htmlRefsShim = readFileSync(baseIndex, "utf8").includes("pck-key-shim.js");
  if (shimExists !== htmlRefsShim)
    die(`shim/HTML mismatch — shim ${shimExists ? "exists" : "missing"}, index.html ${htmlRefsShim ? "references" : "does not reference"} it; refusing.`);
}

// --- sync base + wasm + packs -> /godot/<DEST>/ ------------------------
run(
  `aws s3 sync "${baseDir}" s3://${bucket}/${DEST} --region ${region} ` +
    `--cache-control "public, max-age=31536000, immutable" ` +
    `--exclude "index.html" --exclude "index.wasm" ` +
    `--exclude "build_manifest.json" --exclude "DEPLOY_READY" ` +
    `--exclude "*.gz" --exclude ".gitkeep" --exclude "packs/*"`
);
run(`aws s3 cp "${baseIndex}" s3://${bucket}/${DEST}/index.html --region ${region} --cache-control "public, max-age=0, must-revalidate" --content-type "text/html"`);
if (existsSync(baseWasm)) {
  const gzPath = `${baseWasm}.gz`;
  if (dryRun) console.log(`[dry-run] gzip + upload ${baseWasm} -> s3://${bucket}/${DEST}/index.wasm`);
  else {
    writeFileSync(gzPath, gzipSync(readFileSync(baseWasm), { level: 9 }));
    try { run(`aws s3 cp "${gzPath}" s3://${bucket}/${DEST}/index.wasm --region ${region} --cache-control "public, max-age=31536000, immutable" --content-type "application/wasm" --content-encoding "gzip"`); }
    finally { try { unlinkSync(gzPath); } catch { /* best-effort */ } }
  }
}
if (!dryRun && !existsSync(shimPath)) {
  try { execSync(`aws s3 rm s3://${bucket}/${DEST}/pck-key-shim.js --region ${region}`, { stdio: "inherit" }); } catch { /* absent is fine */ }
}
let packNames = packEntries.map((p) => p.path);
if (packNames.length === 0 && existsSync(packsDir)) packNames = readdirSync(packsDir).filter((f) => f.endsWith(".pck"));
if (packNames.length === 0) console.warn("[push-channel] ⚠ no packs — zone content will dead-end.");
else {
  console.log(`[push-channel] uploading ${packNames.length} pack(s) -> ${DEST}/packs/`);
  for (const name of packNames) {
    const src = join(packsDir, name);
    if (!existsSync(src)) die(`pack listed but missing on disk: ${src}`);
    run(`aws s3 cp "${src}" s3://${bucket}/${DEST}/packs/${name} --region ${region} --cache-control "public, max-age=31536000, immutable"`);
  }
}

// --- sw.js stamp — LIVE channels only (stale-cache-hang guard) ---------
if (isLive) {
  const swSrc = join(publicDir, "sw.js");
  const versionFile = join(root, "src", "data", "game-version.json");
  if (existsSync(swSrc) && existsSync(versionFile)) {
    const swVer = JSON.parse(readFileSync(versionFile, "utf8")).version;
    if (swVer) {
      if (dryRun) console.log(`[dry-run] stamp sw.js with ${swVer} -> s3://${bucket}/sw.js`);
      else {
        const swTmp = join(publicDir, "sw.js.deploy");
        writeFileSync(swTmp, readFileSync(swSrc, "utf8").replaceAll("__BUILD_VERSION__", swVer));
        try { run(`aws s3 cp "${swTmp}" s3://${bucket}/sw.js --region ${region} --cache-control "no-cache, max-age=0, must-revalidate" --content-type "application/javascript"`); }
        finally { try { unlinkSync(swTmp); } catch { /* best-effort */ } }
        try {
          if (execSync(`git status --porcelain "${versionFile}"`, { encoding: "utf8" }).trim())
            console.warn(`\n[push-channel] ⚠ game-version.json (${swVer}) is UNCOMMITTED — commit it or the next webapp CI deploy reverts sw.js to the stale version.\n`);
        } catch { /* not a git checkout */ }
      }
    }
  }
}

// --- publish availability at RUNTIME (channels.json) — no source flip/commit -
// Merge this channel into s3://…/godot/channels.json so the frontend picks it
// up live (fetched in BilateralLayout). GET-modify-PUT; the file is tiny and the
// caller serializes runs, so there's no lost-update race. This is what keeps
// every deploy fully agent-free: a push self-publishes its own availability —
// no gameVersions.ts flip, no commit, no rebuild.
{
  const chKey = "godot/channels.json";
  const tmp = join(baseDir, "_channels.json");
  let channels = {};
  if (!dryRun) {
    try {
      execSync(`aws s3 cp s3://${bucket}/${chKey} "${tmp}" --region ${region}`, { stdio: "ignore" });
      channels = JSON.parse(readFileSync(tmp, "utf8"));
    } catch { channels = {}; /* first publish */ }
  }
  channels[channel] = { version, gitSha: manifest.git_sha || null, deployedAt: manifest.created || null };
  if (dryRun) {
    console.log(`[dry-run] merge channels.json { ${channel}: ${version} } -> s3://${bucket}/${chKey}`);
  } else {
    writeFileSync(tmp, JSON.stringify(channels));
    try { run(`aws s3 cp "${tmp}" s3://${bucket}/${chKey} --region ${region} --cache-control "no-cache, max-age=0, must-revalidate" --content-type "application/json"`); }
    finally { try { unlinkSync(tmp); } catch { /* best-effort */ } }
    console.log(`[push-channel] published ${channel} in channels.json — frontend shows it live, no commit needed.`);
  }
}

// --- invalidate this channel's path + channels.json (+ /play,/sw.js live) --
function distributionId() {
  if (process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID) return process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID;
  try {
    const id = capture(`aws cloudformation describe-stacks --stack-name ${stackName} --region ${region} --query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" --output text`);
    if (id && id !== "None") return id;
  } catch { /* fall through */ }
  return null;
}
const paths = [`/${DEST}/*`, "/godot/channels.json"];
if (isLive) { paths.push("/play/*"); paths.push("/sw.js"); }
const dist = distributionId();
if (!dist) console.warn(`[push-channel] ⚠ distribution ID not resolved — invalidate manually: ${paths.join(" ")}`);
else run(`aws cloudfront create-invalidation --distribution-id ${dist} --paths ${paths.map((p) => `"${p}"`).join(" ")}`);

// --- post-deploy smoke — LIVE channels only ----------------------------
if (isLive && !dryRun && process.env.SKIP_SMOKE !== "1" && existsSync(join(root, "scripts", "smoke_prod.py"))) {
  console.log("\n[push-channel] waiting 5s for CloudFront, then running post-deploy smoke...");
  try { execSync("node -e \"setTimeout(()=>{},5000)\"", { stdio: "ignore" }); execSync(`python "${join(root, "scripts", "smoke_prod.py")}"`, { stdio: "inherit" }); }
  catch { console.error("\n[push-channel] SMOKE FAILED — deploy is live but the engine isn't booting cleanly. Investigate."); process.exitCode = 1; }
}

console.log(`\n[push-channel] ✅ deployed ${channel} ${version} to /${DEST}/${dryRun ? " (dry run — nothing uploaded)" : ""}.`);
