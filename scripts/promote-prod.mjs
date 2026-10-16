#!/usr/bin/env node
/**
 * promote-prod.mjs — the whole prod game promote, as ONE gated script.
 *
 *   node scripts/promote-prod.mjs [--dry-run] [--force] [--skip-preflight] [--json]
 *   npm run promote:prod
 *
 * WHY THIS EXISTS
 * The promote was a sequence of hand-run commands: check for live players,
 * start CodeBuild, poll it, check channels.json, dispatch finalize, wait for the
 * sw.js stamp, run verify, run smoke. Every one of those is a step you can
 * forget, and two of them have already gone wrong in exactly that way —
 * a promote cut on top of a live playtester (2026-10-15, forced a 170MB
 * re-download four minutes into a two-hour session), and sw.js left stamped
 * behind the deployed build, which hangs returning players.
 *
 * So: one command, gates in order, stops at the first failure with a stable
 * reason code. No model in the loop, nothing to remember.
 *
 * THE PRE-FLIGHT EXCLUSIONS ARE THE POINT
 * A naive "is anyone playing" check flags our own traffic and blocks the
 * promote: the dev machine, the Deploy QA matrix on Azure runners, Google
 * prefetch. It must use the SAME exclusions as the traffic aggregator or it
 * cries wolf — measured 2026-10-16, an ad-hoc check flagged two "players" and
 * both were ours.
 */
import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { DATACENTER_RE, BOT_UA_RE } from "./lib/datacenter-ranges.mjs";
import { tmpdir, homedir } from "node:os";
import { createGunzip } from "node:zlib";

const argv = process.argv.slice(2);
const has = (f) => argv.includes(`--${f}`);
const DRY = has("dry-run");
const FORCE = has("force");
const SKIP_PREFLIGHT = has("skip-preflight");
const JSON_ONLY = has("json");

const PROJECT = process.env.CODEBUILD_PROJECT || "allbyte-godot-alpha";
const SITE = process.env.SITE_ORIGIN || "https://allbyte.studio";
const LOG_BUCKET = process.env.CF_LOG_BUCKET || "allbyte.studio-access-logs";
const LOG_PREFIX = process.env.CF_LOG_PREFIX || "cf-logs/";
const RECEIPT_DIR = process.env.PROMOTE_RECEIPTS || join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "promotes");
const QUIET_MINUTES = Number(process.env.PROMOTE_QUIET_MINUTES || 30);

const started = new Date().toISOString();
const steps = [];
const say = (m) => { if (!JSON_ONLY) console.log(`[promote] ${m}`); };

function finish(reason, message, extra = {}) {
  const ok = reason === "OK" || reason === "OK_ALREADY" || reason === "OK_DRY_RUN";
  const receipt = { ok, reason, message, steps, startedAt: started, finishedAt: new Date().toISOString(), ...extra };
  try {
    mkdirSync(RECEIPT_DIR, { recursive: true });
    writeFileSync(join(RECEIPT_DIR, "latest.json"), JSON.stringify(receipt, null, 2) + "\n");
  } catch { /* a receipt must never be the thing that fails a promote */ }
  if (JSON_ONLY) console.log(JSON.stringify(receipt, null, 2));
  else {
    console.log("");
    for (const s of steps) console.log(`  ${s.ok ? "PASS" : "FAIL"}  ${s.name} — ${s.detail}`);
    console.log("");
    console.log(`[promote] ${ok ? "OK" : "FAILED"} — ${reason}: ${message}`);
  }
  process.exit(ok ? 0 : 1);
}
const step = (name, ok, detail) => { steps.push({ name, ok, detail }); say(`${ok ? "ok" : "FAIL"} · ${name} — ${detail}`); };

