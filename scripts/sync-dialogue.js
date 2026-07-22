// Bridge between the prod dialogue-overlay stack and Arc's local game repo.
//
//   node scripts/sync-dialogue.js           upload review.json -> S3, pull queued
//                                           edits S3 -> local dialogue_overrides.json
//   node scripts/sync-dialogue.js --clear   clear the S3 overlay (run after Arc applies)
//
// The prod dialogue editor queues edits in S3 (allbyte-studio-dialogue-overlay).
// This brings them down to tools/dialogue_overrides.json — the file Arc's apply
// step already reads — and pushes the current review.json up so the live editor
// shows the latest dialogue. Arc's side is unchanged; App owns this bridge.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHRONICLES = process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis";
const BUCKET = "allbyte-studio-dialogue-overlay";
const REGION = "us-east-1";
const reviewLocal = join(CHRONICLES, "tools", "dialogue_review.json");
const overridesLocal = join(CHRONICLES, "tools", "dialogue_overrides.json");
const clear = process.argv.includes("--clear");

function aws(args) {
  return execSync(`aws ${args} --region ${REGION}`, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

if (clear) {
  try {
    aws(`s3 rm "s3://${BUCKET}/overrides.json"`);
    console.log("cleared S3 overlay");
  } catch {
    console.log("S3 overlay already empty");
  }
  process.exit(0);
}

// 1. review.json -> S3 (the prod editor's read source)
if (existsSync(reviewLocal)) {
  aws(`s3 cp "${reviewLocal}" "s3://${BUCKET}/review.json" --content-type application/json`);
  console.log("uploaded dialogue_review.json -> S3");
} else {
  console.log("no local dialogue_review.json (Arc runs the extractor)");
}

// 2. S3 overrides -> merge into local (bring prod-queued edits to Arc's apply)
let remote = {};
const tmp = mkdtempSync(join(tmpdir(), "dlg-"));
try {
  aws(`s3 cp "s3://${BUCKET}/overrides.json" "${join(tmp, "o.json")}"`);
  remote = JSON.parse(readFileSync(join(tmp, "o.json"), "utf-8") || "{}");
} catch {
  /* no remote overlay yet */
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

const remoteN = Object.keys(remote).length;
if (remoteN === 0) {
  console.log("no remote-queued edits to pull");
} else {
  let local = {};
  if (existsSync(overridesLocal)) {
    try {
      local = JSON.parse(readFileSync(overridesLocal, "utf-8") || "{}");
    } catch {}
  }
  const merged = { ...local, ...remote }; // remote (prod-queued) wins on conflict
  writeFileSync(overridesLocal, JSON.stringify(merged, null, 2) + "\n");
  console.log(
    `pulled ${remoteN} remote edit(s) into local dialogue_overrides.json (${Object.keys(merged).length} total pending)`
  );
  console.log("-> Arc can apply now; run `npm run sync:dialogue -- --clear` after he archives, to clear S3");
}
