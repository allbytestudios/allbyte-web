#!/usr/bin/env node
/**
 * publish-deploy-manifest.js — mirrors Arc's deploy manifest to S3 so the
 * changelog generator can reach it from ANYWHERE, not just a machine with the
 * Chronicles repo checked out.
 *
 * WHY THIS EXISTS
 * ---------------
 * deploy-history.js builds /changelog/ by joining this repo's game-version.json
 * history against ChroniclesOfNesis/tickets/deploy_manifest.ndjson — a LOCAL
 * path. Live promotes are finalized by .github/workflows/finalize-demo.yml on a
 * GitHub runner, which has no Chronicles checkout, so the generator hit its
 * "manifest not found" branch, exited 0, and shipped releases with zero
 * changes. That silently ate every changelog entry from 2026-07-06 to 08-06.
 *
 * The manifest is also written from two places that can't see each other:
 *   - promote_to_staging.sh (in-container) appends to the local ndjson
 *   - release_channel.sh (CI/cloud cut) has NO git write-back to Chronicles
 * so neither copy is a superset. This publisher therefore MERGES rather than
 * overwrites: the S3 object is the union of every record either path has ever
 * produced. Feeding it a single new record or the whole local file are both
 * valid and both converge on the same answer.
 *
 * Dedupe key is `version`, but a collision MERGES rather than replaces: commits
 * are unioned by sha and the record-level fields come from the later builtAt.
 * Last-writer-wins would be wrong because one version can be emitted twice with
 * *disjoint* commit sets — the emitter derives its range from --prev-sha, which
 * resolves differently across environments, and staging is permanently-DEBUG so
 * public versions get re-cut. No duplicate version exists in the manifest today
 * (413 records, all unique); this is insurance against a silent drop, which is
 * the exact failure class that ate the July changelog.
 *
 *   node scripts/publish-deploy-manifest.js --records <file.ndjson> [--dry-run]
 *
 * Exit 0 = published (or dry-run). Non-zero = the input was unusable. Callers
 * treat a failure here as non-fatal: a missed mirror costs changelog freshness,
 * never a deploy.
 */

import { execSync } from "child_process";
import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const bucket = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const region = process.env.AWS_REGION || "us-east-1";
const KEY = "test-snapshot/tickets/deploy_manifest.ndjson";
const dryRun = process.argv.includes("--dry-run");

const die = (msg) => { console.error(`[publish-manifest] ERROR: ${msg}`); process.exit(1); };
const buildNum = (v) => parseInt(String(v).replace(/^v/, "").split(".").pop(), 10);

// Declared up here (not beside the merge) so hoisted mergeRecord can touch it
// from the self-test, which runs before the merge section.
let mergedCommits = 0;

// --- self-test (node scripts/publish-deploy-manifest.js --self-test) ---------
// The union rule guards against a silent commit drop, which by definition
// produces no error when it goes wrong — so it gets an actual test.
if (process.argv.includes("--self-test")) {
  const eq = (label, got, want) => {
    const a = JSON.stringify(got), b = JSON.stringify(want);
    if (a !== b) { console.error(`FAIL ${label}\n  got  ${a}\n  want ${b}`); process.exitCode = 1; }
    else console.log(`ok   ${label}`);
  };
  const c = (sha) => ({ sha, type: "fix", subject: sha });
  const A = { version: "v0.8.2314", builtAt: "2026-07-26T00:00:00Z", gitSha: "1c8d2e00", commits: [c("a1"), c("a2")] };
  const B = { version: "v0.8.2314", builtAt: "2026-07-28T13:54:21Z", gitSha: "e6ccd2e8", commits: [c("b1")] };

  // disjoint commit sets across a same-version re-cut: keep every commit
  eq("union keeps both sides", mergeRecord(A, B).commits.map((x) => x.sha), ["a1", "a2", "b1"]);
  // record-level fields follow the later builtAt, regardless of merge order
  eq("later builtAt wins (A,B)", mergeRecord(A, B).gitSha, "e6ccd2e8");
  eq("later builtAt wins (B,A)", mergeRecord(B, A).gitSha, "e6ccd2e8");
  // overlapping shas must not duplicate
  eq("dedupes by sha", mergeRecord(A, { ...B, commits: [c("a2"), c("b1")] }).commits.map((x) => x.sha), ["a1", "a2", "b1"]);
  // first publish: nothing to merge against
  eq("no prev is a passthrough", mergeRecord(undefined, B).commits.map((x) => x.sha), ["b1"]);
  console.log(process.exitCode ? "self-test FAILED" : "self-test passed");
  process.exit(process.exitCode || 0);
}

