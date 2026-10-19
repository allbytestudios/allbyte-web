#!/usr/bin/env node
/**
 * publish-dev-build.js — publish a LOCAL Godot web export to an immutable
 * per-sha QA path on S3.
 *
 *   node scripts/publish-dev-build.js [--manifest <build_manifest.json>]
 *                                     [--dry-run] [--force] [--json]
 *   npm run publish:dev
 *
 * WHY THIS EXISTS
 * QA used to drive a local host window on :4325 against a separately-published
 * debug artifact pinned by a per-pack hash manifest. A single mid-import window
 * teardown could deadlock the lane, and a redeploy under a running session made
 * the pin disagree with the serving path. Serving an IMMUTABLE path per game sha
 * removes both: the bytes behind a sha never change, so a QA run that pins one
 * cannot observe another.
 *
 * WHAT IT IS NOT
 * There is no model in this loop. It is a script with fixed gates and stable
 * exit codes so that Arc, a human, or another script can all read the outcome
 * the same way. Every failure writes the same receipt shape with a `reason`
 * code — "failed for reason xyz" without parsing logs.
 *
 * ORDER MATTERS (two non-obvious constraints):
 *  1. sha256 verification runs BEFORE obfuscation, because the obfuscator
 *     rewrites index.wasm and index.html and would invalidate the manifest
 *     hashes it is being checked against.
 *  2. Obfuscation happens at PUBLISH, never at promote. The mask is random per
 *     release, so re-obfuscating later would hand players different bytes than
 *     QA signed off — the one property this whole pipeline exists to guarantee.
 */
import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, posix } from "node:path";
import { homedir } from "node:os";
import { verifyUploaded, CHUNK } from "./lib/s3-verify.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

const BUCKET = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const SITE = process.env.SITE_ORIGIN || "https://allbyte.studio";
const EXPORT_ROOT =
  process.env.EXPORT_ROOT ||
  join(homedir(), "Desktop", "GameDev", "ChroniclesOfNesis", "WebBootstrap", "export");
// Shared host<->container mount, so Arc can read the outcome over the
// filesystem and never needs AWS credentials of any kind.
const RECEIPT_DIR =
  process.env.DEV_BUILD_RECEIPTS ||
  join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "dev-builds");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => { const i = argv.indexOf(`--${f}`); return i === -1 ? null : argv[i + 1] ?? null; };
const DRY = has("dry-run");
const FORCE = has("force");
const JSON_ONLY = has("json");
const ALLOW_MIXED = has("allow-mixed-build");

const started = new Date().toISOString();
const log = (m) => { if (!JSON_ONLY) console.log(`[publish-dev] ${m}`); };

/** Every exit goes through here, so the receipt shape is identical on success and failure. */
function finish(reason, message, extra = {}) {
  const ok = reason === "OK" || reason === "OK_ALREADY";
  const receipt = {
    ok,
    status: reason === "OK" ? "published" : reason === "OK_ALREADY" ? "already-published" : "failed",
    reason,
    message,
    startedAt: started,
    finishedAt: new Date().toISOString(),
    publisher: "publish-dev-build.js@1",
    ...extra,
  };
  try {
    mkdirSync(RECEIPT_DIR, { recursive: true });
    // SEALED RECORDS vs ATTEMPT RECORDS (open item #1). Not the same thing,
    // and they must not share a filename. Every outcome used to overwrite
    // both <sha>.json and latest.json, so a FAILED run erased the record of a
    // SUCCESSFUL one — demonstrated while testing this change: a --force run
    // that correctly refused ("already sealed") wiped latest.json, taking
    // artifact_sha256 and the verified-object count with it. Arc reads
    // latest.json off the shared mount to learn what is published, so a
    // failure writing there tells him the opposite of the truth.
    const attemptsDir = join(RECEIPT_DIR, "attempts");
    mkdirSync(attemptsDir, { recursive: true });
    const stamp = receipt.finishedAt.replace(/[:.]/g, "-");
    const who = receipt.sha ? String(receipt.sha).slice(0, 8) : "no-sha";
    // Every attempt is recorded - this is the audit trail.
    writeFileSync(join(attemptsDir, `${stamp}-${who}-${reason}.json`), JSON.stringify(receipt, null, 2) + "\n");
    // Sealed records: success only, never clobbered by a later failure.
    if (ok) {
      if (receipt.sha) writeFileSync(join(RECEIPT_DIR, `${receipt.sha}.json`), JSON.stringify(receipt, null, 2) + "\n");
      writeFileSync(join(RECEIPT_DIR, "latest.json"), JSON.stringify(receipt, null, 2) + "\n");
    }
  } catch (e) {
    if (!JSON_ONLY) console.error(`[publish-dev] WARNING: could not write receipt: ${e.message}`);
  }
  if (JSON_ONLY) console.log(JSON.stringify(receipt, null, 2));
  else console.log(`[publish-dev] ${ok ? "OK" : "FAILED"} — ${reason}: ${message}`);
  process.exit(ok ? 0 : 1);
}

