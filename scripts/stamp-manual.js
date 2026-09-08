#!/usr/bin/env node
/**
 * Post-build step: replace the __MANUAL_STAMP__ placeholder in
 * dist/manual/index.html with a printer's mark naming the game version this
 * booklet documents and the commit that built it.
 *
 * Why this exists: the booklet's edits are almost all prose inside existing
 * chapters, so a correct deploy looks identical to a stale one at a glance.
 * That cost real time — the owner checked a freshly-deployed manual several
 * times and reasonably concluded nothing had shipped, because nothing looked
 * different. The site footer's build stamp already settles that question for
 * the rest of the site; this gives the booklet the same answer in its own
 * voice. Same reasoning as inject-sw-version.js: a build should be able to
 * tell you what it is.
 *
 * The mark carries TWO facts, because they answer different questions:
 *   - the GAME version, so a reader can tell whether the booklet has caught
 *     up with the build they are playing;
 *   - the COMMIT, so a deploy can be confirmed as live without guessing.
 *
 * public/ is copied verbatim by Astro, so the placeholder must be rewritten
 * in dist/ rather than in the source file — that keeps the committed booklet
 * free of a value that would go stale on every commit.
 *
 * Non-fatal by design, unlike inject-sw-version.js. A missing stamp is a
 * cosmetic loss; a missing SW version silently breaks cache invalidation.
 * Refusing to publish the booklet over a colophon would be the wrong trade,
 * so this warns and leaves the page otherwise intact.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");

const manualPath = join(root, "dist", "manual", "index.html");
const versionPath = join(root, "src", "data", "game-version.json");
const versionsPath = join(root, "src", "data", "content-versions.json");
const PLACEHOLDER = "__MANUAL_STAMP__";

function warn(msg) {
  console.warn(`[stamp-manual] ${msg} — booklet published without a stamp.`);
}

if (!existsSync(manualPath)) {
  warn("dist/manual/index.html not found");
  process.exit(0);
}

let html = readFileSync(manualPath, "utf8");

if (!html.includes(PLACEHOLDER)) {
  // Already stamped (idempotent re-run), or the placeholder was removed from
  // the source. Either way there is nothing safe to do.
  console.log("[stamp-manual] no placeholder present; nothing to do.");
  process.exit(0);
}

/**
 * The booklet's own semantic version and the game build it was verified against,
 * both hand-maintained in src/data/content-versions.json.
 *
 * Semver rather than a git sha because a hash cannot be COMPARED. "Booklet
 * ec589de" tells you which build shipped but not whether it is newer than the
 * one you last read, nor how far apart they are. 1.4.0 sorts; a hash does not.
 * The sha is still exposed (window.__MANUAL_BUILD, and the title attribute) for
 * confirming a deploy landed — that is a different question from "is this
 * content current", and conflating them is what made the stamp hard to use.
 *
 * "Describes version X" is a claim about CONTENT, not build timing, so X is
 * pinned by hand. If it tracked the deployed game it would re-state itself on
 * every promote, silently asserting that chapters nobody re-read still match a
 * build nobody checked them against.
 */
let bookletVersion = "";
let verifiedAgainst = "";
try {
  const cv = JSON.parse(readFileSync(versionsPath, "utf8"));
  bookletVersion = String(cv.manual?.version || "");
  verifiedAgainst = String(cv.manual?.verifiedAgainst || "");
} catch {
  warn("could not read content-versions.json");
}

// Deployed version, for the drift note below only.
let deployed = "";
try {
  const raw = JSON.parse(readFileSync(versionPath, "utf8"));
  deployed = String(raw.version || "").replace(/^v/, "");
} catch {
  warn("could not read game-version.json");
}
if (deployed && verifiedAgainst && deployed !== verifiedAgainst) {
  console.warn(
    `[stamp-manual] NOTE: booklet ${bookletVersion} verified against ` +
      `${verifiedAgainst}, game now ${deployed}. The colophon keeps saying ` +
      `${verifiedAgainst} until someone re-reads the chapters and bumps ` +
      `content-versions.json.`,
  );
}

// Commit: confirms a deploy landed. Kept OFF the visible line (see above) but
// carried on the element, so "is this live?" stays answerable without making
// "is this current?" harder to read. Guarded — a shallow or absent git dir must
// not fail a build.
let commit = "";
try {
  commit = execSync("git rev-parse --short HEAD", {
    cwd: root,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
} catch {
  warn("could not read git HEAD");
}

const date = new Date().toLocaleDateString("en-GB", {
  day: "numeric",
  month: "long",
  year: "numeric",
});

// Reads as a print run marking rather than a changelog: the booklet is a
// 1990s artefact and a build hash sitting in it should look like a printer's
// code, not telemetry.
const parts = [];
if (bookletVersion) parts.push(`Booklet ${bookletVersion}`);
if (verifiedAgainst) parts.push(`describes ${verifiedAgainst}`);
parts.push(date);
const stamp = parts.join(" · ");

html = html.replaceAll(PLACEHOLDER, stamp);
// The sha stays reachable for "did my deploy land?" without cluttering a line
// whose job is "is this content current?".
if (commit) {
  html = html.replace('<p class="colophon" id="colophon">', `<p class="colophon" id="colophon" title="build ${commit}" data-build="${commit}">`);
}
writeFileSync(manualPath, html);

console.log(`[stamp-manual] stamped: ${stamp}`);
