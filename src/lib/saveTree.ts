/**
 * Save-state tree data layer.
 *
 * A branching tree of chain-legal saves (one tree per difficulty): root = first
 * save after New Game, each edge = a major player decision, each node = a real
 * loadable save. Quinn designs + plays the nodes, Arc commits the blobs +
 * save_tree_manifest.json; `scripts/sync-save-tree.js` mirrors the manifest to
 * `src/data/save-tree.json` and the blobs to
 * `public/scenario-fixtures/tree-<id>.json`, so "Jump here" reuses the exact
 * scenario-launcher load path (?channel=develop&scenario=tree-<id>).
 * Contract: QA_CLAUDE_SAVE_TREE_FOR_APP.md.
 */

import data from "../data/save-tree.json";
import { DEBUG_CHANNEL_ID } from "./gameVersions";
import spine from "../data/story-spine.json";

export interface SaveTreeBuild {
  level?: number;
  skills?: string[];
  stats?: Record<string, number>;
  maxHP?: number;
  maxMP?: number;
  sp_spent?: number;
  jp_spent?: number;
}

export interface SaveTreeNode {
  id: string;
  difficulty: string;
  parent: string | null;
  /** edge label — the decision that led here from the parent */
  decision: string;
  /** boss-fight endpoint — the primary jump targets */
  is_leaf: boolean;
  label: string;
  summary?: string;
  scene?: string;
  progress?: string;
  build?: SaveTreeBuild;
  inventory?: { sen?: number; items?: string[]; equipped?: string[] };
  web_version?: string;
  chain_legal: boolean;
  /** zone packs to mount before the import (same semantics as scenario rows) */
  packs?: string[];
  /** e.g. "recommended for testing poison" */
  tags?: string[];
  /** QA approval — Quinn flips unapproved→approved once she verifies the node
   *  loads correctly on the live build (manifest-authored, Arc-committed).
   *  Missing = not yet triaged ("unverified"). */
  approval?: "approved" | "unapproved";
  /** Narrative-spine tags (schema v1.1) — slugs into story-spine.json. Drive the
   *  chapter→section outline; difficulty is a filter, not a grouping level, and
   *  parent/decision are metadata now, not layout. `seq` orders within a section. */
  chapter?: string;
  section?: string;
  seq?: number;
  /** Launcher visibility (Quinn-authored, Arc-committed). "dormant" hides the
   *  node from the launcher without deleting the capture — the difficulty track
   *  is dormant, not removed, and re-capturing later is expensive. Absent =
   *  "active" (the field is being backfilled; absence must not hide anything).
   *
   *  Dormancy is an EXPLICIT field on purpose: never infer it from `difficulty`,
   *  which would silently re-hide everything if the difficulty track wakes up.
   *  Distinct from `approval`, which is QA save-verification state. */
  launcher_status?: "active" | "dormant";
}

export interface SaveTreeData {
  version: number;
  schema: string;
  generated_at: string | null;
  nodes: SaveTreeNode[];
}

const rawTree = data as unknown as SaveTreeData;

/** A node the launcher should offer. Absent field = active (backfill-safe). */
export function isLauncherActive(n: SaveTreeNode): boolean {
  return n.launcher_status !== "dormant";
}

/**
 * The tree as every consumer sees it: dormant nodes removed ONCE, here, so a
 * new consumer can't forget the filter and quietly resurface retired saves.
 * Read `rawTree` directly only if you genuinely need the dormant rows too.
 */
export const saveTreeData: SaveTreeData = {
  ...rawTree,
  nodes: (rawTree.nodes ?? []).filter(isLauncherActive),
};

/** A node with its children resolved, ready for indented rendering. */
export interface TreeEntry {
  node: SaveTreeNode;
  depth: number;
  children: TreeEntry[];
}

const DIFFICULTY_ORDER = ["easy", "med", "medium", "hard"];