function sh(cmd) {
  return execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}
const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

function walk(dir, base = dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, base, out);
    else out.push(relative(base, full).split("\\").join("/"));
  }
  return out;
}

// --- 1. resolve the manifest ------------------------------------------------
let manifestPath = val("manifest");
if (!manifestPath) {
  if (!existsSync(EXPORT_ROOT)) finish("E_NO_MANIFEST", `export root not found: ${EXPORT_ROOT}`);
  const found = [];
  for (const name of readdirSync(EXPORT_ROOT)) {
    const mf = join(EXPORT_ROOT, name, "build_manifest.json");
    if (existsSync(mf)) found.push({ mf, mtime: statSync(mf).mtimeMs });
  }
  if (!found.length) finish("E_NO_MANIFEST", `no build_manifest.json under ${EXPORT_ROOT}`);
  found.sort((a, b) => b.mtime - a.mtime);
  manifestPath = found[0].mf;
  log(`resolved newest manifest: ${manifestPath}`);
}
if (!existsSync(manifestPath)) finish("E_NO_MANIFEST", `manifest not found: ${manifestPath}`);

let manifest;
try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); }
catch (e) { finish("E_BAD_MANIFEST", `manifest is not valid JSON: ${e.message}`, { manifest: manifestPath }); }

const buildDir = dirname(manifestPath);
const sha = String(manifest.git_sha || "").trim();
const version = String(manifest.version || "").trim();
if (!/^[0-9a-f]{7,40}$/.test(sha)) finish("E_NO_SHA", `manifest has no usable git_sha (got ${JSON.stringify(manifest.git_sha)})`, { manifest: manifestPath });

const ctx = { sha, version, manifest: manifestPath, buildDir };

// --- 2. integrity gates -----------------------------------------------------
// These are the SAME gates push-channel.js enforces. The immutable path removes
// the RUNTIME pin, not the need to prove the artifact is internally consistent:
// without these, QA can sign off a mixed build and promote hands it to players.
if (manifest.test_gate !== "pass")
  finish("E_TEST_GATE", `test_gate is '${manifest.test_gate}', refusing (only 'pass' publishes)`, ctx);
// mixed_build is mtime skew between the base and the packs. It cannot tell
// "a pack that should have been re-exported wasn't" from "a pack genuinely has
// not changed since spring" — and in this project the static content packs
// (Core, Combat, LariaVillage, LariaWaterways) legitimately have not changed in
// months, so a strict max-minus-min across ALL packs trips on a perfectly good
// build whose REQUIRED packs are fresh.
//
// So: still refuse by default, but allow an explicit, recorded override for a
// test candidate. The override is deliberately not available for anything that
// reaches players — this script only ever writes to godot/dev/, and a promote
// re-exports everything through CodeBuild. The decision lands in the receipt so
// it is auditable rather than remembered.
if (manifest.mixed_build === true) {
  const req = manifest.required_packs || [];
  const stale = (manifest.missing_packs || []).length || (manifest.invalid_hashes || []).length;
  if (!ALLOW_MIXED || stale) {
    finish("E_MIXED_BUILD",
      `mixed_build=true (${Math.round((manifest.skew_seconds || 0) / 86400)}d skew across packs${stale ? ", and packs are missing or hashes invalid" : ""})` +
      (stale ? " — refusing" : ` — required packs ${req.join(", ") || "(none declared)"}; pass --allow-mixed-build to publish anyway as a TEST candidate`),
      ctx);
  }
  log(`WARNING: publishing with mixed_build=true (${Math.round((manifest.skew_seconds || 0) / 86400)}d pack skew) — explicitly overridden`);
  ctx.mixedBuildOverridden = true;
}

