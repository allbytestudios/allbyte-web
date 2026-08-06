#!/usr/bin/env node
/**
 * sync-save-tree.js — mirror Quinn's save-state tree into App.
 *
 * The save-state tree is a branching graph of chain-legal saves (one tree per
 * difficulty); Quinn plays + verifies each node, Arc commits the blob and a row
 * in save_tree_manifest.json (schema "save-state-tree v1", see
 * QA_CLAUDE_SAVE_TREE_FOR_APP.md). Like sync-scenario-fixtures.js, the launcher
 * must fetch each save SAME-ORIGIN before handing it to the game, so this:
 *   1. reads WebTests/fixtures/saves/tree/save_tree_manifest.json
 *   2. copies each node's save_file → public/scenario-fixtures/tree-<id>.json
 *      (the /play ?scenario= path — no /play changes needed)
 *   3. writes the normalised node list to src/data/save-tree.json
 * Nodes whose blob is missing are omitted (not jumpable) + warned.
 *
 * Run when the tree changes: `npm run sync:tree`, then commit the updated
 * src/data/save-tree.json + public/scenario-fixtures/tree-*.json. Skips cleanly
 * (leaving committed copies) when the game repo isn't present — e.g. in CI.
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const CHRONICLES_DIR =
  process.env.CHRONICLES_DIR || join(homedir(), "Desktop/GameDev/ChroniclesOfNesis");
const SAVES_DIR = join(CHRONICLES_DIR, "WebTests/fixtures/saves");
const MANIFEST = join(SAVES_DIR, "tree/save_tree_manifest.json");
const OUT_DATA = join(root, "src/data/save-tree.json");
const OUT_FIX_DIR = join(root, "public/scenario-fixtures");

const log = (...a) => console.log("[sync-save-tree]", ...a);
const SAFE_ID = /^[A-Za-z0-9_-]+$/;
// save_file is relative to WebTests/fixtures/saves/ (e.g. "tree/hard/hard_root.json")
const SAFE_REL = /^[A-Za-z0-9._/-]+$/;

if (!existsSync(MANIFEST)) {
  log(`manifest not found (${MANIFEST}) — skipping; committed save-tree.json unchanged.`);
  process.exit(0);
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST, "utf8"));
} catch (e) {
  log(`could not parse save_tree_manifest.json: ${e.message} — skipping.`);
  process.exit(0);
}

const rows = Array.isArray(manifest.nodes) ? manifest.nodes : Array.isArray(manifest) ? manifest : [];
if (rows.length === 0) log("no nodes in manifest yet — writing empty tree.");

mkdirSync(OUT_FIX_DIR, { recursive: true });
const out = [];
let copied = 0;
let missing = 0;

for (const n of rows) {
  if (!n.id || !SAFE_ID.test(n.id)) {
    log(`skip node with unusable id: ${JSON.stringify(n).slice(0, 80)}`);
    continue;
  }
  const rel = n.save_file;
  if (!rel || !SAFE_REL.test(rel) || rel.includes("..")) {
    log(`⚠ node '${n.id}' has unusable save_file '${rel}' — omitting.`);
    missing++;
    continue;
  }
  const src = join(SAVES_DIR, rel);
  if (!existsSync(src)) {
    log(`⚠ blob for '${n.id}' not found (${rel}) — omitting (not jumpable).`);
    missing++;
    continue;
  }
  try {
    // tree-<id> namespaces the fixture so it can't collide with spine fixtureIds.
    writeFileSync(join(OUT_FIX_DIR, `tree-${n.id}.json`), readFileSync(src));
    copied++;
  } catch (e) {
    log(`⚠ could not copy '${n.id}': ${e.message}`);
    continue;
  }
  out.push({
    id: n.id,
    difficulty: n.difficulty || "unknown",
    parent: n.parent ?? null,
    decision: n.decision || "",
    is_leaf: !!n.is_leaf,
    label: n.label || n.id,
    summary: n.summary || undefined,
    scene: n.scene || undefined,
    progress: n.progress || undefined,
    build: n.build || undefined,
    inventory: n.inventory || undefined,
    web_version: n.web_version || undefined,
    chain_legal: n.chain_legal !== false,
    packs: Array.isArray(n.packs) ? n.packs : undefined,
    tags: Array.isArray(n.tags) ? n.tags : undefined,
    // QA approval (Quinn-authored, Arc-committed): "approved" | "unapproved";
    // absent = unverified. Drives the red/green badge + "Approved only" filter.
    approval: n.approval === "approved" || n.approval === "unapproved" ? n.approval : undefined,
    // Narrative-spine tags (Arc-committed, schema v1.1): slugs into
    // src/data/story-spine.json. Drive the chapter→section outline + the
    // difficulty filter; parent/decision become metadata, not layout.
    chapter: n.chapter || undefined,
    section: n.section || undefined,
    seq: typeof n.seq === "number" ? n.seq : undefined,
    // Launcher visibility (Quinn-authored, Arc-committed). "dormant" retires a
    // node from the launcher without deleting the capture. This whitelist drops
    // anything not named here, so the field has to be listed explicitly or the
    // filter downstream would never see it. Absent = active.
    launcher_status: n.launcher_status === "dormant" ? "dormant" : undefined,
  });
}

const data = {
  version: 1,
  schema: manifest.schema || "save-state-tree v1",
  generated_at: new Date().toISOString(),
  nodes: out,
};
writeFileSync(OUT_DATA, JSON.stringify(data, null, 2) + "\n");
log(`wrote ${out.length} node(s) → src/data/save-tree.json; copied ${copied}, ${missing} missing.`);
