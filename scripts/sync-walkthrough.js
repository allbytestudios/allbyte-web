#!/usr/bin/env node
/**
 * sync-walkthrough.js — mirror Quinn's per-scene walkthrough content into App.
 *
 * CONTRACT WITH QUINN (2026-07-20, agreed on the bus):
 *   The markdown is copied VERBATIM, byte-for-byte. This script only ever
 *   COPIES and VALIDATES — it never rewrites her content. Her publish file is
 *   the published file. If sync transformed the prose, the committed copy would
 *   diverge from her source and every "why does prod say X" would need
 *   archaeology through a transform step.
 *
 *   The one thing that IS transformed is images (PNG -> downscaled WebP), and
 *   that's exactly why `screenshots:` entries are bare basenames with no
 *   extension: the renderer resolves the extension, so no frontmatter rewrite
 *   is needed and "verbatim" stays true.
 *
 * Division of ownership:
 *   Quinn -> prose, [L-1.3] codes, checklists, OPTIONAL/MISSABLE/BOSS, recaps
 *   Arc   -> scene adjacency, cond, pack, media (joined on the `scene` FK)
 *
 * PUBLIC-REPO GATE: allbyte-web is public and git history is permanent, so the
 * synced files are linted for internal markers (assumption glyphs, TODOs,
 * coordination-doc and reports/ paths). A stray note fails the sync rather than
 * becoming permanent public history. This is a gate, not a nag — it exits 1.
 *
 *   npm run sync:walkthrough
 *   npm run sync:walkthrough -- --dry-run
 *
 * Env overrides:
 *   WALKTHROUGH_SRC              source dir (default: Quinn's scenes/ dir)
 *   WALKTHROUGH_EXTRA_FORBIDDEN  extra comma-separated literals to reject
 *                                (use for anything that must never ship; not
 *                                hardcoded here because this file is public)
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, copyFileSync, rmSync, statSync } from "node:fs";
import { join, resolve, relative, basename, extname } from "node:path";
import { createRequire } from "node:module";

// js-yaml v4 is CJS with no default ESM export, so a plain `import yaml from`
// throws at load. createRequire works regardless of the module shape.
const yaml = createRequire(import.meta.url)("js-yaml");

// sharp is imported LAZILY, inside the conversion step only. It's a native
// module and isn't installed everywhere the validator needs to run (Quinn
// validates from her container, which has no sharp binary). A top-level import
// made `--dry-run` — pure text validation — fail on a missing image library,
// which defeats the point of a self-check she can run before handing off.

// Host path to the GameDev workspace (Quinn's authoring dir + the game repo).
// No default on purpose: this repo is public, so a hardcoded home directory
// would leak the owner's username into git history permanently.
const GAMEDEV = process.env.GAMEDEV_DIR;
if (!GAMEDEV) {
  console.error("✗ GAMEDEV_DIR is not set.");
  console.error("  Point it at the GameDev workspace root, e.g.");
  console.error("    GAMEDEV_DIR=/path/to/GameDev npm run sync:walkthrough");
  process.exit(1);
}
const SRC_MD = resolve(process.env.WALKTHROUGH_SRC || join(GAMEDEV, "Quinn/reports/walkthrough/scenes"));
const SRC_IMG = resolve(join(GAMEDEV, "Quinn/reports/walkthrough/raw_stills"));
const DEST_MD = resolve("./src/content/walkthrough");
const DEST_IMG = resolve("./public/walkthrough");
const SCENE_GRAPH = resolve("./src/data/walkthrough-scenes.json");

// Responsive widths. Stills live in public/, which Astro deliberately does NOT
// optimize or srcset (that only happens for images under src/). Our shots render
// inside a Svelte island for the lightbox + indicator overlay, and Astro's
// <Image /> can't be used inside one -- so sync IS the image pipeline. We emit
// each width ourselves and the component writes its own srcset.
//
// Measured before this existed: a 390px phone pulled 1.1 MB of stills, each 4x
// larger than the box it rendered into.
const WIDTHS = [480, 800, 1280];
const WEBP_QUALITY = 82;

const dryRun = process.argv.includes("--dry-run");

// --- public-repo lint --------------------------------------------------------
// Each rule is [label, regex]. Matched against the FULL file (frontmatter+body).
const FORBIDDEN = [
  ["assumption marker (\u{1F536})", /\u{1F536}/u],
  ["TODO/FIXME/XXX", /\b(TODO|FIXME|XXX)\b/],
  ["save-tree reference", /save[-_ ]?tree/i],
  ["reports/ path", /\breports\//i],
  ["coordination doc", /\b(QA|CON|APP)_CLAUDE_[A-Z_]+\.md\b/],
  ["absolute local path", /[A-Za-z]:[\\/]Users[\\/]/],
];
for (const extra of (process.env.WALKTHROUGH_EXTRA_FORBIDDEN || "").split(",").map((s) => s.trim()).filter(Boolean)) {
  FORBIDDEN.push([`forbidden term "${extra}"`, new RegExp(extra.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")]);
}

const errors = [];
const warnings = [];
const err = (file, msg) => errors.push(`${file}: ${msg}`);

// --- load the scene inventory (FK target) -----------------------------------
// Two different graphs, deliberately:
//
//   Arc's tools/scene_graph.json  — the AUTHORITATIVE scene inventory (every
//     scene registered in the extractor's SCENES dict, currently 30). This is
//     what "does this scene exist in the game?" actually means, so it's the
//     right FK target. Only readable on the host, but that's fine: sync runs on
//     the host, never in CI.
//
//   App's walkthrough-scenes.json — a CURATED subset (14 Laria-village scenes)
//     carrying render data (displayName, media, exits, callouts). Used for the
//     render-time join, not for existence checks. Validating against this would
//     reject any scene App hasn't curated yet — which is exactly the false
//     failure that blocked the Waterways section.
//
// Fallback keeps the script usable if the game repo isn't mounted.
const ARC_GRAPH = resolve(join(GAMEDEV, "ChroniclesOfNesis/tools/scene_graph.json"));
let sceneIds = new Set();
let fkSource = null;

function loadIds(path, label) {
  try {
    const raw = JSON.parse(readFileSync(path, "utf8"));
    const scenes = raw.scenes;
    const ids = Array.isArray(scenes) ? scenes.map((s) => s.id ?? s) : Object.keys(scenes ?? {});
    if (!ids.length) return false;
    sceneIds = new Set(ids);
    fkSource = label;
    return true;
  } catch {
    return false;
  }
}

if (!(existsSync(ARC_GRAPH) && loadIds(ARC_GRAPH, "Arc scene_graph.json (authoritative)"))) {
  if (existsSync(SCENE_GRAPH) && loadIds(SCENE_GRAPH, "App walkthrough-scenes.json (curated subset)")) {
    warnings.push("Arc's scene_graph.json unavailable — validating against App's narrower curated graph; uncurated scenes will falsely fail");
  } else {
    warnings.push("no scene graph available — skipping FK validation");
  }
}

if (!existsSync(SRC_MD)) {
  console.error(`✗ Source dir not found: ${SRC_MD}`);
  console.error("  Quinn authors per-scene files there. Set WALKTHROUGH_SRC to override.");
  process.exit(1);
}

// --- walk source -------------------------------------------------------------
function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else if (e.name.endsWith(".md")) out.push(full);
  }
  return out;
}

const files = walk(SRC_MD);
if (files.length === 0) {
  console.error(`✗ No .md files under ${SRC_MD}`);
  process.exit(1);
}

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---/;
const REQUIRED = ["code", "scene", "area", "order", "title", "chapter", "section", "step"];
const KNOWN = new Set([...REQUIRED, "kind", "items", "screenshots", "boss", "indicators"]);
const INDICATOR_TARGETS = new Set(["chest", "door", "bed", "npc", "item", "exit"]);

const seenCodes = new Map();
const parsed = [];
const neededStills = new Set();

for (const file of files) {
  const rel = relative(SRC_MD, file);
  const raw = readFileSync(file, "utf8");

  for (const [label, re] of FORBIDDEN) {
    const m = raw.match(re);
    if (m) err(rel, `contains ${label} — "${String(m[0]).slice(0, 40)}" (public repo, permanent history)`);
  }

  const fmMatch = raw.match(FM_RE);
  if (!fmMatch) {
    err(rel, "no YAML frontmatter block found");
    continue;
  }

  let fm;
  try {
    fm = yaml.load(fmMatch[1]);
  } catch (e) {
    err(rel, `frontmatter is not valid YAML: ${e.message}`);
    continue;
  }
  if (!fm || typeof fm !== "object") {
    err(rel, "frontmatter did not parse to an object");
    continue;
  }

  for (const k of REQUIRED) if (fm[k] === undefined) err(rel, `missing required key "${k}"`);
  for (const k of Object.keys(fm)) if (!KNOWN.has(k)) err(rel, `unknown key "${k}" (typo? schema is strict)`);

  if (fm.code !== undefined) {
    if (!/^[A-Z]+-\d+\.\d+$/.test(String(fm.code))) err(rel, `code "${fm.code}" must look like "L-1.3"`);
    if (seenCodes.has(fm.code)) err(rel, `duplicate code "${fm.code}" (also in ${seenCodes.get(fm.code)})`);
    else seenCodes.set(fm.code, rel);
  }

  if (fm.scene !== undefined && sceneIds.size > 0 && !sceneIds.has(String(fm.scene))) {
    err(rel, `scene "${fm.scene}" is not in the scene graph — dead join, would render a broken link`);
  }

  if (fm.items !== undefined) {
    if (!Array.isArray(fm.items)) err(rel, "items must be a list");
    else
      fm.items.forEach((it, i) => {
        if (typeof it !== "object" || it === null) return err(rel, `items[${i}] must be a mapping`);
        for (const k of ["name", "where", "reach"]) if (it[k] === undefined) err(rel, `items[${i}] missing "${k}"`);
        if (it.reach !== undefined && !["main", "optional"].includes(it.reach))
          err(rel, `items[${i}].reach must be "main" or "optional" (got "${it.reach}")`);
        if (it.missable !== undefined && typeof it.missable !== "boolean")
          err(rel, `items[${i}].missable must be true/false`);
      });
  }

  if (fm.screenshots !== undefined) {
    if (!Array.isArray(fm.screenshots)) err(rel, "screenshots must be a list");
    else
      fm.screenshots.forEach((s) => {
        const base = basename(String(s), extname(String(s)));
        if (extname(String(s))) warnings.push(`${rel}: screenshot "${s}" has an extension — use the bare basename`);
        const found = existsSync(SRC_IMG)
          ? readdirSync(SRC_IMG).find((f) => basename(f, extname(f)) === base)
          : null;
        if (!found) err(rel, `screenshot "${base}" not found in raw_stills/`);
        else neededStills.add(found);
      });
  }

  if (fm.indicators !== undefined) {
    if (!Array.isArray(fm.indicators)) err(rel, "indicators must be a list");
    else {
      const shots = (fm.screenshots ?? []).map((s) => basename(String(s), extname(String(s))));
      fm.indicators.forEach((ind, i) => {
        if (typeof ind !== "object" || ind === null) return err(rel, `indicators[${i}] must be a mapping`);
        for (const k of ["label", "x", "y"]) if (ind[k] === undefined) err(rel, `indicators[${i}] missing "${k}"`);
        for (const k of ["x", "y"])
          if (ind[k] !== undefined && typeof ind[k] !== "number") err(rel, `indicators[${i}].${k} must be a number`);
        if (ind.target !== undefined && !INDICATOR_TARGETS.has(ind.target))
          err(rel, `indicators[${i}].target "${ind.target}" not one of ${[...INDICATOR_TARGETS].join("|")}`);
        // An indicator pinned to a still this scene doesn't show would render
        // nowhere -- silent, and very annoying to debug from the page.
        if (ind.screenshot !== undefined) {
          const b = basename(String(ind.screenshot), extname(String(ind.screenshot)));
          if (!shots.includes(b)) err(rel, `indicators[${i}].screenshot "${b}" is not in this scene's screenshots`);
        } else if (shots.length === 0) {
          err(rel, `indicators[${i}] has no screenshot to pin to (scene has none)`);
        }
      });
    }
  }

  // --- inline directive gate (Quinn's requirement, 2026-07-21) --------------
  // remark-directive leaves an unrecognised `::shoot` as literal prose — silent,
  // and invisible on a page full of screenshots. The build enforces this too,
  // but checking here means she catches it from her own container with a dry
  // run, without needing a build or the sharp binary.
  const body = raw.slice(fmMatch[0].length);

  // Scene bodies must not use h1-h3 — the STEP label owns h3, so a body heading
  // at that level or shallower renders as a SIBLING of the step and flattens the
  // outline. Require `####` or deeper. Fenced code is stripped first so a
  // `# comment` inside a code block doesn't trip the check.
  const bodyNoCode = body.replace(/```[\s\S]*?```/g, "");
  const badHeading = bodyNoCode.match(/^(#{1,3})\s+(\S.*)$/m);
  if (badHeading) {
    err(
      rel,
      `body heading "${badHeading[1]} ${badHeading[2].slice(0, 40)}" is h${badHeading[1].length} — the step label owns h1-h3; use "####" or deeper in scene prose`
    );
  }

  const KNOWN_DIRECTIVES = new Set(["shot"]);
  // [^\S\n]* not \s* — with the /m flag \s also matches the preceding newline,
  // which shifts m.index onto the blank line and makes the extracted line empty.
  for (const m of body.matchAll(/^[^\S\n]*(:{2,3})([a-zA-Z][\w-]*)/gm)) {
    const dname = m[2];
    if (!KNOWN_DIRECTIVES.has(dname)) {
      err(rel, `unknown directive "::${dname}" — known: ${[...KNOWN_DIRECTIVES].map((d) => `::${d}`).join(", ")}`);
      continue;
    }
    if (dname === "shot") {
      const line = body.slice(m.index).split("\n")[0];
      const nameAttr = line.match(/\{[^}]*\bname=("?)([\w-]+)\1[^}]*\}/);
      if (!nameAttr) {
        err(rel, `::shot is missing {name=...} — e.g. ::shot[caption]{name=EliasHouse}`);
      } else {
        const shotName = nameAttr[2];
        const found = existsSync(SRC_IMG)
          ? readdirSync(SRC_IMG).find((f) => basename(f, extname(f)) === shotName)
          : null;
        if (!found) err(rel, `::shot{name=${shotName}} has no still in raw_stills/`);
        else neededStills.add(found); // inline shots need converting too
      }
    }
  }

  parsed.push({ file, rel, fm });
}

// order collisions within an area are a rendering bug, not a hard failure
const byArea = {};
for (const p of parsed) (byArea[p.fm.area] ||= []).push(p);
for (const [area, list] of Object.entries(byArea)) {
  const orders = new Map();
  for (const p of list) {
    if (orders.has(p.fm.order)) err(p.rel, `duplicate order ${p.fm.order} in area "${area}" (also ${orders.get(p.fm.order)})`);
    else orders.set(p.fm.order, p.rel);
  }
}

// --- report ------------------------------------------------------------------
console.log(`  source   ${SRC_MD}`);
console.log(`  fk src   ${fkSource ?? "none"} — ${sceneIds.size} valid scene id(s)`);
console.log(`  scenes   ${files.length} file(s), ${Object.keys(byArea).length} area(s)`);
console.log(`  stills   ${neededStills.size} referenced`);
for (const w of warnings) console.log(`  ⚠ ${w}`);

if (errors.length) {
  console.error(`\n✗ ${errors.length} validation error(s) — nothing copied:\n`);
  for (const e of errors) console.error(`   ${e}`);
  process.exit(1);
}

if (dryRun) {
  console.log("\n(dry run — validation passed, nothing written)");
  process.exit(0);
}

// --- copy (verbatim) ---------------------------------------------------------
// Wipe dest first so a scene Quinn deletes doesn't linger in the public repo.
if (existsSync(DEST_MD)) rmSync(DEST_MD, { recursive: true, force: true });
mkdirSync(DEST_MD, { recursive: true });
mkdirSync(DEST_IMG, { recursive: true });

for (const { file, fm } of parsed) {
  const outDir = join(DEST_MD, String(fm.area));
  mkdirSync(outDir, { recursive: true });
  copyFileSync(file, join(outDir, basename(file))); // byte-for-byte, never rewritten
}

let converted = 0;
let skipped = 0;
const { default: sharp } = neededStills.size ? await import("sharp") : { default: null };
const dims = {};

for (const still of neededStills) {
  const src = join(SRC_IMG, still);
  const base = basename(still, extname(still));
  const meta = await sharp(src).metadata();

  // Emit one file per responsive width, skipping any that would upscale.
  for (const w of WIDTHS) {
    if (w > meta.width) continue;
    const out = join(DEST_IMG, `${base}-${w}.webp`);
    if (existsSync(out) && statSync(out).mtimeMs >= statSync(src).mtimeMs) {
      skipped++;
      continue;
    }
    await sharp(src).resize({ width: w, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toFile(out);
    converted++;
  }

  // Widest available is also the un-suffixed fallback (lightbox + no-srcset).
  const widest = WIDTHS.filter((w) => w <= meta.width).pop() ?? meta.width;
  const fallback = join(DEST_IMG, `${base}.webp`);
  if (!existsSync(fallback) || statSync(fallback).mtimeMs < statSync(src).mtimeMs) {
    await sharp(src).resize({ width: widest, withoutEnlargement: true }).webp({ quality: WEBP_QUALITY }).toFile(fallback);
  }

  // Indicator coords are authored in SOURCE-still pixel space; the renderer
  // converts to percentages using these, so markers survive every width and any
  // future change to WIDTHS. width/height also let the renderer reserve space
  // and avoid layout shift.
  dims[base] = { w: meta.width, h: meta.height, widths: WIDTHS.filter((w) => w <= meta.width) };
}

if (sharp) {
  writeFileSync(resolve("./src/data/walkthrough-stills.json"), JSON.stringify(dims, null, 2) + "\n");
}

console.log(`\n✓ Synced ${parsed.length} scene file(s) verbatim → src/content/walkthrough/`);
console.log(`✓ Stills: ${converted} converted, ${skipped} already current → public/walkthrough/`);
console.log("  Commit the results — CI has no access to Quinn's authoring dir.");
