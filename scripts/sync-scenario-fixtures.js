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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from "fs";
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

// THE REGISTRY IS THE SOURCE OF TRUTH (Arc, 2026-10-16, open item #9).
// Loaded before the rows because the spine is now a pure OVERLAY over it: a
// curated row may only FEATURE a node the registry already defines, never
// introduce one. Anything else is drift between two sources, and the point of
// one shared tree is that there is nowhere for that to hide.
const TREE_MANIFEST = join(FIXTURES_DIR, "tree", "save_tree_manifest.json");
let registry = null;
if (existsSync(TREE_MANIFEST)) {
  try { registry = JSON.parse(readFileSync(TREE_MANIFEST, "utf8")); }
  catch (e) { log(`save_tree_manifest.json unreadable (${e.message}) — tree not mirrored.`); }
} else {
  log("no tree/save_tree_manifest.json in the fixture library — shared tree not mirrored.");
}
const registryNodes = registry && Array.isArray(registry.nodes) ? registry.nodes : [];
const registryIds = new Set(registryNodes.map((n) => n && n.id).filter(Boolean));

const out = [];
const sections = [];
const drift = [];
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
  // Overlay rule: silently copying a save the registry does not define is how
  // the webapp ends up serving state nobody promoted and nobody can trace back.
  if (registryIds.size > 0 && !registryIds.has(fixtureId)) {
    drift.push(fixtureId);
    log(`✗ DRIFT: curated row '${fixtureId}' is not a node in save_tree_manifest.json — omitted.`);
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

// ONE SHARED SAVE TREE (owner 2026-10-16, via Rowan's clarification).
//
// The canonical registry is the game repo's tree/save_tree_manifest.json —
// jointly maintained by Quinn AND Wren, with real parent links, so it is a
// TREE of playtest states rather than a flat pile of files. Everything the
// webapp serves is a GENERATED MIRROR of that registry.
//
// What this deliberately does NOT do: build its own list by scanning the
// directory. An independently-maintained webapp copy is a second source of
// truth, and the first time it disagreed with the registry — a renamed node, a
// retired branch — nobody would know which was right. Scanning also silently
// promotes scratch state: `captured/` and `frontier/` are staging, and the
// promotion boundary is the thing that keeps the launcher pointed at curated
// saves.
//
// Curation stays separate from availability: the spine above decides which rows
// are FEATURED in the launcher UI; the registry decides what EXISTS and can be
// loaded by id. Either lane can jump to any node in the tree without anyone
// having published a row for it.
const treeNodes = [];
let treeCopied = 0;
let treeMissing = 0;
{
  for (const n of registryNodes) {
    const id = n && n.id;
    if (!id || !SAFE.test(id)) { log(`tree node skipped — unsafe/missing id: ${JSON.stringify(n && n.id)}`); continue; }
    const rel = n.save_file;
    const src = rel ? join(FIXTURES_DIR, rel) : null;
    if (!src || !existsSync(src)) {
      // Registry validity does not prove the fixture is actually there.
      treeMissing++;
      log(`⚠ tree node '${id}' references a missing save (${rel}) — omitted from the mirror.`);
      continue;
    }
    try {
      writeFileSync(join(OUT_FIX_DIR, `${id}.json`), readFileSync(src));
      treeCopied++;
      treeNodes.push({
        id,
        label: n.label || id,
        parent: n.parent ?? null,
        difficulty: n.difficulty || undefined,
        scene: n.scene || undefined,
        packs: Array.isArray(n.packs) ? n.packs : undefined,
      });
    } catch (e) {
      treeMissing++;
      log(`could not mirror tree node '${id}': ${e.message}`);
    }
  }
}

// PRUNE. A mirror that only ever adds is not a mirror: it accumulates renamed
// and retired nodes, and then reports them as available. Keep exactly what the
// registry and the curated rows reference.
const keep = new Set([
  ...treeNodes.map((n) => `${n.id}.json`),
  ...out.map((r) => `${r.fixtureId}.json`),
  "save-tree.json",
]);
let pruned = 0;
for (const name of readdirSync(OUT_FIX_DIR)) {
  if (!name.endsWith(".json") || keep.has(name)) continue;
  try { unlinkSync(join(OUT_FIX_DIR, name)); pruned++; } catch { /* best-effort */ }
}

// The tree itself, so a lane or the console can show the branches and jump to
// any node — not just the handful someone curated into a row.
writeFileSync(
  join(OUT_FIX_DIR, "save-tree.json"),
  JSON.stringify(
    {
      version: 1,
      generated_at: data.generated_at,
      source: "ChroniclesOfNesis/WebTests/fixtures/saves/tree/save_tree_manifest.json",
      nodes: treeNodes,
    },
    null,
    2,
  ) + "\n",
);

log(`wrote ${out.length} curated scenario(s) → src/data/scenarios.json; copied ${copied}, ${missing} missing.`);
log(`shared save tree: ${treeCopied} node(s) mirrored${treeMissing ? `, ${treeMissing} missing` : ""}; ${pruned} stale file(s) pruned.`);

// Drift fails the command — but only AFTER the registry mirror is written. The
// shared tree is the source of truth and must stay correct even when the
// overlay that decorates it is wrong.
if (drift.length) {
  log("");
  log(`✗ ${drift.length} curated row(s) reference saves that are NOT registry nodes:`);
  for (const id of drift) log(`    ${id}`);
  log("  Fix at the source: promote them into tree/save_tree_manifest.json, or drop them from the spine.");
  log("  The shared tree above mirrored correctly; only the overlay is wrong.");
  process.exit(1);
}
