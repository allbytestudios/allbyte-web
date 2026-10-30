/**
 * Episode-One save catalogue (Quinn's autoplay coverage map).
 *
 * `src/data/save-catalogue.json` is mirrored from Quinn/published/save_catalogue.json
 * by `npm run sync:catalogue`. Each node is a (story cond, level) point on the
 * chain-legal Ep1 save chain: captured, a gap autoplay is driving toward, or
 * save-disabled. Contract: QA_CLAUDE_SAVE_TREE_VIZ_FOR_APP.md.
 *
 * Jumping reuses the save-tree launcher path unchanged. A covered node is
 * jumpable only when its `jump.id` is a node of the shared registry, because
 * only registry saves are mirrored same-origin. Anything else is captured but
 * not yet promoted, and renders that way instead of offering a dead link.
 */

import data from "../data/save-catalogue.json";
import { registryNode, jumpUrl } from "./saveTree";

export type CatalogueStatus = "covered" | "gap" | "skip";

export interface CatalogueNode {
  cond: number;
  level: number;
  note: string;
  status: CatalogueStatus;
  /** gaps only: next = the current drive, future = later (L5 / boss) */
  tier?: "next" | "future";
  jump?: { id: string; source?: string; scene?: string; chain_legal: boolean; story_legal: boolean };
}

export interface CatalogueFrontier {
  reached_level?: number;
  reached_scene?: string;
  reached_depth_bfs?: number;
  status?: string;
  note?: string;
}

export interface SaveCatalogue {
  title: string;
  as_of: string | null;
  synced_at: string;
  covered: number;
  savable_total: number;
  target_level?: number;
  frontier: CatalogueFrontier | null;
  nodes: CatalogueNode[];
}

export const saveCatalogue = data as unknown as SaveCatalogue;

/** The /play deep-link for a covered node, or null when its save isn't promoted. */
export function catalogueJumpUrl(n: CatalogueNode): string | null {
  if (n.status !== "covered" || !n.jump) return null;
  const reg = registryNode(n.jump.id);
  return reg ? jumpUrl(reg) : null;
}

/** Coarse act grouping for the rail: the story beats, the level grind, the boss/ending. */
export interface CatalogueAct {
  key: "story" | "grind" | "boss";
  label: string;
  sub: string;
  nodes: CatalogueNode[];
}

export function catalogueActs(c: SaveCatalogue = saveCatalogue): CatalogueAct[] {
  // The grind is the one cond where level climbs; everything before it is the
  // story chain at L1 and everything after is the boss and ending.
  const levels = new Map<number, Set<number>>();
  for (const n of c.nodes) (levels.get(n.cond) ?? levels.set(n.cond, new Set()).get(n.cond)!).add(n.level);
  const grindCond = [...levels].find(([, ls]) => ls.size > 1)?.[0];
  const byOrder = (a: CatalogueNode, b: CatalogueNode) => a.cond - b.cond || a.level - b.level;
  const range = (ns: CatalogueNode[]) => {
    if (!ns.length) return "";
    const lo = Math.min(...ns.map((n) => n.cond)), hi = Math.max(...ns.map((n) => n.cond));
    return lo === hi ? `cond ${lo}` : `cond ${lo}–${hi}`;
  };
  const story = c.nodes.filter((n) => grindCond == null || n.cond < grindCond).sort(byOrder);
  const grind = grindCond == null ? [] : c.nodes.filter((n) => n.cond === grindCond).sort(byOrder);
  const boss = grindCond == null ? [] : c.nodes.filter((n) => n.cond > grindCond).sort(byOrder);
  const lv = (ns: CatalogueNode[]) => {
    const l = ns.map((n) => n.level);
    return l.length ? (Math.min(...l) === Math.max(...l) ? `L${l[0]}` : `L${Math.min(...l)}→L${Math.max(...l)}`) : "";
  };
  return [
    { key: "story" as const, label: "Story", sub: `${range(story)} · ${lv(story)}`, nodes: story },
    { key: "grind" as const, label: "Grind", sub: `${range(grind)} · ${lv(grind)}`, nodes: grind },
    { key: "boss" as const, label: "Boss / End", sub: `${range(boss)} · ${lv(boss)}`, nodes: boss },
  ].filter((a) => a.nodes.length);
}
