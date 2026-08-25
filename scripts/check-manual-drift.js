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
    if (!c) return null;
    // Only this card's .charbio — that is precisely what applyOne() replaces.
    // A flat 4000-char slice ran on into the NEXT character's card, so every
    // neighbour's bio read as prose missing from this one's markdown.
    const b = html.indexOf('<div class="prose charbio">', c.index);
    if (b === -1) return sliceFrom(c.index, 4000);
    const open = b + '<div class="prose charbio">'.length;
    const close = html.indexOf("</div>", open);
    return close === -1 ? sliceFrom(open, 4000) : html.slice(open, close);
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

/** Comparable prose: one quote glyph, no markup, no punctuation, one spacing. */
const normProse = (s) =>
  s
    .replace(/&#39;|&rsquo;|’/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ") // markdown images
    .replace(/<[^>]+>/g, " ")
    .replace(/[*`_#>|]/g, " ") // markdown markers
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

// Compare PARAGRAPH prose only, in both layers. Everything else in the rendered
// layer — tables, figures, annotated plates, keycap diagrams, `.char-quote`,
// headings — is either hand-authored structure markdown cannot round-trip, or
// already has its own dedicated check above. Comparing it produced 30+ false
// positives and a checker nobody would trust.
const splitSentences = (t) =>
  normProse(t)
    .split(/(?<=[.:!?])\s+/)
    // Fragments this short are labels and list stubs — too noisy to compare.
    .filter((s) => s.split(" ").length >= 6);

/** Markdown paragraph text: drop table rows and headings, strip image syntax. */
const mdProseText = (md) =>
  md
    .split("\n")
    .filter((l) => !/^\s*[|#]/.test(l))
    .join("\n")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ");

/** Rendered paragraph text: <p> only, minus the deliberately-uneditable ones. */
const htProseText = (h) => {
  const cleaned = h
    .replace(/<table[\s\S]*?<\/table>/g, " ")
    .replace(/<figure[\s\S]*?<\/figure>/g, " ")
    .replace(/<svg[\s\S]*?<\/svg>/g, " ");
  const out = [];
  // <li> too: several sections (Hints, the Skills lead-in) are bullet lists, and
  // those ARE editable prose — excluding them made every list look like drift.
  for (const m of cleaned.matchAll(/<(p|li)(?: [^>]*)?>([\s\S]*?)<\/\1>/g)) {
    if (/class="char-quote"/.test(m[0])) continue; // sits outside .charbio by design
    out.push(m[2]);
  }
  return out.join("\n");
};

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

  // prose parity — the words, not just the shape
  //
  // Every check above passed while 17 sentences had silently diverged across 4
  // sections (2026-08-23): a section keeps its headings, tables and figures and
  // still loses its words. The reverse direction is the dangerous one — prose
  // the PAGE has but the markdown lacks is deleted the moment an admin opens
  // that section and saves.
  const htProse = normProse(htProseText(rendered));
  const mdProse = normProse(mdProseText(md));
  for (const s of splitSentences(mdProseText(md))) {
    if (!htProse.includes(s))
      note(key, `markdown sentence is not on the page: "${s.slice(0, 72)}…"`);
  }
  for (const s of splitSentences(htProseText(rendered))) {
    if (!mdProse.includes(s))
      note(key, `page prose missing from the editor markdown (an edit would DELETE it): "${s.slice(0, 72)}…"`);
  }
}

// --- whole-file checks -------------------------------------------------------
const orphans = (html.match(/<\/li><\/ul>\s*<p>\s{2,}/g) || []).length;
if (orphans) note("(page)", `${orphans} orphaned list continuation(s) — a bullet wrapped across lines`);

if (!/return "<strong>" \+ b \+ "<\/strong>"/.test(html)) {
  note("(page)", "markdown renderer's bold rule is damaged — client-side edits would lose <strong>");
}

// Unbalanced <div> inside a chapter escapes that chapter and closes .booklet
// early, so every chapter after it renders at a different width — and a stray
// open leaks its layout (a two-column .cf-row swallowed a whole chapter once).
// Neither shows up as a content mismatch, so check the structure directly.
for (const m of html.matchAll(/<section class="leaf"[^>]*data-section="([a-z_:]+)"/g)) {
  const end = html.indexOf("</section>", m.index);
  const seg = html.slice(m.index, end === -1 ? undefined : end);
  const opens = (seg.match(/<div\b/g) || []).length;
  const closes = (seg.match(/<\/div>/g) || []).length;
  if (opens !== closes) {
    note(m[1], `unbalanced <div>: ${opens} open vs ${closes} closed (${opens - closes > 0 ? "leaks into" : "escapes"} the rest of the booklet)`);
  }

  // Inline emphasis has to balance too, and it fails LOUDER than a stray div.
  // ModernGoth ships a single weight, so an unclosed <strong> makes the parser
  // re-open it across the following blocks and everything downstream inherits
  // font-weight:700 -> SYNTHETIC bold, i.e. whole chapters of smeared text.
  // A 2026-08-25 copy pass left six of these (as `<strong><strong>`) and they
  // bolded most of the booklet; div-balance was green throughout, which is why
  // this check exists separately.
  for (const tag of ["strong", "em"]) {
    const o = (seg.match(new RegExp(`<${tag}\\b`, "g")) || []).length;
    const c = (seg.match(new RegExp(`</${tag}>`, "g")) || []).length;
    if (o !== c) {
      note(m[1], `unbalanced <${tag}>: ${o} open vs ${c} closed — the parser will re-open it across the following blocks, inheriting synthetic bold`);
    }
    const doubled = (seg.match(new RegExp(`<${tag}\\b[^>]*><${tag}\\b`, "g")) || []).length;
    if (doubled) {
      note(m[1], `${doubled} doubled <${tag}><${tag}> — an unpaired opener`);
    }
  }
}
for (const [k, v] of Object.entries(images)) {
  if (!existsSync(join(process.cwd(), "public", "manual", v))) note("(assets)", `image key ${k} -> missing file ${v}`);
}

// Rendered <img> carry RESOLVED paths; the markdown carries logical keys. Rebuild
// an asset without re-rendering and the HTML keeps pointing at the old hash — the
// file still exists, so nothing 404s and the page silently shows the stale art.
// (Cost me the relic's flash animation once already.)
//
// Scoped to the rendered prose containers: that is the content generated FROM the
// markdown, so it is the only place the two layers have to agree. Portraits and
// other page chrome sit outside prose and legitimately have no image key.
const live = new Set(Object.values(images));
const stale = new Map();
for (const key of Object.keys(bodies)) {
  let rendered = renderedFor(key);
  if (!rendered) continue;
  // Cast portraits are card chrome, not markdown output — they live in
  // .figure.portrait inside .charcard and have no logical key by design.
  rendered = rendered.replace(/<div class="figure portrait">[\s\S]*?<\/div>/g, "");
  for (const m of rendered.matchAll(/<img\b[^>]*\bsrc="(assets\/[^"]+)"/g)) {
    if (!live.has(m[1])) stale.set(m[1], key);
  }
}
for (const [v, key] of stale) {
  note(key, `rendered <img> points at ${v}, which no image key resolves to — asset rebuilt without re-rendering`);
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