const sh = (cmd) => execSync(cmd, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const aws = (args) => execFileSync("aws", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

async function getJson(url) {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}
async function getText(url) {
  const res = await fetch(`${url}${url.includes("?") ? "&" : "?"}cb=${Date.now()}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}
const liveAlpha = async () => {
  const j = await getJson(`${SITE}/godot/channels.json`);
  return (j.channels || j).alpha || {};
};
const liveSwVersion = async () => (/BUILD_VERSION\s*=\s*["']v?([^"']+)/.exec(await getText(`${SITE}/sw.js`)) || [])[1] || null;
const bare = (v) => String(v || "").replace(/^v/, "").split("-")[0];

// ---------------------------------------------------------------- pre-flight
// Exclusions come from the SHARED list, not a copy. See
// scripts/lib/datacenter-ranges.mjs for why: the copies drifted and this gate
// blocked a release on IPs the traffic aggregator already called datacenter.

// Our own machines are not players to protect. I assumed the site-traffic
// Lambda's OWNER_IDENTIFIERS was the canonical list; it is NOT an IP list —
// checked 2026-10-16, it holds two non-IP identifiers — so it cannot answer
// this. Until a canonical owner-IP source exists, two things identify us:
//   1. PROMOTE_OWNER_IPS — explicit prefixes, e.g. "107.11.163.,203.0.113.4"
//   2. anything that touched /test/ or /admin/ inside the log window
// (2) is inference and misses a machine that simply has not opened the console
// recently, which is exactly how the dev box blocked a promote. (1) is the fix,
// and it lives in the environment rather than in the repo.
function ownerIdentifiers() {
  return String(process.env.PROMOTE_OWNER_IPS || "")
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

async function activePlayers() {
  const dir = join(tmpdir(), `promote-cf-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const hour = (d) => `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}-${String(d.getUTCHours()).padStart(2, "0")}`;
  const now = new Date();
  const prev = new Date(now.getTime() - 3600_000);
  try {
    aws(["s3", "cp", `s3://${LOG_BUCKET}/${LOG_PREFIX}`, dir, "--recursive",
      "--exclude", "*", "--include", `*${hour(prev)}*`, "--include", `*${hour(now)}*`, "--quiet"]);
  } catch (e) {
    return { error: `could not read CDN logs: ${String(e.message || e).split("\n")[0]}` };
  }
  const { gunzipSync } = await import("node:zlib");
  const cutoff = Date.now() - QUIET_MINUTES * 60_000;
  const consoleIps = new Set();
  const play = new Map();
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".gz")) continue;
    let text;
    try { text = gunzipSync(readFileSync(join(dir, f))).toString("utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (!line || line[0] === "#") continue;
      const p = line.split("\t");
      if (p.length < 11) continue;
      const [date, time] = [p[0], p[1]];
      const ip = p[4], uri = p[7], ua = p[10], query = p[11] || "";
      if (uri.startsWith("/test/") || uri.startsWith("/admin/")) consoleIps.add(ip);
      const t = Date.parse(`${date}T${time}Z`);
      if (!Number.isFinite(t) || t < cutoff) continue;
      if (DATACENTER_RE.test(ip) || BOT_UA_RE.test(ua) || query.includes("qa=1")) continue;
      if (uri.includes("/godot/") || uri.replace(/\/$/, "") === "/play") {
        const cur = play.get(ip) || { n: 0, last: 0 };
        play.set(ip, { n: cur.n + 1, last: Math.max(cur.last, t) });
      }
    }
  }
  // Owner/admin machines are not players to protect — a promote interrupting
  // the owner's own session is a non-event.
  for (const ip of consoleIps) play.delete(ip);
  const owners = ownerIdentifiers();
  for (const ip of [...play.keys()]) {
    if (owners.some((o) => ip === o || ip.startsWith(o))) play.delete(ip);
  }
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* temp */ }
  return {
    ownerListSize: owners.length,
    players: [...play.entries()].map(([ip, v]) => ({ ip, requests: v.n, minutesAgo: +((Date.now() - v.last) / 60000).toFixed(1) })),
  };
}

