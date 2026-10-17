#!/usr/bin/env node
/**
 * check-imports-tracked.mjs — refuse to push a tracked file that imports an
 * UNtracked one.
 *
 * WHY THIS EXISTS (three times, same shape):
 *   2026-10-14  4f92bdf  swept ../lib/local-driving          → caught pre-push
 *   2026-10-15  8dd47e4  swept ./lib/deploy-manifest.mjs     → broke finalize;
 *                        prod served 0.8.2835 with sw.js stamped 2833, which is
 *                        the stale-cache hang returning players actually feel
 *   2026-10-16  c408f82  swept ../lib/local-driving AGAIN    → deploy failed
 *
 * The mechanism is always the same and has nothing to do with carelessness about
 * the import itself: two agents share this working tree, so `git add <file>`
 * stages MY edit to a file that also carries THEIR in-progress edit — including
 * an import of a module they have not committed yet. It builds perfectly here,
 * because the module is sitting on disk. It cannot build anywhere else.
 *
 * A reviewer cannot see this: the diff shows a plausible import line, and the
 * missing file is invisible precisely because it is untracked. So the check has
 * to be mechanical, and it has to run without being remembered — I had written
 * this check once before and skipped running it, which is how the second one
 * shipped.
 *
 * It resolves relative imports only. Bare specifiers are package deps and
 * belong to the lockfile, not here.
 *
 * READS COMMITTED CONTENT, NOT THE WORKING COPY — and that distinction is the
 * whole difference between a gate that works and one that gets ignored. Two
 * agents share this tree, so the working copy is nearly always dirty with the
 * other's in-progress edits; a checker that read from disk would flag their
 * half-finished imports on every run, be wrong every time, and be muted within
 * a day. The only question worth asking is "does the thing I am about to push
 * resolve on a machine that has only what git has?" — so content comes from the
 * index (--staged) or from HEAD (default), never from disk. Disk is consulted
 * for one thing: telling "untracked" apart from "typo" in the error message.
 *
 *   node scripts/check-imports-tracked.mjs            # HEAD — what you'd push
 *   node scripts/check-imports-tracked.mjs --staged   # the staged index
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";

import { dirname, join, posix, relative, resolve } from "node:path";

const ROOT = resolve(dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const SOURCE_RE = /\.(ts|tsx|js|mjs|cjs|svelte|astro)$/;
// Covers `from "x"`, `import "x"`, `import("x")` and `export … from "x"`.
const IMPORT_RE = /(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)["'](\.[^"']*)["']/g;
// Vite suffixes (`?worker&inline`, `?url`, `?raw`) are not part of the path.
const stripQuery = (s) => s.split("?")[0];

const git = (args) =>
  execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 })
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

const staged = process.argv.includes("--staged");
// The revision whose content we judge. ":" is the index; "HEAD" is the last
// commit — i.e. exactly what a fresh clone would get.
const REV = staged ? "" : "HEAD";
const tracked = new Set(staged ? git(["ls-files"]) : git(["ls-tree", "-r", "--name-only", "HEAD"]));

/** File content as git has it, not as the working copy has it. */
function readFromGit(path) {
  try {
    return execFileSync("git", ["show", `${REV}:${path}`], {
      cwd: ROOT,
      encoding: "utf8",
      maxBuffer: 1 << 26,
    });
  } catch {
    return null; // deleted in this rev
  }
}

// Candidate extensions, in the order a bundler would try them.
const EXTS = ["", ".ts", ".tsx", ".js", ".mjs", ".cjs", ".svelte", ".astro", ".json", ".d.ts"];
const INDEXES = ["/index.ts", "/index.js", "/index.mjs", "/index.svelte"];

/** The tracked path this specifier resolves to, or null if nothing tracked matches. */
function resolveTracked(fromFile, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), stripQuery(spec)));
  for (const ext of EXTS) if (tracked.has(base + ext)) return base + ext;
  for (const idx of INDEXES) if (tracked.has(base + idx)) return base + idx;
  return null;
}

/** Same resolution against the DISK, to tell "untracked" apart from "typo". */
function existsOnDisk(fromFile, spec) {
  const base = posix.normalize(posix.join(posix.dirname(fromFile), stripQuery(spec)));
  for (const ext of EXTS) if (existsSync(join(ROOT, base + ext))) return base + ext;
  for (const idx of INDEXES) if (existsSync(join(ROOT, base + idx))) return base + idx;
  return null;
}

const files = (
  staged ? git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]) : [...tracked]
).filter((f) => SOURCE_RE.test(f) && tracked.has(f));

const problems = [];
for (const file of files) {
  const src = readFromGit(file);
  if (src === null) continue;
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[1];
    if (resolveTracked(file, spec)) continue;
    const onDisk = existsOnDisk(file, spec);
    const line = src.slice(0, m.index).split("\n").length;
    problems.push({ file, line, spec, onDisk });
  }
}

if (problems.length === 0) {
  console.log(`[imports] OK — ${files.length} tracked source file(s), every relative import is tracked.`);
  process.exit(0);
}

console.error("");
console.error("✗ Tracked files import modules that are NOT in git:");
console.error("");
for (const p of problems) {
  console.error(`  ${p.file}:${p.line}`);
  console.error(`      imports "${p.spec}"`);
  if (p.onDisk) {
    console.error(`      → ${p.onDisk} exists on disk but is UNTRACKED.`);
    console.error(`        It builds here and nowhere else. Usually this means another`);
    console.error(`        agent's in-progress file got swept in with your edit.`);
    console.error(`        Fix: commit it deliberately, or take their change back out`);
    console.error(`        of your commit — do not "git add" it to make this pass.`);
  } else {
    console.error(`      → nothing resolves on disk either; likely a typo or a deleted file.`);
  }
  console.error("");
}
console.error(`${problems.length} unresolved import(s). Refusing to pass.`);
process.exit(1);
