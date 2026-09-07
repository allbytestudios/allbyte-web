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
 * The game version the booklet has actually been VERIFIED against — pinned by
 * hand, deliberately NOT read from game-version.json.
 *
 * "Describes version X" is a claim about content, not about build timing. If it
 * tracked the deployed version it would re-state itself on every game promote,
 * silently asserting that chapters nobody has re-read still match a build
 * nobody has checked them against. That is the exact failure this booklet has
 * already had once: a change that looked verified because the check was
 * measuring the wrong thing.
 *
 * BUMP THIS ONLY after re-reading the affected chapters against the new build.
 * It is meant to be a small act of friction.
 *
 * Verified 2026-09-06 against 0.8.2592 (c959ab5a): initiative trigger, turn
 * economy, the status-stack model, the combat log, controller + battle speed,
 * Mother Slime reach, and the auto-save indicator.
 */
const VERIFIED_AGAINST = "0.8.2592";

// Deployed version, for the drift note below only.
let deployed = "";
try {
  const raw = JSON.parse(readFileSync(versionPath, "utf8"));
  deployed = String(raw.version || "").replace(/^v/, "");
} catch {
  warn("could not read game-version.json");
}
const game = VERIFIED_AGAINST;
if (deployed && deployed !== VERIFIED_AGAINST) {
  console.warn(
    `[stamp-manual] NOTE: booklet verified against ${VERIFIED_AGAINST}, game now ` +
      `${deployed}. The colophon keeps saying ${VERIFIED_AGAINST} until someone ` +
      `re-checks the chapters and bumps VERIFIED_AGAINST.`,
  );
}

// Commit: what confirms the deploy. CI checks out at a depth that still has
// HEAD, but guard anyway — a shallow or absent git dir must not fail a build.
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
if (game) parts.push(`Describes version ${game}`);
if (commit) parts.push(`booklet ${commit}`);
parts.push(date);
const stamp = parts.join(" · ");

html = html.replaceAll(PLACEHOLDER, stamp);
writeFileSync(manualPath, html);

console.log(`[stamp-manual] stamped: ${stamp}`);