// --- 3. verify the artifact against the manifest (BEFORE obfuscation) -------
const basePath = join(buildDir, (manifest.base && manifest.base.path) || "index.pck");
if (!existsSync(basePath)) finish("E_MISSING_FILE", `base pck missing: ${basePath}`, ctx);
if (manifest.base && manifest.base.sha256) {
  const got = sha256(basePath);
  if (got !== manifest.base.sha256)
    finish("E_SHA_MISMATCH", `base index.pck sha256 mismatch (manifest ${manifest.base.sha256.slice(0, 12)}… vs disk ${got.slice(0, 12)}…)`, ctx);
}
// Packs live BESIDE the build dir (…/export/packs/), not inside it — same
// resolution push-channel.js uses.
const packsDir = join(dirname(buildDir), "packs");
const packEntries = (manifest.packs || []).map((p) => (typeof p === "string" ? { path: p } : p));
for (const p of packEntries) {
  const pp = join(packsDir, p.path);
  if (!existsSync(pp)) finish("E_MISSING_FILE", `pack missing: ${pp}`, ctx);
  if (p.sha256 && sha256(pp) !== p.sha256)
    finish("E_SHA_MISMATCH", `pack sha256 mismatch: packs/${p.path}`, ctx);
}
log(`verified ${1 + (manifest.packs || []).length} artifact hashes against the manifest`);

// --- 4. dedupe on the completion marker, never on prefix existence ----------
// A half-finished upload leaves a populated prefix. Listing it would report the
// build as cached and the next run would pin a broken artifact, so the gate
// reads the receipt object that is written LAST.
const prefix = `godot/dev/${sha}/`;
const receiptKey = `${prefix}receipt.json`;
let alreadySealed = false;
try {
  sh(`aws s3api head-object --bucket ${BUCKET} --key ${receiptKey}`);
  alreadySealed = true;
} catch { /* not sealed → publish */ }
if (alreadySealed) {
  // Checked even under --force, and BEFORE the ~171MB upload rather than
  // letting the conditional PUT refuse at the end. --force exists to re-upload
  // a half-finished prefix; it is not a licence to replace a seal that an
  // attestation may already point at. Republishing stays deliberate and manual.
  if (FORCE) {
    finish("E_SEALED", `sha ${sha.slice(0, 8)} is already SEALED — --force re-uploads an incomplete prefix, it does not replace a seal. Delete s3://${BUCKET}/${receiptKey} deliberately to republish.`, {
      ...ctx, url: `${SITE}/${prefix}index.html`,
    });
  }
  finish("OK_ALREADY", `sha ${sha.slice(0, 8)} already published — skipping build upload`, {
    ...ctx, url: `${SITE}/${prefix}index.html`,
  });
}

if (DRY) {
  finish("OK", `dry-run: would publish ${version} (sha ${sha.slice(0, 8)}) from ${buildDir} to s3://${BUCKET}/${prefix}`, {
    ...ctx, url: `${SITE}/${prefix}index.html`, dryRun: true,
  });
}

// --- 5. obfuscate the script-encryption key (idempotent) --------------------
// The Godot 4 web export carries the script key as 32 contiguous bytes inside
// index.wasm. This path is as public as the player path, so syncing a raw
// export would publish the key at a guessable URL.
if (process.env.SKIP_GODOT_OBFUSCATION !== "1") {
  const obf = () => sh(`node "${join(ROOT, "scripts", "obfuscate-godot-export.js")}" "${buildDir}"`);
  const shimPath = join(buildDir, "pck-key-shim.js");
  try {
    obf();
    log("obfuscated base build (key no longer plaintext in index.wasm)");
  } catch (e) {
    // Self-heal exactly ONE refusal, the same one push-channel.js recovers:
    // the game pipeline obfuscated, then re-exported the WASM, so the old
    // shim's XOR mask no longer fits. The obfuscator itself prescribes the fix
    // (delete the shim, re-obfuscate the fresh export) and it is deterministic.
    // EVERY other refusal — missing key, unreadable WASM — still hard-aborts,
    // because the alternative is publishing a build whose key handling we do
    // not understand.
    const msg = String((e && e.stderr) || "") + String((e && e.stdout) || "") + String((e && e.message) || "");
    const staleShim = /re-exported after obfuscation|different WASM|Delete pck-key-shim\.js/.test(msg);
    if (staleShim && existsSync(shimPath)) {
      log("stale shim (re-export after obfuscation) — deleting shim and re-obfuscating once");
      try { unlinkSync(shimPath); } catch { /* best-effort */ }
      try { obf(); log("re-obfuscated after stale-shim recovery"); }
      catch (e2) {
        const d2 = String((e2 && e2.stderr) || e2.message || "").trim().split("\n").slice(-3).join(" | ");
        finish("E_OBFUSCATE", `obfuscator still refused after stale-shim recovery: ${d2}`, ctx);
      }
    } else {
      const detail = msg.trim().split("\n").slice(-3).join(" | ");
      finish("E_OBFUSCATE", `obfuscator refused: ${detail}`, ctx);
    }
  }
} else {
  log("WARNING: SKIP_GODOT_OBFUSCATION=1 — publishing the export verbatim");
}

