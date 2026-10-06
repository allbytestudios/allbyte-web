#!/usr/bin/env node
// Post-deploy verification. Answers one question: did this deploy land, and is
// the live site coherent?
//
// DELIBERATELY SHALLOW. An earlier generation of deploy checks booted the game
// and asserted gameplay facts (battle stats, combat behaviour) on every deploy.
// Those changed constantly for legitimate reasons, so the checks went red for
// reasons that had nothing to do with the deploy — and a red check that is
// usually noise teaches everyone to ignore red checks. Deep gameplay assertions
// belong in the game's own suites, on the game's cadence.
//
// What belongs HERE is only what a DEPLOY can break:
//   1. the deploy actually reached the CDN
//   2. the three version stamps agree (the stale-cache class of bug)
//   3. the pages a player uses respond
//   4. /play/ still has the headers the engine needs to boot at all
//   5. robots.txt + sitemap are real files, not the SPA fallback
//   6. hidden pages are still hidden, visible pages still visible
//
// Every check is a plain HTTP request: no browser, no game, a few seconds.
// Exits 0 (all passed) or 1 (something failed). On GitHub Actions it writes a
// table to the job summary, so each deploy leaves a record that can be scanned
// months later without opening step logs.
//
// Usage:
//   node scripts/verify-deploy.mjs                # verify against origin/main
//   node scripts/verify-deploy.mjs --sha <sha>    # expect this commit live
//   node scripts/verify-deploy.mjs --base <url>   # verify another origin
//   node scripts/verify-deploy.mjs --skip-stamp   # don't require a sha match

import { execSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { isNoIndexPath } from "../src/lib/seo.mjs";

const args = process.argv.slice(2);
const flag = (name, fallback = null) => {
  const i = args.indexOf(`--${name}`);
  return i !== -1 && args[i + 1] ? args[i + 1] : fallback;
};
const has = (name) => args.includes(`--${name}`);

const BASE = flag("base", "https://allbyte.studio").replace(/\/$/, "");
const TIMEOUT_MS = 20000;

/** Pages a player actually uses. A smoke list, not an inventory — keep it short. */
const PLAYER_PAGES = [
  "/",
  "/play/",
  "/manual/",
  "/artwork/",
  "/walkthrough/",
  "/chronicles_of_nesis/",
  "/changelog/",
  // Hidden from search but must still RESOLVE — it is linked from the README,
  // which is where its readers come from, and it redirects to /devlog/studio/.
  "/self-hosting-with-claude/",
];

/** One of each, to prove the search-visibility rules actually shipped. */
const MUST_BE_HIDDEN = "/devlog/";
const MUST_BE_VISIBLE = "/manual/";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  [${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` - ${detail}` : ""}`);
}

/** Cache-busted fetch: CloudFront sits in front of everything here. */
async function get(path, asText = true) {
  const res = await fetch(`${BASE}${path}`, {
    headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    redirect: "follow",
  });
  return { res, body: asText ? await res.text() : null };
}

function gitShow(ref) {
  try {
    return execSync(`git show ${ref}`, { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

// 1. Did the deploy land? The site stamps its own commit into a meta tag, so the
// live page can be ASKED which build it is. A green workflow and a stale CDN
// can coexist, so "the workflow passed" is not the same evidence.
async function checkDeployLanded() {
  if (has("skip-stamp")) return record("deploy landed", true, "skipped");
  let expected = flag("sha");
  if (!expected) {
    try {
      expected = execSync("git rev-parse origin/main", { encoding: "utf-8" }).trim();
    } catch {
      return record("deploy landed", true, "skipped (no git)");
    }
  }
  const { body } = await get("/");
  const m = /name="site-build" content="([^"]+)"/.exec(body || "");
  if (!m) return record("deploy landed", false, "no site-build meta tag on /");
  const liveSha = m[1].split(/[^0-9a-f]/i)[0];
  const ok = liveSha.length > 4 && expected.startsWith(liveSha.slice(0, 7));
  record("deploy landed", ok, ok ? `live ${liveSha}` : `live ${liveSha}, expected ${expected.slice(0, 8)}`);
}

// 2. Version coherence — the most expensive thing a deploy can get wrong. sw.js
// keys its cache on the committed game version; if that disagrees with what is
// actually deployed, returning players either hang on boot (stamp older) or
// re-download the whole game for nothing (stamp newer).
async function checkVersions() {
  const bare = (v) => String(v || "").replace(/^v/, "").split("-")[0];

  let committed = null;
  const raw = gitShow("origin/main:src/data/game-version.json");
  try {
    committed = JSON.parse(raw ?? readFileSync("src/data/game-version.json", "utf-8")).version;
  } catch {
    /* unavailable - treated as unknown below */
  }

  const { body: sw } = await get("/sw.js");
  const swV = /BUILD_VERSION\s*=\s*["']([^"']+)/.exec(sw || "")?.[1] ?? null;

  let deployed = null;
  try {
    const { body } = await get("/godot/channels.json");
    const json = JSON.parse(body);
    deployed = (json.channels || json)?.alpha?.version ?? null;
  } catch {
    /* unavailable */
  }

  if (!swV || !deployed) {
    return record("version coherence", false, `could not read stamps (sw=${swV} deployed=${deployed})`);
  }

  // THE LOAD-BEARING INVARIANT is sw.js == deployed. That pair decides whether a
  // returning player's cache key matches the bytes being served, i.e. whether
  // they boot or hang.
  //
  // The committed value lagging is a DIFFERENT, benign condition: it is the
  // normal state in the window between a game promote and finalize-demo
  // reconciling it, and inject-sw-version.js now reads the deployed version
  // directly so a lagging commit can no longer be stamped into sw.js. Failing on
  // it would make this check go red during correct operation — the exact way a
  // check turns into noise and stops being read.
  const swMatchesDeployed = bare(swV) === bare(deployed);
  record(
    "version coherence (sw.js == deployed)",
    swMatchesDeployed,
    swMatchesDeployed
      ? `both on ${bare(deployed)}`
      : `MISMATCH sw.js=${bare(swV)} deployed=${bare(deployed)} — returning players will hang`,
  );

  if (committed && bare(committed) !== bare(deployed)) {
    console.log(
      `  [note] committed game-version.json is ${bare(committed)}, deployed is ${bare(deployed)} — ` +
        `expected right after a game promote; finalize-demo reconciles it (<=10min, or dispatch it)`,
    );
  }
}

// 3. Pages respond. Reachability only — content assertions rot.
async function checkPages() {
  const bad = [];
  for (const path of PLAYER_PAGES) {
    try {
      const { res } = await get(path, false);
      if (!res.ok) bad.push(`${path}=>${res.status}`);
    } catch (e) {
      bad.push(`${path}=>${e.name === "TimeoutError" ? "timeout" : e.message}`);
    }
  }
  record("player pages respond", bad.length === 0, bad.length ? bad.join(", ") : `${PLAYER_PAGES.length} pages OK`);
}

// 4. /play/ needs cross-origin isolation or the engine cannot use
// SharedArrayBuffer and the game does not boot. The headers live in a
// CloudFront policy OUTSIDE this repo, so a deploy here cannot fix them — but an
// unrelated CDN change can silently drop them, and the symptom is "the game is
// broken" with no local cause.
// Checked on BOTH the wrapper and the iframe content: cross-origin isolation
// only holds if the top-level document AND the embedded document carry it, so
// testing one proves nothing about the other. (/godot/ is served by its own
// CloudFront function, separate from the wrapper's policy — they have drifted
// apart before.)
async function checkIsolationHeaders() {
  for (const path of ["/play/", "/godot/index.html"]) {
    try {
      const { res } = await get(path, false);
      const coop = res.headers.get("cross-origin-opener-policy");
      const coep = res.headers.get("cross-origin-embedder-policy");
      const ok = coop === "same-origin" && (coep === "require-corp" || coep === "credentialless");
      record(`cross-origin isolation on ${path}`, ok, ok ? `${coop} / ${coep}` : `COOP=${coop} COEP=${coep}`);
    } catch (e) {
      record(`cross-origin isolation on ${path}`, false, e.message);
    }
  }
}

// HSTS is applied site-wide by the CloudFront response-headers policy, so the
// homepage is a fair place to assert it.
async function checkHsts() {
  try {
    const { res } = await get("/", false);
    const hsts = res.headers.get("strict-transport-security");
    record("HSTS header", Boolean(hsts), hsts || "missing");
  } catch (e) {
    record("HSTS header", false, e.message);
  }
}

// 5. robots.txt and the sitemap must be REAL files. Both answered with the
// homepage HTML and a 200 for a long time, because the CDN fallback serves
// index.html for anything missing — so a 200 proves nothing. Check the shape.
async function checkCrawlerFiles() {
  try {
    const { body } = await get("/robots.txt");
    const ok = !/<html/i.test(body) && /user-agent:/i.test(body) && /sitemap:/i.test(body);
    record("robots.txt is a real file", ok, ok ? "has User-agent + Sitemap" : "served HTML or missing directives");
  } catch (e) {
    record("robots.txt is a real file", false, e.message);
  }

  try {
    const { body: index } = await get("/sitemap-index.xml");
    if (/<html/i.test(index)) {
      record("sitemap is real", false, "served HTML, not XML");
      return [];
    }
    const first = /<loc>(.*?)<\/loc>/.exec(index)?.[1];
    if (!first) {
      record("sitemap is real", false, "sitemap-index has no child");
      return [];
    }
    const { body: child } = await get(new URL(first).pathname);
    const urls = [...child.matchAll(/<loc>(.*?)<\/loc>/g)].map((m) => m[1]);
    record("sitemap is real", urls.length > 0, `${urls.length} URLs`);
    return urls;
  } catch (e) {
    record("sitemap is real", false, e.message);
    return [];
  }
}

// 6. Search visibility actually shipped. Catches a new page landing under a
// hidden prefix but getting advertised anyway.
async function checkVisibility(sitemapUrls) {
  const leaked = (sitemapUrls || []).filter((u) => {
    try {
      return isNoIndexPath(new URL(u).pathname);
    } catch {
      return false;
    }
  });
  record("no hidden pages in sitemap", leaked.length === 0, leaked.length ? leaked.join(", ") : "clean");

  const noindexRe = /name="robots"[^>]*content="[^"]*noindex/i;
  for (const [path, wantHidden] of [
    [MUST_BE_HIDDEN, true],
    [MUST_BE_VISIBLE, false],
  ]) {
    try {
      const { body } = await get(path);
      const tagged = noindexRe.test(body);
      record(
        wantHidden ? `${path} is noindex` : `${path} is indexable`,
        tagged === wantHidden,
        tagged === wantHidden ? "as expected" : tagged ? "WRONGLY noindex" : "NOT tagged",
      );
    } catch (e) {
      record(wantHidden ? `${path} is noindex` : `${path} is indexable`, false, e.message);
    }
  }
}

async function main() {
  console.log(`\nverify-deploy -> ${BASE}\n`);
  await checkDeployLanded();
  await checkVersions();
  await checkPages();
  await checkIsolationHeaders();
  await checkHsts();
  await checkVisibility(await checkCrawlerFiles());

  const failed = results.filter((r) => !r.ok);
  const summary = `${results.length - failed.length}/${results.length} checks passed`;
  console.log(`\n${failed.length ? "DEPLOY VERIFY FAILED" : "DEPLOY VERIFY OK"} - ${summary}\n`);

  // Observability: a table in the Actions run, so a deploy's state stays
  // readable later without digging through step logs.
  if (process.env.GITHUB_STEP_SUMMARY) {
    const rows = results
      .map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.name} | ${(r.detail || "").replace(/\|/g, "\\|")} |`)
      .join("\n");
    try {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Deploy verification - ${failed.length ? "FAILED" : "OK"}\n\n` +
          `\`${BASE}\` - ${summary}\n\n| | check | detail |\n|---|---|---|\n${rows}\n`,
      );
    } catch {
      /* summary is nice-to-have; never fail a run over it */
    }
  }

  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error(`verify-deploy crashed: ${e?.stack || e}`);
  process.exit(1);
});
