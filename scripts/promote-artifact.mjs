#!/usr/bin/env node
/**
 * promote-artifact.mjs — ship the bytes QA attested, by COPYING them.
 *
 * WHY THIS EXISTS (DEV_PIPELINE open item #3, the blocker for the Arc-drivable
 * loop): `promote-prod.mjs` does not promote an artifact — it starts a
 * CodeBuild with no `--source-version`, and that project's default source is the
 * `develop` BRANCH. So it builds develop HEAD *at promote time*. Two gaps, and
 * either one on its own makes a QA gate theatre:
 *
 *   NOT PINNED — if develop advances between QA passing and the promote, prod
 *   ships code nobody tested. Today's 0.8.2840 promote was safe only because a
 *   human manually checked the tree matched the tested sha, which is exactly
 *   the trust-based step this pipeline is meant to delete.
 *
 *   A REBUILD IS NOT THE ATTESTED BYTES — even pinned to the right commit, a
 *   fresh export can differ (toolchain, pipeline). QA greens bytes B; prod
 *   ships B′. The attestation would be about something that never shipped.
 *
 * So this promotes by copying an already-published, already-attested artifact
 * from its immutable /godot/dev/<sha>/ prefix to the live prefix. CodeBuild
 * keeps producing candidates; it no longer decides what ships.
 *
 * THE GATE IS THE ARGUMENT. Promotion is bound to `artifact_sha256` — the
 * publisher's canonical digest over every published byte — and refuses unless
 * an attestation exists for exactly that digest. You cannot promote bytes
 * nobody QA'd, because the digest is what the gate keys on.
 *
 * KNOWN v1 LIMITATION, stated rather than hidden: this copies into the live
 * mutable prefix, so a player mid-download during the copy can still see a
 * half-swapped build. Assets are written BEFORE index.html to make that window
 * as small as possible, but it is not zero. The real fix is the v2
 * immutable-pointer promotion; this is sequencing, not a claim that the window
 * is acceptable.
 *
 *   node scripts/promote-artifact.mjs --build <git-sha> [--dry-run]
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { evaluate, GATE } from "./lib/attestation.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const BUCKET = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const LIVE_PREFIX = process.env.LIVE_PREFIX || "godot/public/";
const ATTEST_DIR =
  process.env.ATTESTATION_DIR ||
  join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "attestations");

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const val = (f) => { const i = argv.indexOf(`--${f}`); return i === -1 ? null : argv[i + 1] ?? null; };
const DRY = has("dry-run");
const JSON_ONLY = has("json");

const started = new Date().toISOString();
const log = (...a) => { if (!JSON_ONLY) console.log("[promote-artifact]", ...a); };

function finish(reason, message, extra = {}) {
  const ok = reason === "OK" || reason === "OK_DRY_RUN";
  const out = { ok, reason, message, startedAt: started, finishedAt: new Date().toISOString(), ...extra };
  if (JSON_ONLY) console.log(JSON.stringify(out, null, 2));
  else console.log(`[promote-artifact] ${ok ? "OK" : "FAILED"} — ${reason}: ${message}`);
  process.exit(ok ? 0 : 1);
}

function aws(args) {
  return execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/**
 * Cache policy for the LIVE prefix, matching what prod already serves — read
 * off the live objects rather than invented, because changing it is how you
 * produce the stale-cache hang this project has already shipped once.
 *
 * `immutable` is correct for the assets ONLY because index.html references them
 * with a per-release `?v=<hash>`, so their URLs change every release (verified:
 * prod serves ?v=e21dfb62…, the 0.8.2841 candidate ?v=3cf62c13…). index.html
 * itself is at a mutable URL and must revalidate, or returning players keep
 * pointing at the previous release's assets forever.
 */
