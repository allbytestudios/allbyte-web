#!/usr/bin/env node
/**
 * sync-scenario-fixtures.js — mirror Quinn's scenario-launcher content into App.
 *
 * Quinn owns the scenario list (rows in her quinn_spine.json) AND the referenced
 * save fixtures (in the game repo's WebTests/fixtures/saves/). The launcher runs
 * on App's origin and must fetch each save SAME-ORIGIN (no CORS) before handing
 * it to the game inline, so this script:
 *   1. reads quinn_spine.json → the scenario rows (label, packs, fixtureId, persona)
 *   2. finds each referenced <fixtureId>.json in the fixture library
 *   3. copies it into public/scenario-fixtures/<fixtureId>.json (served same-origin)
 *   4. writes the normalised catalogue to src/data/scenarios.json
 * Rows whose fixture isn't in the library are omitted (not launchable) + warned.
 *
 * Run manually when Quinn's content changes: `npm run sync:scenarios`, then commit
 * the updated src/data/scenarios.json + public/scenario-fixtures/*. Skips cleanly
 * (leaving the committed copies) when the game repo isn't present — e.g. in CI.
 *
 * Row shape expected in quinn_spine.json (Arc's contract):
 *   { "scenarios": [ { "section", "label", "fixtureId", "packs": "Laria,Combat", "persona"?, "note"? } ] }
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const CHRONICLES_DIR =
  process.env.CHRONICLES_DIR || join(homedir(), "Desktop/GameDev/ChroniclesOfNesis");
const QUINN_SPINE =
  process.env.QUINN_SPINE || join(dirname(CHRONICLES_DIR), "Quinn/published/quinn_spine.json");
const FIXTURES_DIR = join(CHRONICLES_DIR, "WebTests/fixtures/saves");
const OUT_DATA = join(root, "src/data/scenarios.json");
const OUT_FIX_DIR = join(root, "public/scenario-fixtures");

const log = (...a) => console.log("[sync-scenarios]", ...a);
const SAFE = /^[A-Za-z0-9._-]+$/;

if (!existsSync(QUINN_SPINE)) {
  log(`Quinn spine not found (${QUINN_SPINE}) — skipping; committed scenarios.json unchanged.`);
  process.exit(0);
}

let spine;
try {
  spine = JSON.parse(readFileSync(QUINN_SPINE, "utf8"));
} catch (e) {
  log(`could not parse quinn_spine.json: ${e.message} — skipping.`);
  process.exit(0);
}

// Quinn's launcher rows live in `saves[]` (each: id, scene_id, fixtureId, packs,
// label, persona). Fall back to a top-level `scenarios[]` if that convention changes.
const rows = Array.isArray(spine.scenarios)
  ? spine.scenarios
  : Array.isArray(spine.saves)
    ? spine.saves
    : [];
if (rows.length === 0) log("no launcher rows (saves[]/scenarios[]) in quinn_spine.json yet — writing empty catalogue.");

// "sluice-gate" → "Sluice Gate"; "waterway1" → "Waterway 1"
function prettify(id) {
  if (!id) return "";
  return String(id)
    .replace(/[-_]+/g, " ")
    .replace(/([a-zA-Z])(\d)/g, "$1 $2")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

// Find a save file by id anywhere under the fixture library.
function findSave(id) {
  if (!existsSync(FIXTURES_DIR)) return null;
  const stack = [FIXTURES_DIR];
  while (stack.length) {
    const d = stack.pop();
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) stack.push(p);
      else if (name === `${id}.json`) return p;
    }
  }
  return null;
}

mkdirSync(OUT_FIX_DIR, { recursive: true });
const out = [];
const sections = [];
let copied = 0;
let missing = 0;

for (const r of rows) {
  // Quinn's spine rows carry `url` ("quinn/saves/boss_str_smite.json") where this
  // contract wants `fixtureId` ("boss_str_smite"). On 2026-09-08 that mismatch
  // silently dropped 13 of 14 rows — the launcher had been near-empty for weeks
  // and the skip only showed in a log nobody was reading. Deriving the id from
  // the url basename closes that, and the failure mode is safe: findSave() looks
  // the name up in the fixture library and omits the row with a warning if it is
  // not there, so a bad derivation can never load the WRONG save.
  //
  // Deliberately NOT silent — a derived id is announced, because a contract that
  // quietly repairs itself is one nobody notices has drifted.
  let fixtureId = r.fixtureId || r.play_param;
  if (!fixtureId && typeof r.url === "string") {
    const base = r.url.split("/").pop()?.replace(/\.json$/i, "");
    if (base && SAFE.test(base)) {
      fixtureId = base;
      log(`row '${r.id || base}' has no fixtureId — derived '${base}' from url.`);
    }
  }
  if (!fixtureId || !SAFE.test(fixtureId)) {
    log(`skip row with no usable fixtureId: ${JSON.stringify(r).slice(0, 80)}`);
    continue;
  }
  if (!r.packs) {
    // The save JSON does not record which packs it needs, so this is the one
    // field nobody downstream can reconstruct. A row without it would render and
    // then fail to load, which is worse than not rendering.
    log(`⚠ '${fixtureId}' has no packs — omitting (would render but not load).`);
    missing++;
    continue;
  }
  const src = findSave(fixtureId);
  if (!src) {
    log(`⚠ fixture '${fixtureId}' not in the library — omitting row (not launchable).`);
    missing++;
    continue;
  }
  try {
    writeFileSync(join(OUT_FIX_DIR, `${fixtureId}.json`), readFileSync(src));
    copied++;
  } catch (e) {
    log(`⚠ could not copy '${fixtureId}': ${e.message}`);
    continue;
  }
  const section = r.section || prettify(r.scene_id) || "Scenarios";
  if (!sections.includes(section)) sections.push(section);
  const packs = Array.isArray(r.packs)
    ? r.packs
    : typeof r.packs === "string"
      ? r.packs.split(",").map((s) => s.trim()).filter(Boolean)
      : [];
  out.push({
    id: r.id || fixtureId,
    section,
    label: r.label || fixtureId,
    fixtureId,
    packs,
    persona: r.persona || undefined,
    note: r.note || undefined,
  });
}

const data = { version: 1, generated_at: new Date().toISOString(), sections, scenarios: out };
writeFileSync(OUT_DATA, JSON.stringify(data, null, 2) + "\n");
log(`wrote ${out.length} scenario(s) → src/data/scenarios.json; copied ${copied}, ${missing} missing.`);
