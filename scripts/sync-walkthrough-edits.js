#!/usr/bin/env node
/**
 * sync-walkthrough-edits.js — Phase 3 of the walkthrough edit overlay.
 *
 * Run AFTER `npm run sync:walkthrough` has brought in Quinn's latest scenes/*.md.
 * Two jobs:
 *
 *   1. BRIDGE — pull the prod edit-diff feed from S3 into the coord-dir feed Quinn
 *      reads (WALKTHROUGH_EDITS_FOR_QUINN.ndjson), deduped. Dev edits already land
 *      in that feed directly (dev writeback); this adds the prod ones so she sees
 *      every edit in one place.
 *
 *   2. AUTO-RETIRE — retire an override once Quinn has folded it into her base, so
 *      the live site reads her (now-improved) prose directly again:
 *        - the just-synced base body === the override's edited_md  (verbatim fold), OR
 *        - she emitted {op:"incorporated", code, edit_id} for THIS exact edit.
 *      GUARD (Quinn's revert-race catch): never retire a scene whose base isn't
 *      present in the synced content, and marker-retire only the exact edit_id —
 *      so a newer, not-yet-incorporated edit is never dropped. base===edit is
 *      always safe (identical text); the marker path trusts her base_synced assertion.
 *
 *   npm run sync:walkthrough-edits           bridge + retire (prod S3 + dev store)
 *   npm run sync:walkthrough-edits -- --dry  show what would change, touch nothing
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, appendFileSync, existsSync, readdirSync, mkdtempSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";

const dry = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHRONICLES = process.env.CHRONICLES_DIR || join(homedir(), "Desktop/GameDev/ChroniclesOfNesis");
const COORD = dirname(CHRONICLES);
const FEED = join(COORD, "WALKTHROUGH_EDITS_FOR_QUINN.ndjson");
const DEV_STORE = join(COORD, "walkthrough_overrides.dev.json");
const CONTENT = join(root, "src/content/walkthrough");
const BUCKET = "allbyte-studio-walkthrough-overlay";
const FEED_KEY = "walkthrough-edits.ndjson";
const OVERRIDES_KEY = "overrides.json";
const REGION = "us-east-1";
const log = (...a) => console.log("[sync-walkthrough-edits]", ...a);

const s3get = (key) => {
  try {
    return execSync(`aws s3 cp s3://${BUCKET}/${key} - --region ${REGION}`, {
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
  } catch {
    return ""; // absent object / no creds -> treat as empty
  }
};
const s3putJson = (key, obj) => {
  const tmp = join(mkdtempSync(join(tmpdir(), "wt-")), "o.json");
  writeFileSync(tmp, JSON.stringify(obj, null, 2) + "\n");
  execSync(`aws s3 cp "${tmp}" s3://${BUCKET}/${key} --region ${REGION} --content-type application/json`, {
    stdio: "ignore",
  });
};
const parseNdjson = (t) =>
  t
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);

// --- 1. bridge the prod feed into the coord-dir feed --------------------------
const s3feed = parseNdjson(s3get(FEED_KEY));
let localFeed = existsSync(FEED) ? parseNdjson(readFileSync(FEED, "utf8")) : [];
const feedKey = (r) => `${r.op || "edit"}:${r.id || r.edit_id || ""}:${r.code || ""}:${r.ts || ""}`;
const have = new Set(localFeed.map(feedKey));
const fresh = s3feed.filter((r) => !have.has(feedKey(r)));
if (fresh.length && !dry) appendFileSync(FEED, fresh.map((r) => JSON.stringify(r)).join("\n") + "\n");
log(`bridge: ${fresh.length} new prod feed record(s)${dry ? " (dry)" : " appended"} -> ${FEED}`);
localFeed = localFeed.concat(fresh);

// --- 2. auto-retire folded overrides -----------------------------------------
// Synced base bodies (code -> trimmed body), read from the just-synced content.
const bodies = {};
if (existsSync(CONTENT)) {
  const walk = (d) =>
    readdirSync(d, { withFileTypes: true }).forEach((e) => {
      const p = join(d, e.name);
      if (e.isDirectory()) return walk(p);
      if (!e.name.endsWith(".md")) return;
      const raw = readFileSync(p, "utf8");
      const fm = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
      const codeM = raw.match(/(?:^|\n)code:\s*["']?([A-Z]+-\d+\.\d+)["']?/);
      if (codeM) bodies[codeM[1]] = raw.slice(fm ? fm[0].length : 0).trim();
    });
  walk(CONTENT);
}

// Incorporated markers: code -> set of edit_ids Quinn has folded in.
const incorporated = {};
for (const r of localFeed) {
  if (r.op === "incorporated" && r.code) (incorporated[r.code] ||= new Set()).add(r.edit_id || r.id);
}

function planRetire(overrides) {
  const retire = [];
  for (const [code, ov] of Object.entries(overrides)) {
    if (!(code in bodies)) continue; // GUARD: base not present -> never retire (revert-race)
    const base = bodies[code];
    const edited = (ov?.edited_md || "").trim();
    if (base === edited) retire.push([code, "base==edit (verbatim fold)"]);
    else if (incorporated[code]?.has(ov?.id)) retire.push([code, "incorporated marker"]);
  }
  return retire;
}

// prod (the live overlay)
const prodOv = (() => {
  try {
    return JSON.parse(s3get(OVERRIDES_KEY) || "{}");
  } catch {
    return {};
  }
})();
const prodRetire = planRetire(prodOv);
if (prodRetire.length && !dry) {
  for (const [code] of prodRetire) delete prodOv[code];
  s3putJson(OVERRIDES_KEY, prodOv);
}
prodRetire.forEach(([code, why]) => log(`retire PROD ${code} — ${why}${dry ? " (dry)" : ""}`));

// dev store (local only)
if (existsSync(DEV_STORE)) {
  let devOv = {};
  try {
    devOv = JSON.parse(readFileSync(DEV_STORE, "utf8") || "{}");
  } catch {}
  const devRetire = planRetire(devOv);
  if (devRetire.length && !dry) {
    for (const [code] of devRetire) delete devOv[code];
    writeFileSync(DEV_STORE, JSON.stringify(devOv, null, 2) + "\n");
  }
  devRetire.forEach(([code, why]) => log(`retire DEV ${code} — ${why}${dry ? " (dry)" : ""}`));
}

if (!prodRetire.length) log("no prod overrides to retire.");
log("done.");
