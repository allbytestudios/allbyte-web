/**
 * Scene-graph walkthrough data layer (the 2026-06-16 design).
 *
 * This is the NEW model: the walkthrough is a scene-graph map. Each scene is
 * a node (screenshot/video + guide prose + callouts); exits are directed edges
 * between scenes. The page renders `canonicalOrder` as a linear magazine scroll.
 *
 * Source of truth (eventually): Arc's `tools/extract_scene_graph.py` emits the
 * full graph; AppC consumes a per-scope JSON (here, Laria). Today this loads the
 * hand-authored STUB at src/data/walkthrough-scenes.json so the page renders
 * before the real graph + per-scene captures exist.
 *
 * NOTE: the older chapter-based model in walkthrough.ts is dormant — superseded
 * by this file. Left in place to avoid churn; safe to remove once this lands.
 */

import graphData from "../data/walkthrough-scenes.json";

export type SceneKind =
  | "village"
  | "dungeon"
  | "overworld"
  | "interior"
  | "title"
  | "cinematic";

export type PartyPreset = "newgame" | "early" | "midgame" | "lategame";

export type CalloutKind = "tip" | "secret" | "warning" | "lore" | "music";

export interface Callout {
  kind: CalloutKind;
  title: string;
  body: string;
}

export interface SceneExit {
  /** Target scene id (or an out-of-scope label when external). */
  to: string;
  label: string;
  bidirectional: boolean;
  /** True when the target is outside this walkthrough scope (Overworld, Waterways). */
  external?: boolean;
}

export interface SceneMedia {
  /** Filename of the looping clip under the captures prefix, or null until captured. */
  clip: string | null;
  thumb: string | null;
  still: string | null;
}

export interface WalkScene {
  id: string;
  displayName: string;
  kind: SceneKind;
  pack: string;
  condGate: number | null;
  music: string | null;
  partyPreset: PartyPreset;
  /** Parent hub scene id for interiors (village = parent node, interiors = children). */
  parentScene: string | null;
  cameraHint: { x: number; y: number; zoom: number } | null;
  media: SceneMedia;
  lead: string;
  guide: string;
  exits: SceneExit[];
  callouts: Callout[];
  /** Items/treasure/shop stock found in this scene (display strings). */
  items: string[];
}

export interface WalkSceneGraph {
  version: number;
  generatedAt: string;
  scope: string;
  stub?: boolean;
  description?: string;
  startScene: string;
  canonicalOrder: string[];
  scenes: WalkScene[];
}

export const sceneGraph = graphData as unknown as WalkSceneGraph;

const byId = new Map(sceneGraph.scenes.map((s) => [s.id, s]));

export function sceneById(id: string): WalkScene | undefined {
  return byId.get(id);
}

/** Scenes in the canonical scroll order (skips any id that isn't in the graph). */
export function scenesInOrder(): WalkScene[] {
  return sceneGraph.canonicalOrder
    .map((id) => byId.get(id))
    .filter((s): s is WalkScene => s !== undefined);
}

/** True when an exit target is a real, in-scope, scrollable scene. */
export function isInternalExit(exit: SceneExit): boolean {
  return !exit.external && byId.has(exit.to);
}

export const CALLOUT_GLYPH: Record<CalloutKind, string> = {
  tip: "➤",
  secret: "✦",
  warning: "⚠",
  lore: "❧",
  music: "♪",
};

export const KIND_LABEL: Record<SceneKind, string> = {
  village: "Village",
  dungeon: "Dungeon",
  overworld: "Overworld",
  interior: "Interior",
  title: "Title",
  cinematic: "Cinematic",
};

const PRESET_LABEL: Record<PartyPreset, string> = {
  newgame: "New game",
  early: "Early",
  midgame: "Mid-game",
  lategame: "Late game",
};

export function presetLabel(p: PartyPreset): string {
  return PRESET_LABEL[p] ?? p;
}

/**
 * Resolve the looping-clip URL for a scene, or null if not yet captured.
 * Prod captures land under /captures/<scope>/<sceneId>/...; until the capture
 * pipeline runs against _testWarpToScene, media is null and the UI shows a
 * "capture pending" placeholder.
 */
const CAPTURES_BASE = "/captures";
export function sceneClipUrl(scene: WalkScene): string | null {
  if (!scene.media.clip) return null;
  return `${CAPTURES_BASE}/${sceneGraph.scope}/${scene.id}/${scene.media.clip}`;
}
export function sceneStillUrl(scene: WalkScene): string | null {
  const f = scene.media.still ?? scene.media.thumb;
  if (!f) return null;
  return `${CAPTURES_BASE}/${sceneGraph.scope}/${scene.id}/${f}`;
}
