// Bridge between the prod dialogue-overlay stack and Arc's local game repo.
//
//   node scripts/sync-dialogue.js           upload review.json -> S3, and pull
//                                           queued owner + arc edits S3 -> the local
//                                           tools/dialogue_overrides.json + ambient_overrides.json
//   node scripts/sync-dialogue.js --clear   clear both S3 overlays (run after Arc applies)
//
// The prod dialogue editor queues edits in S3 (allbyte-studio-dialogue-overlay):
// owner edits -> overrides.json, arc edits -> ambient_overrides.json. This brings
// them to the two files Arc's apply steps read, and pushes the current review.json
// up so the live editor shows the latest dialogue. Arc's side is unchanged.
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const CHRONICLES = process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis";
const BUCKET = "allbyte-studio-dialogue-overlay";
const REGION = "us-east-1";
const reviewLocal = join(CHRONICLES, "tools", "dialogue_review.json");
const overridesLocal = join(CHRONICLES, "tools", "dialogue_overrides.json");
const ambientLocal = join(CHRONICLES, "tools", "ambient_overrides.json");
const clear = process.argv.includes("--clear");

function aws(args) {
  return execSync(`aws ${args} --region ${REGION}`, { stdio: ["ignore", "pipe", "pipe"] }).toString();
}

function s3Get(key) {
  const tmp = mkdtempSync(join(tmpdir(), "dlg-"));
  try {
    aws(`s3 cp "s3://${BUCKET}/${key}" "${join(tmp, "f.json")}"`);
    return JSON.parse(readFileSync(join(tmp, "f.json"), "utf-8") || "{}");
  } catch {
    return null; // no such object yet
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function readLocal(p) {
  if (existsSync(p)) {
    try {
      return JSON.parse(readFileSync(p, "utf-8") || "{}");
    } catch {}
  }
  return {};
}

if (clear) {
  for (const key of ["overrides.json", "ambient_overrides.json"]) {
    try {
      aws(`s3 rm "s3://${BUCKET}/${key}"`);
      console.log(`cleared S3 ${key}`);
    } catch {
      console.log(`S3 ${key} already empty`);
    }
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

// 2. owner overrides: S3 -> merge into local (flat id -> {lines})
const remoteOwner = s3Get("overrides.json") || {};
const nOwner = Object.keys(remoteOwner).length;
if (nOwner) {
  const merged = { ...readLocal(overridesLocal), ...remoteOwner };
  writeFileSync(overridesLocal, JSON.stringify(merged, null, 2) + "\n");
  console.log(`pulled ${nOwner} owner edit(s) -> dialogue_overrides.json`);
} else {
  console.log("no remote-queued owner edits");
}

// 3. arc/ambient overrides: S3 -> merge into local (nested npc -> situation_id -> {variants})
const remoteAmb = s3Get("ambient_overrides.json") || {};
const nAmb = Object.values(remoteAmb).reduce((n, sits) => n + Object.keys(sits).length, 0);
if (nAmb) {
  const local = readLocal(ambientLocal);
  for (const [npc, sits] of Object.entries(remoteAmb)) {
    local[npc] = { ...(local[npc] || {}), ...sits };
  }
  writeFileSync(ambientLocal, JSON.stringify(local, null, 2) + "\n");
  console.log(`pulled ${nAmb} arc edit(s) -> ambient_overrides.json`);
} else {
  console.log("no remote-queued arc edits");
}

if (nOwner || nAmb) {
  console.log("-> ping Arc to apply; run `npm run sync:dialogue -- --clear` after he archives, to clear S3");
}
