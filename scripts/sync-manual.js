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
import { normalizeDashes } from "./dash-normalize.js";

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

// Map a chapter TITLE -> its section key. Title-based (not positional) so it
// survives Quinn reordering / adding / dropping sections in the export. Most
// specific first; each real title matches exactly one rule.
const TITLE_RULES = [
  [/prolog|story/i, "story"],
  [/cast|character/i, "cast"],
  [/control/i, "controls"],
  [/screen|hud/i, "screen"],
  [/explor/i, "exploring"],
  [/battle|combat/i, "battle"],
  [/damage/i, "status_damage"],
  [/growth/i, "growth"],
  [/skill/i, "skills"],
  [/item|equip/i, "items"],
  [/menu/i, "menus"],
  [/bestiary|enem/i, "bestiary"],
  [/hint|tips/i, "hints"],
];
const titleToKey = (title) => {
  for (const [re, key] of TITLE_RULES) if (re.test(title)) return key;
  return null;
};

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
// "difficulty" intentionally absent: the game is pinned to Medium and the
// difficulty track is dormant (owner 2026-08-07), so the manual no longer
// carries that chapter. Re-add here (and to TITLE_RULES) if it ever returns.
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

// --- tag each chapter leaf with its section key (by title) -------------------
// The render emits `<section class="leaf" id="chN">…<h1 class="chapter">Title<`.
// Derive the key from the Title so reordering/dropping sections can't misalign it.
html = html.replace(
  /(<section class="leaf" id="ch\d+")([\s\S]*?<h1 class="chapter">([^<]+)<)/g,
  (m, open, mid, title) => {
    const key = titleToKey(title.trim());
    return key ? `${open} data-section="${key}"${mid}` : m;
  }
);

// --- per-character cast cards: data-cast-key + wrap each card's bio -----------
// The Characters chapter renders one <div class="charcard"> per character; the
// frontmatter (portrait, statblock, quote) renders first, then the BODY (cast/
// <key>.md) as loose <p>s. Tag each card by its figcaption name and wrap the body
// region (after the quote, up to the next card / leaf-foot) in .charbio, so the
// inline editor can bind a per-character Edit -> cast:<key> without touching the
// frontmatter (spine guard) or the chapter footer.
const CAST_NAME_KEY = { elias: "elias", falmri: "falmri", mia: "mia" };
html = html.replace(
  /(<section class="leaf"[^>]*data-section="cast"[\s\S]*?)(?=<section class="leaf"|<\/body>)/,
  (leaf) => leaf.replace(
    /(<div class="charcard")([\s\S]*?)(?=<div class="charcard"|<div class="leaf-foot"|<\/section>)/g,
    (card, open, rest) => {
      const fig = /<figcaption[^>]*>([^<]+)</.exec(card);
      if (!fig) return card;
      const key = CAST_NAME_KEY[fig[1].trim().split(/\s+/)[0].toLowerCase()];
      if (!key) return card;
      let tagged = `${open} data-cast-key="${key}"${rest}`;
      const qi = tagged.indexOf("char-quote");
      const pe = qi >= 0 ? tagged.indexOf("</p>", qi) : -1;
      if (pe >= 0) {
        const cut = pe + 4;
        tagged = tagged.slice(0, cut) + '<div class="prose charbio">' + tagged.slice(cut) + "</div>";
      }
      return tagged;
    }
  )
);

