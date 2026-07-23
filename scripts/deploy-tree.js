// One-command save-state deploy — no agent in the loop.
//
//   npm run deploy:tree          sync Arc's latest manifest -> commit the tree data -> push (prod deploys via CI)
//   npm run deploy:tree -- --dry sync + show what WOULD change, no commit/push
//
// Mirrors save_tree_manifest.json (approval field, nodes, fixtures) into the repo
// and ships it. Skips cleanly when nothing changed, so it's safe to run anytime.
// Analogous to Arc's develop deploy: a single trigger, no manual multi-step.
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dry = process.argv.includes("--dry") || process.argv.includes("--dry-run");
const sh = (cmd) => execSync(cmd, { stdio: "inherit" });
const cap = (cmd) => execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString().trim();

// 1. mirror the manifest -> src/data/save-tree.json + public/scenario-fixtures/
console.log("→ syncing save-tree manifest…");
sh("npm run sync:tree");

// 2. did anything MEANINGFUL change? sync stamps a fresh `generated_at` every run,
//    so a naive git-status check ALWAYS sees a diff — compare the real data (nodes)
//    ignoring the timestamp, plus any fixture-blob changes.
const TREE_PATHS = "src/data/save-tree.json public/scenario-fixtures";
const fixturesChanged = cap(`git status --porcelain -- public/scenario-fixtures`);
let dataChanged = true;
try {
  const stripTs = (o) => {
    const { generated_at, ...rest } = o;
    return JSON.stringify(rest);
  };
  const head = JSON.parse(cap(`git show HEAD:src/data/save-tree.json`));
  const work = JSON.parse(readFileSync("src/data/save-tree.json", "utf-8"));
  dataChanged = stripTs(head) !== stripTs(work);
} catch {
  /* first run / no committed baseline — treat as changed */
}
if (!fixturesChanged && !dataChanged) {
  // only the timestamp moved — discard it so the working tree stays clean
  try {
    execSync("git checkout -- src/data/save-tree.json", { stdio: "ignore" });
  } catch {}
  console.log("\n✓ Save tree data unchanged (only the sync timestamp moved) — nothing to publish.");
  process.exit(0);
}
console.log("\n→ changed:\n" + cap(`git status --porcelain -- ${TREE_PATHS}`) + "\n");

// summarise for the commit message
let counts = "";
try {
  const nodes = JSON.parse(readFileSync("src/data/save-tree.json", "utf-8")).nodes ?? [];
  const g = nodes.filter((n) => n.approval === "approved").length;
  const r = nodes.filter((n) => n.approval === "unapproved").length;
  counts = ` — ${nodes.length} nodes (${g} approved / ${r} unapproved)`;
}
catch {}

if (dry) {
  console.log(`(dry run) would commit + push: deploy(save-tree): publish latest manifest${counts}`);
  process.exit(0);
}

// 3. commit just the tree data + push (prod redeploys via deploy.yml)
console.log("→ committing + pushing…");
sh(`git add ${TREE_PATHS}`);
sh(`git commit -m "deploy(save-tree): publish latest manifest to prod${counts}"`);
sh("git push");
console.log("\n✓ Pushed. Prod redeploys automatically (~1-2 min) → the save tree is live at /test/scenarios/.");