const IMMUTABLE = "public, max-age=31536000, immutable";
const REVALIDATE = "public, max-age=0, must-revalidate";
function policyFor(key) {
  if (key.endsWith(".html")) return { cc: REVALIDATE, ct: "text/html" };
  if (key.endsWith(".wasm")) return { cc: IMMUTABLE, ct: "application/wasm" };
  if (key.endsWith(".js")) return { cc: IMMUTABLE, ct: "text/javascript" };
  if (key.endsWith(".json")) return { cc: "no-cache, max-age=0, must-revalidate", ct: "application/json" };
  if (key.endsWith(".png")) return { cc: IMMUTABLE, ct: "image/png" };
  if (key.endsWith(".pck")) return { cc: IMMUTABLE, ct: "binary/octet-stream" };
  return { cc: IMMUTABLE, ct: null };
}

// --- 1. resolve the source artifact and its sealed identity -----------------
const buildSha = val("build");
if (!buildSha || !/^[0-9a-f]{40}$/.test(buildSha)) {
  finish("E_ARGS", "need --build <40-hex git sha> naming a published dev artifact");
}
const srcPrefix = `godot/dev/${buildSha}/`;

let receipt;
try {
  receipt = JSON.parse(aws(["s3", "cp", `s3://${BUCKET}/${srcPrefix}receipt.json`, "-"]));
} catch {
  finish("E_NO_SEAL", `no sealed receipt at s3://${BUCKET}/${srcPrefix}receipt.json — that sha was never published, or its publish did not complete`);
}
const artifactSha256 = receipt.artifact_sha256;
if (!artifactSha256) {
  finish("E_NO_DIGEST", "the sealed receipt predates artifact_sha256 — republish this build before promoting it (the gate has nothing to key on)");
}
log(`source   ${srcPrefix}`);
log(`version  ${receipt.version}`);
log(`artifact ${artifactSha256.slice(0, 16)}…`);

// --- 2. THE GATE ------------------------------------------------------------
// Refuses unless an attestation exists for exactly these bytes. Every refusal
// names which condition failed — "no attestation", "wrong suite" and "a check
// is red" want very different responses from whoever is promoting.
const attestRoot = join(ATTEST_DIR, artifactSha256);
if (!existsSync(attestRoot)) {
  finish("E_NO_ATTESTATION", `no QA attestation for artifact ${artifactSha256.slice(0, 16)}… — nothing has established these bytes are prod-eligible. Looked in ${attestRoot}`);
}
const records = [];
for (const suite of readdirSync(attestRoot)) {
  const dir = join(attestRoot, suite);
  if (!statSync(dir).isDirectory()) continue;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try { records.push({ file: join(dir, f), rec: JSON.parse(readFileSync(join(dir, f), "utf8")) }); }
    catch { /* unreadable record is not evidence; the refusal below names it */ }
  }
}
if (records.length === 0) {
  finish("E_NO_ATTESTATION", `attestation directory exists but holds no readable records: ${attestRoot}`);
}
// Newest first: a later run supersedes an earlier one (a re-run after a fix, or
// a waiver added). Evaluate all; take the first that authorises.
records.sort((a, b) => String(b.rec.created_at).localeCompare(String(a.rec.created_at)));
let authorised = null;
const refusals = [];
for (const r of records) {
  const v = evaluate(r.rec, artifactSha256);
  if (v.ok) { authorised = { ...v, file: r.file, rec: r.rec }; break; }
  refusals.push(`${r.file.split(/[\\/]/).pop()}: ${v.reason} — ${v.detail}`);
}
if (!authorised) {
  finish("E_GATE", `no attestation authorises this artifact (${records.length} examined): ${refusals.slice(0, 3).join(" | ")}`, { refusals });
}
log(`gate     PASS — ${authorised.detail}`);
for (const w of authorised.waived) log(`  WAIVED: ${w.check_id} — ${w.signoff}`);

// --- 3. enumerate the source objects ----------------------------------------
let keys = [];
try {
  const out = aws(["s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", srcPrefix,
                   "--query", "Contents[].Key", "--output", "json"]);
  keys = (JSON.parse(out) || []).filter((k) => !k.endsWith("/receipt.json"));
} catch (e) {
  finish("E_LIST", `could not list ${srcPrefix}: ${String(e.message || e).split("\n")[0]}`);
}
if (keys.length === 0) finish("E_EMPTY", `no objects under ${srcPrefix}`);