// --- 6. upload --------------------------------------------------------------
// Immutable path: everything can carry a one-year cache, and nothing ever needs
// a CloudFront invalidation.
const IMMUTABLE = "public, max-age=31536000, immutable";
// --checksum-algorithm makes S3 STORE a SHA-256 we can read back; without
// it head-object returns nothing to compare and the verification below
// degrades to "the object exists", which is not verification.
// The chunk size is pinned because a multipart checksum is computed OVER THE
// PARTS: if the CLI split at a different size than we hash at, the composite
// would differ for bytes that are actually identical.
const SUMS = '--checksum-algorithm SHA256';
process.env.AWS_CLI_S3_MULTIPART_CHUNKSIZE = String(CHUNK);
try {
  // Godot leaves atomic-write temporaries next to the real artifacts
  // (index.pck-URyODt, Laria.pck-0zvMvy…). They are not needed at runtime and
  // each Laria copy is ~48MB, so uploading them would multiply both the
  // transfer and the stored size of every QA build.
  const excludes = `--exclude "packs/*" --exclude "*.gz" --exclude "*.pck-*" --exclude ".gitkeep"`;
  sh(`aws s3 sync "${buildDir}" "s3://${BUCKET}/${prefix}" --delete ${excludes} --only-show-errors ${SUMS} --cache-control "${IMMUTABLE}"`);
  // Packs are uploaded by NAME from the manifest, not by syncing the directory:
  // the manifest is the contract for which packs belong to this build, and the
  // directory holds other builds' packs and temporaries too.
  for (const p of packEntries) {
    sh(`aws s3 cp "${join(packsDir, p.path)}" "s3://${BUCKET}/${prefix}packs/${p.path}" --cache-control "${IMMUTABLE}" ${SUMS} --only-show-errors`);
  }
  // Content-type for .wasm decides whether the browser can streaming-compile;
  // set it explicitly rather than trusting the CLI's extension guess.
  const wasm = `${prefix}index.wasm`;
  sh(`aws s3 cp "s3://${BUCKET}/${wasm}" "s3://${BUCKET}/${wasm}" --metadata-directive REPLACE --content-type application/wasm --cache-control "${IMMUTABLE}" ${SUMS} --only-show-errors`);
} catch (e) {
  const detail = (e.stderr || e.message || "").toString().trim().split("\n").slice(-2).join(" | ");
  finish("E_UPLOAD", `upload failed: ${detail}`, ctx);
}

// --- 7. hash what was actually uploaded ------------------------------------
// This is the chain promote re-verifies before copying bytes to the live path,
// so "the bytes QA signed off are the bytes players got" is checkable rather
// than assumed. These are POST-obfuscation hashes and deliberately differ from
// the manifest's.
// Must mirror the upload exactly — the same exclusions, and packs resolved from
// their real location. A hash set that does not match what is on S3 would make
// promote's verification fail for the wrong reason.
const skip = (f) => f.startsWith("packs/") || f.endsWith(".gz") || /\.pck-[^/]+$/.test(f) || f === ".gitkeep";
const hashes = {};
let bytes = 0;
for (const f of walk(buildDir)) {
  if (skip(f)) continue;
  const full = join(buildDir, f);
  hashes[f] = sha256(full);
  bytes += statSync(full).size;
}
for (const p of packEntries) {
  const full = join(packsDir, p.path);
  hashes[`packs/${p.path}`] = sha256(full);
  bytes += statSync(full).size;
}
const files = Object.keys(hashes);

// --- 7b. ASK S3 WHAT IT ACTUALLY STORED (open item #2) ----------------------
// Everything above is LOCAL. A truncated or corrupted upload would be recorded
// with the healthy local file's hash and look perfect in the receipt — and the
// receipt is exactly what promote later trusts to decide "these are the bytes
// QA signed off". So every object is read back and compared.
//
// Deliberately BEFORE the canonical digest below: that digest is the identity
// QA attests and promote copies, so it must only ever describe bytes S3 has
// confirmed it is holding.
const verifyEntries = [
  ...files.filter((f) => !f.startsWith("packs/")).map((f) => ({ key: `${prefix}${f}`, path: join(buildDir, f) })),
  ...packEntries.map((pk) => ({ key: `${prefix}packs/${pk.path}`, path: join(packsDir, pk.path) })),
];
const verdict = verifyUploaded(BUCKET, verifyEntries);
if (!verdict.ok) {
  const detail = verdict.failures.slice(0, 4).map((f) => `${f.key} [${f.reason}] ${f.detail}`).join(" | ");
  finish("E_VERIFY", `S3 does not hold what we uploaded (${verdict.failures.length} of ${verifyEntries.length} failed) — NOT sealing: ${detail}`, {
    ...ctx, failures: verdict.failures,
  });
}
log(`verified ${verdict.checked} object(s) against S3's stored checksums`);