// --- inject the back-link + the base-markdown blob ---------------------------
const BACK = '<a href="/" class="manual-home">← AllByte Studios</a>';
const EDITOR_CSS =
  ".manual-home{position:fixed;top:12px;left:14px;z-index:60;font-family:'ModernGoth',Georgia,serif;font-size:14px;color:var(--gilt,#9a7736);text-decoration:none;background:rgba(0,0,0,.22);padding:4px 11px;border-radius:5px;}.manual-home:hover{color:var(--crimson,#8a2b21);}" +
  ".manual-edit-btn{font-family:'ModernGoth',Georgia,serif;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--crimson,#8a2b21);background:rgba(138,43,33,.08);border:1px solid rgba(138,43,33,.35);border-radius:4px;padding:2px 9px;cursor:pointer;margin-left:.6em;}.manual-edit-btn:hover{background:rgba(138,43,33,.16);}.leaf[data-overridden] .manual-edit-btn::after{content:' · edited';color:var(--gilt,#9a7736);}" +
  "[data-cast-key]{position:relative;}[data-cast-key] .manual-edit-btn{position:absolute;top:10px;right:10px;margin:0;z-index:5;}[data-cast-key][data-overridden] .manual-edit-btn::after{content:' · edited';color:var(--gilt,#9a7736);}" +
  ".me-scrim{position:fixed;inset:0;z-index:200;background:rgba(30,22,10,.5);}" +
  ".me-panel{position:fixed;z-index:201;left:50%;top:50%;transform:translate(-50%,-50%);width:min(680px,94vw);max-height:90vh;display:flex;flex-direction:column;background:#f4ecd7;color:#2c2118;border:1px solid #9a7736;border-radius:8px;box-shadow:0 12px 40px rgba(30,22,10,.5);font-family:'ModernGoth',Georgia,serif;padding:1rem 1.1rem 1.1rem;}" +
  ".me-head{display:flex;align-items:center;justify-content:space-between;font-size:1rem;}.me-head b{color:#8a2b21;}.me-x{background:none;border:0;font-size:1.3rem;line-height:1;cursor:pointer;color:#5f5140;padding:.1rem .35rem;}.me-hint{margin:.35rem 0 .6rem;font-size:.8rem;color:#5f5140;}" +
  ".me-md{width:100%;min-height:280px;flex:1;resize:vertical;font-family:'Courier New',monospace;font-size:.85rem;line-height:1.55;color:#2c2118;background:#fbf5e6;border:1px solid #b8974e;border-radius:5px;padding:.7rem .8rem;}" +
  ".me-note-l{display:block;margin:.7rem 0 0;font-size:.82rem;color:#5f5140;}.me-opt{color:#9a7736;font-style:italic;}.me-note{display:block;width:100%;margin-top:.3rem;font-family:'ModernGoth',Georgia,serif;font-size:.85rem;color:#2c2118;background:#fbf5e6;border:1px solid #b8974e;border-radius:5px;padding:.45rem .6rem;}" +
  ".me-actions{display:flex;justify-content:flex-end;gap:.6rem;margin-top:.9rem;}.me-cancel,.me-save{font-family:'ModernGoth',Georgia,serif;font-size:.85rem;padding:.45rem 1rem;border-radius:5px;cursor:pointer;}.me-cancel{background:none;border:1px solid #9a7736;color:#5f5140;}.me-save{background:#8a2b21;border:1px solid #6e2018;color:#f4ecd7;}.me-save:disabled{opacity:.55;cursor:default;}" +
  ".me-toast{position:fixed;z-index:220;left:50%;bottom:1.4rem;transform:translateX(-50%);background:#3a5a34;color:#eafaea;font-family:'ModernGoth',Georgia,serif;font-size:.85rem;padding:.55rem 1rem;border-radius:6px;box-shadow:0 6px 20px rgba(0,0,0,.35);}.me-toast.err{background:#6e2b21;color:#fbeae8;}" +
  "</style>";
html = html.replace("</style>", EDITOR_CSS, 1);
const bodiesJson = JSON.stringify(bodies).replace(/</g, "\\u003c");
const BLOB = `<script type="application/json" id="manual-bodies">${bodiesJson}</script>`;
// Inject the inline editor (admin-gated client). MANUAL_API = the deployed
// allbyte-studio-manual-overlay stack.
const MANUAL_API = "https://2qvnqlwv78.execute-api.us-east-1.amazonaws.com";
const editorJsPath = join(root, "scripts/manual-editor.js");
// The client editor renders overrides through the same dash normalizer, so prepend
// its source (export stripped) ahead of the editor IIFE — one source of truth.
// Strip EVERY `export ` (the module has two: normalizeDashes + normalizeDashesMd);
// a stray `export` in a plain <script> throws "Unexpected token 'export'" and kills
// the whole editor bundle (no overlay apply, no Edit buttons).
const NORM_SRC = readFileSync(join(root, "scripts/dash-normalize.js"), "utf8").replace(/^export\s+/gm, "");
const EDITOR = existsSync(editorJsPath)
  ? `<script>${NORM_SRC}\n${readFileSync(editorJsPath, "utf8").replace("%%MANUAL_API%%", MANUAL_API).replace(/<\/(script)/gi, "<\\/$1")}</script>`
  : "";
if (!/<html/i.test(html)) {
  html = '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Instruction Booklet — The Chronicles of Nesis</title>' +
    '<meta name="description" content="The Chronicles of Nesis instruction booklet — world, cast, controls, combat, and bestiary.">' +
    '<meta name="theme-color" content="#cdbf9f"></head><body>' + BACK + html + BLOB + EDITOR + '</body></html>';
} else {
  html = html.replace(/(<body[^>]*>)/i, (m) => m + BACK).replace(/<\/body>/i, BLOB + EDITOR + "</body>");
}

// House rule: no em-dashes (AI tell). Strip them from all visible prose as the
// final step — masks <script>/<style>/comments so injected code is untouched.
html = normalizeDashes(html);
writeFileSync(join(OUT_DIR, "index.html"), html);
const total = readdirSync(ASSET_DIR).reduce((n, f) => n, 0);
log(`de-inlined ${Object.keys(seen).length} asset(s); ${Object.keys(bodies).length} section bodies exposed.`);
log(`wrote public/manual/index.html (${Math.round(html.length / 1024)} KB). Commit public/manual/.`);