const ri = process.argv.indexOf("--records");
if (ri === -1 || !process.argv[ri + 1]) die("missing --records <path to ndjson>");
const recordsPath = process.argv[ri + 1];
if (!existsSync(recordsPath)) die(`records file not found: ${recordsPath}`);

// --- parse the incoming record(s) ------------------------------------------
// One record or the whole manifest — same code path, since the merge is a union.
const incoming = [];
for (const [i, line] of readFileSync(recordsPath, "utf8").split(/\r?\n/).entries()) {
  if (!line.trim()) continue;
  let rec;
  try { rec = JSON.parse(line); }
  catch (e) { die(`${recordsPath}:${i + 1} is not valid JSON: ${e.message}`); }
  if (!rec.version) die(`${recordsPath}:${i + 1} has no "version" — can't dedupe it`);
  if (!Number.isFinite(buildNum(rec.version))) die(`${recordsPath}:${i + 1} version '${rec.version}' has no numeric build component`);
  incoming.push(rec);
}
if (incoming.length === 0) die(`${recordsPath} contained no records`);

// --- merge with what's already published ------------------------------------
const tmp = join(tmpdir(), `_deploy_manifest_${process.pid}.ndjson`);
const merged = new Map();
let existingCount = 0;

// Same version emitted twice -> keep every commit either record saw. Record-level
// fields follow the later builtAt; commits union by sha, first-seen order.
function mergeRecord(prev, next) {
  if (!prev) return next;
  const seen = new Set();
  const commits = [];
  for (const c of [...(prev.commits || []), ...(next.commits || [])]) {
    if (c && c.sha && seen.has(c.sha)) continue;
    if (c && c.sha) seen.add(c.sha);
    commits.push(c);
  }
  const gained = commits.length - (next.commits || []).length;
  if (gained > 0) mergedCommits += gained;
  const newer = (next.builtAt || "") >= (prev.builtAt || "") ? next : prev;
  return { ...newer, commits };
}

if (!dryRun) {
  try {
    execSync(`aws s3 cp s3://${bucket}/${KEY} "${tmp}" --region ${region}`, { stdio: "ignore" });
    for (const line of readFileSync(tmp, "utf8").split(/\r?\n/)) {
      if (!line.trim()) continue;
      try {
        const rec = JSON.parse(line);
        if (rec.version) { merged.set(rec.version, rec); existingCount++; }
      } catch { /* skip a corrupt published line rather than lose the whole mirror */ }
    }
  } catch { /* first publish — nothing up there yet */ }
}

for (const rec of incoming) merged.set(rec.version, mergeRecord(merged.get(rec.version), rec));

const out = [...merged.values()].sort((a, b) => buildNum(a.version) - buildNum(b.version));
const added = out.length - existingCount;

if (dryRun) {
  console.log(`[publish-manifest] [dry-run] would merge ${incoming.length} record(s) into s3://${bucket}/${KEY}`);
  process.exit(0);
}

writeFileSync(tmp, out.map((r) => JSON.stringify(r)).join("\n") + "\n");
try {
  // no-cache: the generator must never read a stale mirror when cutting a release.
  execSync(
    `aws s3 cp "${tmp}" s3://${bucket}/${KEY} --region ${region} ` +
      `--cache-control "no-cache, max-age=0, must-revalidate" --content-type "application/x-ndjson"`,
    { stdio: "inherit" },
  );
} finally {
  try { unlinkSync(tmp); } catch { /* best-effort */ }
}

console.log(
  `[publish-manifest] published ${out.length} records to s3://${bucket}/${KEY} ` +
    `(${incoming.length} submitted, ${added} new, ${existingCount} already there` +
    `${mergedCommits ? `, ${mergedCommits} commit(s) preserved from a same-version re-cut` : ""}).`,
);
