#!/usr/bin/env node
/**
 * sync-save-catalogue.js — mirror Quinn's Episode-One save catalogue into App.
 *
 * Quinn owns `Quinn/published/save_catalogue.json` (from `save_catalogue.py ::
 * catalogue_json()`): story-legal coverage of the Ep1 save chain — which nodes
 * are captured, which are the next autoplay targets, and how far autoplay got.
 * Contract: QA_CLAUDE_SAVE_TREE_VIZ_FOR_APP.md.
 *
 * This copies the data only. It deliberately copies NO save files: a covered
 * node becomes jumpable in the console only when its `jump.id` is a node of the
 * shared registry (tree/save_tree_manifest.json), which `sync:scenarios` already
 * mirrors. `captured/` and `frontier/` are staging, and the promotion boundary
 * is what keeps the launcher pointed at curated saves — the catalogue must not
 * become a side door around it.
 *
 * Run when Quinn regenerates the catalogue: `npm run sync:catalogue`, then
 * commit src/data/save-catalogue.json. Skips cleanly when the source is absent.
 */
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const CHRONICLES_DIR =
  process.env.CHRONICLES_DIR || join(homedir(), "Desktop/GameDev/ChroniclesOfNesis");
const SRC =
  process.env.SAVE_CATALOGUE || join(dirname(CHRONICLES_DIR), "Quinn/published/save_catalogue.json");
const OUT = join(root, "src/data/save-catalogue.json");

const log = (...a) => console.log("[sync-catalogue]", ...a);

if (!existsSync(SRC)) {
  log(`catalogue not found (${SRC}) — skipping; committed save-catalogue.json unchanged.`);
  process.exit(0);
}

let cat;
try {
  cat = JSON.parse(readFileSync(SRC, "utf8"));
} catch (e) {
  log(`could not parse save_catalogue.json: ${e.message} — skipping.`);
  process.exit(0);
}

const STATUS = new Set(["covered", "gap", "skip"]);
const TIER = new Set(["next", "future"]);
const SAFE = /^[A-Za-z0-9._-]+$/;
const str = (v) => (typeof v === "string" ? v : undefined);
const int = (v) => (Number.isInteger(v) ? v : undefined);

// Whitelist the schema rather than copy the file verbatim: this lands in a
// public repo, and a field Quinn adds later (a local path, a note with a name
// in it) should have to be opted in here, not ride along unseen.
const nodes = [];
for (const n of Array.isArray(cat.nodes) ? cat.nodes : []) {
  if (int(n?.cond) == null || int(n?.level) == null || !STATUS.has(n.status)) {
    log(`skip malformed node: ${JSON.stringify(n).slice(0, 80)}`);
    continue;
  }
  const out = { cond: n.cond, level: n.level, note: str(n.note) ?? "", status: n.status };
  if (TIER.has(n.tier)) out.tier = n.tier;
  const j = n.jump;
  if (n.status === "covered" && j && typeof j.id === "string") {
    if (SAFE.test(j.id)) {
      out.jump = {
        id: j.id,
        source: str(j.source),
        scene: str(j.scene),
        chain_legal: j.chain_legal === true,
        story_legal: j.story_legal === true,
      };
    } else log(`⚠ node c${n.cond}/L${n.level}: unsafe jump id ${JSON.stringify(j.id)} — dropped.`);
  }
  nodes.push(out);
}

const f = cat.frontier && typeof cat.frontier === "object" ? cat.frontier : null;
const data = {
  title: str(cat.title) ?? "Episode One — Save Catalogue",
  as_of: str(cat.as_of) ?? null,
  synced_at: new Date().toISOString(),
  covered: int(cat.covered) ?? nodes.filter((n) => n.status === "covered").length,
  savable_total: int(cat.savable_total) ?? nodes.filter((n) => n.status !== "skip").length,
  target_level: int(cat.target_level),
  frontier: f
    ? {
        reached_level: int(f.reached_level),
        reached_scene: str(f.reached_scene),
        reached_depth_bfs: int(f.reached_depth_bfs),
        status: str(f.status),
        note: str(f.note),
      }
    : null,
  nodes,
};

writeFileSync(OUT, JSON.stringify(data, null, 2) + "\n");
const jumps = nodes.filter((n) => n.jump).length;
log(`wrote ${nodes.length} node(s) (${data.covered}/${data.savable_total} covered, ${jumps} with a jump id) → src/data/save-catalogue.json`);
