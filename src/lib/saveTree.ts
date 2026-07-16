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
}

export interface SaveTreeData {
  version: number;
  schema: string;
  generated_at: string | null;
  nodes: SaveTreeNode[];
}

export const saveTreeData = data as unknown as SaveTreeData;

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

/** Compose the /play deep-link that jumps the develop build into this node. */
export function jumpUrl(n: SaveTreeNode): string {
  const p = new URLSearchParams();
  p.set("channel", "develop");
  p.set("scenario", `tree-${n.id}`);
  if (n.packs?.length) p.set("packs", n.packs.join(","));
  return `/play/?${p.toString()}`;
}