/** Difficulties present, in canonical order (Easy → Med → Hard, extras last). */
export function difficulties(): string[] {
  const present = [...new Set(saveTreeData.nodes.map((n) => n.difficulty))];
  return present.sort((a, b) => {
    const ia = DIFFICULTY_ORDER.indexOf(a.toLowerCase());
    const ib = DIFFICULTY_ORDER.indexOf(b.toLowerCase());
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
  });
}

/** Build the directory tree for one difficulty (roots = parent:null, manifest order kept). */
export function treeFor(difficulty: string): TreeEntry[] {
  const nodes = saveTreeData.nodes.filter((n) => n.difficulty === difficulty);
  const build = (parent: string | null, depth: number): TreeEntry[] =>
    nodes
      .filter((n) => n.parent === parent)
      .map((n) => ({ node: n, depth, children: build(n.id, depth + 1) }));
  const roots = build(null, 0);
  // Orphans (parent listed but missing from the sync) still render at top level.
  const seen = new Set<string>();
  const walk = (es: TreeEntry[]) => es.forEach((e) => { seen.add(e.node.id); walk(e.children); });
  walk(roots);
  const orphans = nodes.filter((n) => !seen.has(n.id)).map((n) => ({ node: n, depth: 0, children: build(n.id, 1) }));
  return [...roots, ...orphans];
}

/** Compose the /play deep-link that jumps the prod debug build into this node. */
export function jumpUrl(n: SaveTreeNode): string {
  const p = new URLSearchParams();
  p.set("channel", DEBUG_CHANNEL_ID);
  p.set("scenario", `tree-${n.id}`);
  if (n.packs?.length) p.set("packs", n.packs.join(","));
  return `/play/?${p.toString()}`;
}

// --- narrative-spine outline -------------------------------------------------
// The tree is grouped by the shared story spine (chapter → section), the same
// one the walkthrough renders, instead of by the deep parent chain. Difficulty
// is a filter across the whole outline; nodes list flat within a section by seq.

interface SpineFile {
  chapters: { key: string; label: string; placeholder?: boolean; sections: { key: string; label: string }[] }[];
}
const storySpine = spine as unknown as SpineFile;

export interface OutlineSection {
  key: string;
  label: string;
  nodes: SaveTreeNode[];
}
export interface OutlineChapter {
  key: string;
  label: string;
  sections: OutlineSection[];
}

/**
 * Build the chapter → section → node outline, filtered by difficulty
 * ("all" = every difficulty). Nodes list by `seq` (fallback: label). Sections
 * are kept even when empty — a spine beat with no saves yet (e.g. leaving-laria,
 * the post-boss gap) is CORRECT, not a sync failure, and renders as such.
 * Placeholder chapters (no sections) are dropped.
 */
export function spineOutline(difficulty: string = "all"): OutlineChapter[] {
  const pool = saveTreeData.nodes.filter(
    (n) => difficulty === "all" || n.difficulty === difficulty
  );
  const byCS = new Map<string, SaveTreeNode[]>();
  for (const n of pool) {
    if (!n.chapter || !n.section) continue;
    const k = `${n.chapter}/${n.section}`;
    const list = byCS.get(k) ?? [];
    list.push(n);
    byCS.set(k, list);
  }
  const bySeq = (a: SaveTreeNode, b: SaveTreeNode) =>
    (a.seq ?? Number.MAX_SAFE_INTEGER) - (b.seq ?? Number.MAX_SAFE_INTEGER) ||
    a.label.localeCompare(b.label);

  return storySpine.chapters
    .filter((ch) => !ch.placeholder && (ch.sections?.length ?? 0) > 0)
    .map((ch) => ({
      key: ch.key,
      label: ch.label,
      sections: (ch.sections ?? []).map((sec) => ({
        key: sec.key,
        label: sec.label,
        nodes: (byCS.get(`${ch.key}/${sec.key}`) ?? []).slice().sort(bySeq),
      })),
    }));
}