// --- 7c. canonical artifact identity ---------------------------------------
// The ONE value that names this artifact. The gate contract keys on it
// (attestation ↔ promote), and until now it did not exist: the receipt held a
// MAP of path→hash, which is not something another system can key on.
//
// Order-independent by construction (sorted), covers every published byte, and
// changes if any single file changes. NUL-separated so a path containing the
// separator cannot forge a different file set.
const NUL = String.fromCharCode(0);
const LF = String.fromCharCode(10);
const artifactSha256 = createHash("sha256")
  .update(files.slice().sort().map((f) => f + NUL + hashes[f] + LF).join(""))
  .digest("hex");

const receipt = {
  artifact_sha256: artifactSha256,
  verified_objects: verdict.checked,
  sha, version,
  url: `${SITE}/${prefix}index.html`,
  s3: `s3://${BUCKET}/${prefix}`,
  files: files.length,
  bytes,
  sha256: hashes,
  manifest: manifestPath,
  buildDir,
};
try {
  const tmp = join(RECEIPT_DIR, `.${sha}.s3.json`);
  mkdirSync(RECEIPT_DIR, { recursive: true });
  writeFileSync(tmp, JSON.stringify({ ok: true, status: "published", reason: "OK", ...receipt }, null, 2) + "\n");
  // Written LAST and alone: its presence is what marks the sha complete, and
  // promote reads it to learn which bytes QA attested.
  //
  // --if-none-match "*" is a true atomic create-if-absent (verified against
  // this bucket 2026-10-17: a second conditional PUT returns PreconditionFailed).
  // Two consequences, both wanted. RACE: two publishers of the same sha cannot
  // both seal — the loser is TOLD it lost rather than silently replacing a
  // receipt the winner published and QA may already have attested. OVERWRITE: a
  // sealed sha is immutable, because the seal is what an attestation points at.
  try {
    sh(`aws s3api put-object --bucket ${BUCKET} --key ${receiptKey} --body "${tmp}" --if-none-match "*" --content-type application/json --cache-control "no-cache" --checksum-algorithm SHA256 --query ETag --output text`);
  } catch (err) {
    const m = String((err && err.stderr) || (err && err.message) || "");
    if (/PreconditionFailed|pre-conditions/i.test(m)) {
      finish("E_SEALED", `sha ${sha.slice(0, 8)} was sealed by another publisher while this run was uploading — refusing to overwrite. The live artifact is the OTHER run's.`, {
        ...ctx, url: `${SITE}/${prefix}index.html`,
      });
    }
    throw err;
  }
} catch (e) {
  finish("E_RECEIPT", `uploaded, but the completion marker failed to write — treat this sha as INCOMPLETE: ${e.message}`, { ...ctx, ...receipt });
}

// --- 9. artifact index -------------------------------------------------------
// promote takes an artifact_sha256 — the bytes — not a git sha. But the S3 path
// is keyed by git sha, so without this there is no way to go from "the digest
// QA attested" back to "where those bytes live", and promote would be forced to
// accept a git sha instead. That would reintroduce the exact weakness this
// pipeline exists to remove: one git sha can produce many different artifacts
// (8f906e20 produced THREE distinct pcks on 2026-10-17).
//
// Written AFTER the seal, deliberately: the index may only ever point at bytes
// that are already sealed and verified. Not fatal if it fails — promote can
// still be driven by --build <git-sha> — so this warns rather than aborting a
// publish that otherwise succeeded.
try {
  const idx = join(RECEIPT_DIR, `.${artifactSha256}.idx.json`);
  writeFileSync(idx, JSON.stringify({ artifact_sha256: artifactSha256, git_sha: sha, version, prefix, sealed_at: new Date().toISOString() }, null, 2) + "\n");
  sh(`aws s3 cp "${idx}" "s3://${BUCKET}/godot/dev/by-artifact/${artifactSha256}.json" --content-type application/json --cache-control "no-cache" --only-show-errors`);
  log(`indexed artifact ${artifactSha256.slice(0, 12)}… -> ${prefix}`);
} catch (e) {
  log(`WARNING: artifact index not written (${e.message}) — promote by --build <git-sha> still works`);
}

finish("OK", `published ${version} (sha ${sha.slice(0, 8)}) — ${files.length} files, ${(bytes / 1e6).toFixed(1)} MB`, receipt);