// --------------------------------------------------------------------- main
const before = await liveAlpha().catch(() => ({}));
say(`live alpha: ${before.version || "unknown"}`);

if (!SKIP_PREFLIGHT) {
  const res = await activePlayers();
  if (res.error) {
    // Fail closed: if we cannot tell whether anyone is mid-session, we do not
    // get to assume nobody is.
    if (!FORCE) finish("E_PREFLIGHT", `${res.error} — cannot confirm nobody is playing. Re-run with --force to override.`);
    step("pre-flight players", true, `${res.error} (overridden by --force)`);
  } else if (res.players.length && !FORCE) {
    const who = res.players.map((p) => `${p.ip} (${p.requests} reqs, ${p.minutesAgo}m ago)`).join("; ");
    finish("E_PLAYERS_ACTIVE", `someone is mid-session — ${who}. A promote swaps bytes under them. Wait, or --force.`, { players: res.players });
  } else {
    step("pre-flight players", true, (res.players.length ? `${res.players.length} active, overridden by --force` : `no non-owner play activity in ${QUIET_MINUTES} min`) + ` (owner list: ${res.ownerListSize ?? 0} entries)`);
  }
} else {
  step("pre-flight players", true, "skipped (--skip-preflight)");
}

if (DRY) finish("OK_DRY_RUN", `dry-run: would promote ${PROJECT} over live ${before.version || "unknown"}`);

// 1. build ------------------------------------------------------------------
let buildId = (() => { const i = argv.indexOf("--build-id"); return i === -1 ? null : argv[i + 1]; })();
if (buildId) {
  // Attach to a build already running. Gating the steps is only cheap if a
  // later gate failing does not cost another three-minute rebuild.
  say(`attaching to existing build: ${buildId}`);
} else {
  try { buildId = aws(["codebuild", "start-build", "--project-name", PROJECT, "--query", "build.id", "--output", "text"]); }
  catch (e) { finish("E_BUILD_START", `could not start ${PROJECT}: ${String(e.message || e).split("\n")[0]}`); }
  say(`build started: ${buildId}`);
}

let status = "", resolvedSha = "";
for (let i = 0; i < 80; i++) {
  sleep(15000);
  // JSON, not text. `--output text` emits fields ALPHABETICALLY BY KEY, so a
  // positional read of {s,v,p} lands currentPhase where buildStatus was meant
  // to go — which aborted a real promote the instant it reported PROVISIONING
  // (2026-10-16). Parsing by name cannot drift that way.
  let info;
  try {
    info = JSON.parse(aws(["codebuild", "batch-get-builds", "--ids", buildId,
      "--query", "builds[0].{status:buildStatus,phase:currentPhase,src:resolvedSourceVersion}",
      "--output", "json"]));
  } catch { continue; }
  status = info.status || "";
  if (info.src) resolvedSha = info.src;
  if (status !== "IN_PROGRESS") break;
  if (i % 4 === 0) say(`  building… ${info.phase || ""}`);
}
if (status !== "SUCCEEDED") finish("E_BUILD", `CodeBuild ${status || "did not finish"} (${buildId})`, { buildId, status });
step("build", true, `SUCCEEDED, source ${resolvedSha.slice(0, 8) || "?"} (${buildId.split(":").pop().slice(0, 8)})`);

// 2. the deployed channel must actually carry that build ---------------------
let after = {};
for (let i = 0; i < 12; i++) {
  after = await liveAlpha().catch(() => ({}));
  if (after.version && after.version !== before.version) break;
  sleep(10000);
}
if (!after.version) finish("E_VERIFY_CHANNEL", "could not read channels.json after the build", { buildId });
if (resolvedSha && after.gitSha && !after.gitSha.startsWith(resolvedSha.slice(0, 8)))
  finish("E_VERIFY_CHANNEL", `channels.json says ${after.gitSha?.slice(0, 8)} but the build was ${resolvedSha.slice(0, 8)}`, { buildId, deployed: after });