// index.html LAST. It is the document that points at every other file, so if it
// lands first a player loading mid-copy gets a manifest referencing assets that
// are not there yet. Assets first means the worst case is a player briefly
// getting the OLD index.html with the old assets still present — a consistent
// pair, rather than a broken one.
const htmlKeys = keys.filter((k) => k.endsWith(".html"));
const assetKeys = keys.filter((k) => !k.endsWith(".html"));
const ordered = [...assetKeys, ...htmlKeys];

log(`objects  ${ordered.length} (${assetKeys.length} assets, then ${htmlKeys.length} html)`);

if (DRY) {
  finish("OK_DRY_RUN", `would copy ${ordered.length} object(s) ${srcPrefix} → ${LIVE_PREFIX} (gate PASS, ${authorised.waived.length} waived)`, {
    artifact_sha256: artifactSha256, version: receipt.version,
    attestation: authorised.file, waived: authorised.waived, objects: ordered.length,
  });
}

// --- 4. server-side copy ----------------------------------------------------
// S3-to-S3: the bytes never transit this machine, so there is nothing for a
// flaky local link to corrupt, and a 171MB artifact does not cost an upload.
// --metadata-directive REPLACE because the destination's cache policy differs
// from the immutable per-sha source: the live index.html MUST revalidate.
let copied = 0;
for (const key of ordered) {
  const rel = key.slice(srcPrefix.length);
  const dest = `${LIVE_PREFIX}${rel}`;
  const { cc, ct } = policyFor(rel);
  const args = ["s3", "cp", `s3://${BUCKET}/${key}`, `s3://${BUCKET}/${dest}`,
                "--metadata-directive", "REPLACE", "--cache-control", cc,
                "--checksum-algorithm", "SHA256", "--only-show-errors"];
  if (ct) args.push("--content-type", ct);
  try { aws(args); copied++; }
  catch (e) {
    finish("E_COPY", `copy failed at ${rel} after ${copied}/${ordered.length} — the live prefix is now MIXED and must not be left this way: ${String(e.message || e).split("\n")[0]}`, {
      artifact_sha256: artifactSha256, copied, total: ordered.length, failedAt: rel,
    });
  }
  if (copied % 5 === 0) log(`  copied ${copied}/${ordered.length}`);
}
log(`copied   ${copied}/${ordered.length}`);

// --- 5. verify the destination ----------------------------------------------
// The copy reporting success is not the same as the destination holding the
// right bytes. Compare each destination object's stored checksum against the
// source's — both were written with --checksum-algorithm, so this is S3's own
// accounting on both ends rather than anything this script computed.
const mismatches = [];
for (const key of ordered) {
  const rel = key.slice(srcPrefix.length);
  const dest = `${LIVE_PREFIX}${rel}`;
  const read = (k) => {
    try {
      return JSON.parse(aws(["s3api", "head-object", "--bucket", BUCKET, "--key", k,
                             "--checksum-mode", "ENABLED",
                             "--query", "{sum:ChecksumSHA256,len:ContentLength}", "--output", "json"]));
    } catch { return null; }
  };
  const d = read(dest);
  if (!d) { mismatches.push(`${rel}: destination missing`); continue; }
  const s = read(key);
  if (s && s.sum && d.sum && s.sum !== d.sum) mismatches.push(`${rel}: checksum ${s.sum} → ${d.sum}`);
  else if (s && s.len !== d.len) mismatches.push(`${rel}: length ${s.len} → ${d.len}`);
}
if (mismatches.length) {
  finish("E_VERIFY_DEST", `destination does not match source for ${mismatches.length} object(s) — prod may be serving a mixed build: ${mismatches.slice(0, 4).join(" | ")}`, {
    artifact_sha256: artifactSha256, mismatches,
  });
}

finish("OK", `promoted ${receipt.version} (artifact ${artifactSha256.slice(0, 12)}…) — ${copied} objects copied and verified`, {
  artifact_sha256: artifactSha256,
  version: receipt.version,
  source: `s3://${BUCKET}/${srcPrefix}`,
  destination: `s3://${BUCKET}/${LIVE_PREFIX}`,
  attestation: authorised.file,
  waived: authorised.waived,
  objects: copied,
});
