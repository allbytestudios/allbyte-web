#!/usr/bin/env node
/**
 * sync-manual.js — ingest the Instruction Booklet into the site.
 *
 * Quinn owns the manual content (manual/*.md) + a render script that produces a
 * self-contained `manual_preview.html` (fonts/paper/sprites/icons embedded as
 * data-URIs). Replicating her render + asset extraction (sprite frames, the
 * venom-slime hue-shift, InputIcons, the HUD shot) in App would be a large,
 * fragile second pipeline — so instead App INGESTS her export:
 *   1. de-inline the data-URIs → public/manual/assets/ (1.6 MB monolith → a lean
 *      page + cached assets),
 *   2. tag each chapter with its section key + expose the per-section base
 *      markdown (from manual/*.md) as a JSON blob, so the inline editor (Part 2)
 *      can bind an Edit affordance to each section and overlay-swap its prose,
 *   3. inject the home back-link.
 * Quinn re-exports → `npm run sync:manual` → live. Skips cleanly if the export
 * isn't present (CI).
 *
 *   npm run sync:manual
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createHash } from "node:crypto";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const CHRONICLES = process.env.CHRONICLES_DIR || join(homedir(), "Desktop/GameDev/ChroniclesOfNesis");
const QUINN = join(dirname(CHRONICLES), "Quinn/reports/walkthrough");
const SRC = join(QUINN, "manual_preview.html");
const MD_DIR = join(QUINN, "manual");
const OUT_DIR = join(root, "public/manual");
const ASSET_DIR = join(OUT_DIR, "assets");
const log = (...a) => console.log("[sync-manual]", ...a);

if (!existsSync(SRC)) {
  log(`export not found (${SRC}) — skipping; committed public/manual/ unchanged.`);
  process.exit(0);
}

// Section order = the TOC (ch1..chN map to these keys, in this order).
const SECTION_ORDER = [
  "story", "cast", "controls", "screen", "exploring", "battle",
  "status_damage", "skills", "growth", "items", "menus", "bestiary", "hints",
];

// --- per-section base markdown bodies (for the editor to bind to) ------------
// Single-file sections keyed by their key; cast/bestiary are per-entry files.
function readMd(rel) {
  const p = join(MD_DIR, rel);
  if (!existsSync(p)) return null;
  const raw = readFileSync(p, "utf8");
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return { body: raw.slice(m ? m[0].length : 0).trim(), key: (raw.match(/(?:^|\n)key:\s*["']?([\w-]+)["']?/) || [])[1] };
}
const bodies = {};
for (const f of ["controls", "screen", "exploring", "battle", "status_damage", "skills", "growth", "items", "menus", "hints", "story"]) {
  const md = readMd(`${f}.md`);
  if (md) bodies[f] = md.body;
}
for (const sub of ["cast", "bestiary"]) {
  const dir = join(MD_DIR, sub);
  if (existsSync(dir)) for (const f of readdirSync(dir).filter((x) => x.endsWith(".md"))) {
    const md = readMd(`${sub}/${f}`);
    if (md?.key) bodies[`${sub}:${md.key}`] = md.body;
  }
}

// --- de-inline data-URIs -----------------------------------------------------
mkdirSync(ASSET_DIR, { recursive: true });
for (const f of existsSync(ASSET_DIR) ? readdirSync(ASSET_DIR) : []) rmSync(join(ASSET_DIR, f), { force: true });
let html = readFileSync(SRC, "utf8");
const EXT = { "font/otf": "otf", "font/ttf": "ttf", "font/woff": "woff", "font/woff2": "woff2",
  "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/svg+xml": "svg", "image/webp": "webp" };
const seen = {};
html = html.replace(/data:([^;,]+);base64,([A-Za-z0-9+/=]+)/g, (_m, mime, blob) => {
  const key = createHash("sha1").update(blob).digest("hex").slice(0, 12);
  if (!seen[key]) {
    const fn = `${key}.${EXT[mime.toLowerCase()] || "bin"}`;
    writeFileSync(join(ASSET_DIR, fn), Buffer.from(blob, "base64"));
    seen[key] = fn;
  }
  return `assets/${seen[key]}`;
});

// --- tag each chapter leaf with its section key ------------------------------
// The render emits `<section class="leaf" id="chN">`; map chN → SECTION_ORDER[N-1].
html = html.replace(/<section class="leaf" id="ch(\d+)"/g, (m, n) => {
  const key = SECTION_ORDER[Number(n) - 1];
  return key ? `<section class="leaf" id="ch${n}" data-section="${key}"` : m;
});

// --- inject the back-link + the base-markdown blob ---------------------------
const BACK = '<a href="/" class="manual-home">← AllByte Studios</a>';
const BACKCSS = ".manual-home{position:fixed;top:12px;left:14px;z-index:60;font-family:'ModernGoth',Georgia,serif;font-size:14px;color:var(--gilt,#9a7736);text-decoration:none;background:rgba(0,0,0,.22);padding:4px 11px;border-radius:5px;}.manual-home:hover{color:var(--crimson,#8a2b21);}</style>";
html = html.replace("</style>", BACKCSS, 1);
const bodiesJson = JSON.stringify(bodies).replace(/</g, "\\u003c");
const BLOB = `<script type="application/json" id="manual-bodies">${bodiesJson}</script>`;
if (!/<html/i.test(html)) {
  html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Instruction Booklet — The Chronicles of Nesis</title>' +
    '<meta name="description" content="The Chronicles of Nesis instruction booklet — world, cast, controls, combat, and bestiary.">' +
    '<meta name="theme-color" content="#cdbf9f"></head><body>' + BACK + html + BLOB + '</body></html>';
} else {
  html = html.replace(/(<body[^>]*>)/i, (m) => m + BACK).replace(/<\/body>/i, BLOB + "</body>");
}

writeFileSync(join(OUT_DIR, "index.html"), html);
const total = readdirSync(ASSET_DIR).reduce((n, f) => n, 0);
log(`de-inlined ${Object.keys(seen).length} asset(s); ${Object.keys(bodies).length} section bodies exposed.`);
log(`wrote public/manual/index.html (${Math.round(html.length / 1024)} KB). Commit public/manual/.`);