step("deployed", true, `alpha ${after.version}`);

// 3. finalize — stamp sw.js now rather than waiting on the 10-minute cron ----
// If sw.js lags the deployed build, returning players key their cache to a
// version the server no longer serves and hang on boot.
try { sh(`gh workflow run finalize-demo.yml --ref main`); }
catch (e) { finish("E_FINALIZE_DISPATCH", `could not dispatch finalize: ${String(e.message || e).split("\n")[0]}`, { deployed: after }); }
let sw = null;
for (let i = 0; i < 40; i++) {
  sleep(15000);
  sw = await liveSwVersion().catch(() => null);
  if (sw && bare(sw) === bare(after.version)) break;
}
if (!sw || bare(sw) !== bare(after.version))
  finish("E_SW_STAMP", `sw.js is ${sw || "unreadable"} but the deployed build is ${bare(after.version)} — returning players would hang`, { deployed: after });
step("sw.js stamp", true, `v${bare(sw)} == deployed`);

// 4. What's New -------------------------------------------------------------
// The public changelog is generated from Arc's deploy manifest, which stopped
// appending on 2026-09-09, so the feed now depends on a fallback that rebuilds
// each release from the game repo. CI has no game checkout, so finalize CANNOT
// do this — which is why a promote otherwise ends with the page naming the
// previous build. This script runs on the host, where the game repo exists, so
// it is the one place in the pipeline that can close that loop.
const CHANGELOG = "src/data/changelog.json";
const expectedLatest = `v${bare(after.version)}`;
try {
  const clBefore = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : "";
  sh(`npm run changelog`);
  const clAfter = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : "";
  if (clAfter === clBefore) {
    step("What's New", true, "already current");
  } else {
    // ONLY this file. The working tree routinely carries other people's
    // in-flight work, and staging broadly is how an untracked import of
    // someone else's shipped and broke finalize (2026-10-16).
    sh(`git add ${CHANGELOG}`);
    sh(`git commit -m "changelog: refresh for the promoted build"`);
    sh(`git push origin main`);
    step("What's New", true, `regenerated for ${expectedLatest} and pushed`);
    // verify:deploy reads the LIVE page, so wait for that deploy to land.
    for (let i = 0; i < 30; i++) {
      sleep(15000);
      try {
        const page = await getText(`${SITE}/changelog/`);
        const latest = (/class="release-version"[^>]*>\s*([^<]+)/.exec(page) || [])[1]?.trim();
        if (latest === expectedLatest) break;
      } catch { /* keep waiting for the deploy */ }
    }
  }
} catch (e) {
  finish("E_CHANGELOG", `could not refresh What's New: ${String(e.stdout || e.message || "").split("\n").slice(-2).join(" | ")}`, { deployed: after });
}

// 5. verify + smoke ---------------------------------------------------------
try { sh(`npm run verify:deploy -- --skip-stamp`); step("verify:deploy", true, "all checks passed"); }
catch (e) {
  const out = String(e.stdout || "") + String(e.stderr || "");
  const failed = out.split("\n").filter((l) => l.includes("[FAIL]")).map((l) => l.replace(/.*\[FAIL\]\s*/, "").trim());
  finish("E_VERIFY", `verify:deploy failed: ${failed.join(" · ") || "see output"}`, { deployed: after, failed });
}
try { sh(`npm run smoke:prod`); step("smoke:prod", true, "engine booted, public build booted"); }
catch (e) {
  finish("E_SMOKE", `the game did not boot after promote: ${String(e.stdout || e.message || "").split("\n").slice(-3).join(" | ")}`, { deployed: after });
}

finish("OK", `promoted ${before.version || "?"} → ${after.version}`, { from: before.version, to: after.version, gitSha: after.gitSha, buildId });
