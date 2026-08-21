#!/usr/bin/env node
/**
 * check-manual-drift.js — guard the manual snapshot's two layers against each other.
 *
 * public/manual/index.html carries the SAME content twice:
 *   - `manual-bodies`  markdown, the source the admin inline editor loads
 *   - the rendered HTML, what a reader actually sees
 *
 * They are written at different times (a quick HTML patch, a markdown rewrite), and
 * nothing forces them to agree. When they drift the failure is silent AND delayed:
 * the page looks right, and the stale markdown only lands the next time somebody
 * opens that section in the editor and saves — which reverts the newer work.
 *
 * This has bitten three times: a heading renamed in HTML only, an affinity table
 * rebuilt in HTML only, and a figure key purged from the map but left in the
 * markdown. All three would have been caught here.
 *
 * Checks per section: headings, table count + header cells, figure count, and dead
 * image keys. Plus two whole-file checks: orphaned list continuations (the renderer
 * breaks bullets wrapped across lines) and the integrity of the renderer itself,
 * which a careless global regex can silently maim.
 *
 *   node scripts/check-manual-drift.js          # report
 *   node scripts/check-manual-drift.js --quiet  # exit code only
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const FILE = join(process.cwd(), "public", "manual", "index.html");
const quiet = process.argv.includes("--quiet");
const problems = [];
const note = (section, msg) => problems.push({ section, msg });

if (!existsSync(FILE)) {
  console.error("manual snapshot not found:", FILE);
  process.exit(2);
}
const html = readFileSync(FILE, "utf8");

const grab = (id) => {
  const m = html.match(new RegExp(`<script[^>]*id="${id}"[^>]*>([\\s\\S]*?)</script>`));
  return m ? JSON.parse(m[1]) : null;
};
const bodies = grab("manual-bodies");
const images = grab("manual-images");
if (!bodies || !images) {
  console.error("could not read manual-bodies / manual-images");
  process.exit(2);
}

/** The rendered container for a section key, mirroring the page's own proseOf(). */
function renderedFor(key) {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  let m = html.match(new RegExp(`<div class="subprose" data-subsection="${esc}">`));
  if (m) return sliceFrom(m.index + m[0].length);
  const sub = /^([a-z]+):(.+)$/.exec(key);
  if (sub) {
    const c = html.match(new RegExp(`data-${sub[1]}-key="${sub[2].replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`));
    if (c) return sliceFrom(c.index, 4000);
    return null;
  }
  m = html.match(new RegExp(`<section class="leaf"[^>]*data-section="${esc}">`));
  if (!m) return null;
  const p = html.indexOf('<div class="prose"', m.index);
  return p === -1 ? null : sliceFrom(html.indexOf(">", p) + 1);
}
/** Balanced-ish slice: stop at the next section/subsection boundary. */
function sliceFrom(start, cap = 40000) {
  const rest = html.slice(start, start + cap);
  const stop = rest.search(/<div class="subprose" data-subsection=|<section class="leaf"|<div class="leaf-foot">/);
  return stop === -1 ? rest : rest.slice(0, stop);
}

const stripTags = (s) => s.replace(/<[^>]+>/g, "").replace(/&amp;/g, "&").trim();

for (const [key, md] of Object.entries(bodies)) {
  if (typeof md !== "string") continue;
  const rendered = renderedFor(key);
  if (rendered === null) { note(key, "no rendered container found"); continue; }

  // headings
  const mdH = [...md.matchAll(/^##\s+(.+)$/gm)].map((m) => m[1].trim());
  const htH = [...rendered.matchAll(/<h2[^>]*>([\s\S]*?)<\/h2>/g)]
    .map((m) => stripTags(m[1]))
    .filter((h) => !/^(Combat HUD|Damage Types)/.test(h) || mdH.includes(h));
  if (mdH.join(" | ") !== htH.join(" | ")) {
    note(key, `headings differ\n      md: ${mdH.join(" | ") || "(none)"}\n      html: ${htH.join(" | ") || "(none)"}`);
  }

  // tables: count, then header cells
  const mdTables = [...md.matchAll(/^\|(.+)\|\s*\n\s*\|[\s:|-]+\|\s*$/gm)].map((m) =>
    m[1].split("|").map((c) => c.trim().replace(/\*\*/g, "")).join(" · ")
  );
  const htTables = [...rendered.matchAll(/<thead><tr>([\s\S]*?)<\/tr><\/thead>/g)].map((m) =>
    [...m[1].matchAll(/<th>([\s\S]*?)<\/th>/g)].map((c) => stripTags(c[1])).join(" · ")
  );
  if (mdTables.length !== htTables.length) {
    note(key, `table count differs (md ${mdTables.length}, html ${htTables.length})`);
  } else {
    mdTables.forEach((h, i) => {
      if (h !== htTables[i]) note(key, `table ${i + 1} headers differ\n      md: ${h}\n      html: ${htTables[i]}`);
    });
  }

  // figures + dead keys
  const mdImgs = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)].map((m) => m[1]);
  for (const k of mdImgs) if (!(k in images)) note(key, `markdown references missing image key: ${k}`);
  const htImgs = (rendered.match(/<img /g) || []).length;
  if (mdImgs.length > htImgs) note(key, `markdown has ${mdImgs.length} figures, rendered has ${htImgs}`);
}

// --- whole-file checks -------------------------------------------------------
const orphans = (html.match(/<\/li><\/ul>\s*<p>\s{2,}/g) || []).length;
if (orphans) note("(page)", `${orphans} orphaned list continuation(s) — a bullet wrapped across lines`);

if (!/return "<strong>" \+ b \+ "<\/strong>"/.test(html)) {
  note("(page)", "markdown renderer's bold rule is damaged — client-side edits would lose <strong>");
}
for (const [k, v] of Object.entries(images)) {
  if (!existsSync(join(process.cwd(), "public", "manual", v))) note("(assets)", `image key ${k} -> missing file ${v}`);
}

if (!quiet) {
  const sections = Object.keys(bodies).length;
  if (!problems.length) {
    console.log(`manual drift check: OK (${sections} sections, ${Object.keys(images).length} image keys)`);
  } else {
    console.log(`manual drift check: ${problems.length} problem(s)\n`);
    for (const p of problems) console.log(`  [${p.section}] ${p.msg}`);
  }
}
process.exit(problems.length ? 1 : 0);
