#!/usr/bin/env node
/**
 * Local file watcher: pushes test data to allbyte.studio prod whenever it
 * changes on disk. Solves the "see test progress while away from desk"
 * problem without giving CON Claude any awareness of the webapp's S3 bucket
 * and without coupling to git hooks (which would tangle two git identities).
 *
 * Triggers a full sync when any of these change in the Chronicles repo:
 *   - test_index.json
 *   - test_roadmap.json
 *   - test_results/test_run_status.json
 *
 * The sync uploads:
 *   - test_index.json     → s3://bucket/test-snapshot/test_index.json
 *   - test_roadmap.json   → s3://bucket/test-snapshot/test_roadmap.json
 *   - test_results/**     → s3://bucket/test-snapshot/test_results/  (sync)
 *
 * Modes:
 *   node scripts/sync-test-data-watcher.js              # watch loop (default)
 *   node scripts/sync-test-data-watcher.js --once       # one immediate sync, exit
 *   node scripts/sync-test-data-watcher.js --dry-run    # print commands, no upload
 *   node scripts/sync-test-data-watcher.js --self-test  # run internal sanity tests
 *
 * Environment:
 *   CHRONICLES_DIR        path to Chronicles repo (default: known dev path)
 *   AWS_S3_BUCKET         target S3 bucket (default: allbyte.studio-site)
 *   AWS_REGION            (default: us-east-1)
 *   SYNC_DEBOUNCE_MS      file-change debounce window (default: 2000)
 *   SYNC_CIRCUIT_PAUSE_MS pause after consecutive failures (default: 60000)
 */

import { spawn } from "node:child_process";
import { existsSync, statSync, watch, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import { dirname, join, normalize, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// --- config ----------------------------------------------------------------

const CHRONICLES_DIR = resolve(
  process.env.CHRONICLES_DIR ||
    "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis"
);
const BUCKET = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const REGION = process.env.AWS_REGION || "us-east-1";
const DEBOUNCE_MS = Number(process.env.SYNC_DEBOUNCE_MS) || 2000;
const CIRCUIT_PAUSE_MS = Number(process.env.SYNC_CIRCUIT_PAUSE_MS) || 60000;
const FAILURE_THRESHOLD = 3;
// Heartbeat upload cadence. Dashboard flags >2x this as stale, >10x as offline.
const HEARTBEAT_MS = Number(process.env.SYNC_HEARTBEAT_MS) || 60000;
// Claude usage stats refresh cadence. The /test/ Console reads
// src/data/claude-usage*.json; without this, the JSON files only
// regenerate when someone runs `npm run usage` manually, and the
// "current week" stats drift from reality.
const USAGE_REFRESH_MS = Number(process.env.SYNC_USAGE_REFRESH_MS) || 15 * 60 * 1000;

// Watch targets — relative to CHRONICLES_DIR. Each entry is { rel, kind }.
// `kind: "json"` means the file change triggers a sync. `kind: "results"` is
// the directory sync target — we don't watch it, we just upload it as part
// of every sync.
const WATCH_FILES = [
  "test_index.json",
  "test_roadmap.json",
  "test_results/test_run_status.json",
  "tickets/tickets.json",
  "tickets/dashboard.json",
  "tickets/agents.json",
  "tickets/epics.json",
  "tickets/agent_chat.ndjson",
  "tickets/agent_activity.json",
  "test_fixtures/manifest.json",
];

// --- pure helpers (testable) ----------------------------------------------

/**
 * Build the list of shell commands a single sync run should execute.
 * Returns an array of {label, argv} tuples in the order they should run.
 * Does not check filesystem state — that's the caller's job.
 */
export function buildSyncCommands({
  chroniclesDir,
  bucket,
  region,
}) {
  // Use forward slashes even on Windows: aws.cmd accepts them and they
  // survive spawn+shell:true without backslash-escaping hazards.
  const toPosix = (p) => p.replace(/\\/g, "/");
  const idx = toPosix(join(chroniclesDir, "test_index.json"));
  const road = toPosix(join(chroniclesDir, "test_roadmap.json"));
  const results = toPosix(join(chroniclesDir, "test_results"));
  const cacheCtrl = "public, max-age=30, must-revalidate";

  const ticketsDir = toPosix(join(chroniclesDir, "tickets"));
  const fixturesDir = toPosix(join(chroniclesDir, "test_fixtures"));
  const cmds = [];
  cmds.push({
    label: "test_index.json",
    localPath: idx,
    argv: [
      "aws",
      "s3",
      "cp",
      idx,
      `s3://${bucket}/test-snapshot/test_index.json`,
      "--region",
      region,
      "--cache-control",
      cacheCtrl,
      "--content-type",
      "application/json",
    ],
  });
  cmds.push({
    label: "test_roadmap.json",
    localPath: road,
    argv: [
      "aws",
      "s3",
      "cp",
      road,
      `s3://${bucket}/test-snapshot/test_roadmap.json`,
      "--region",
      region,
      "--cache-control",
      cacheCtrl,
      "--content-type",
      "application/json",
    ],
  });
  cmds.push({
    label: "test_results/",
    localPath: results,
    argv: [
      "aws",
      "s3",
      "sync",
      results,
      `s3://${bucket}/test-snapshot/test_results`,
      "--region",
      region,
      "--cache-control",
      cacheCtrl,
      "--exclude",
      ".gdignore",
      "--exclude",
      "*.import",
    ],
  });
  cmds.push({
    label: "tickets/",
    localPath: ticketsDir,
    argv: [
      "aws",
      "s3",
      "sync",
      ticketsDir,
      `s3://${bucket}/test-snapshot/tickets`,
      "--region",
      region,
      "--cache-control",
      cacheCtrl,
      "--exclude",
      "README.md",
    ],
  });
  cmds.push({
    label: "test_fixtures/",
    localPath: fixturesDir,
    argv: [
      "aws",
      "s3",
      "sync",
      fixturesDir,
      `s3://${bucket}/test-snapshot/test_fixtures`,
      "--region",
      region,
      "--cache-control",
      cacheCtrl,
    ],
  });
  return cmds;
}

/**
 * Build the shape that gets uploaded as heartbeat.json. Pure / testable —
 * the dashboard reads this to decide if the watcher is alive.
 */
export function buildHeartbeat({
  startedAt,
  lastSyncAt,
  lastSyncOk,
  lastChangeAt,
  consecutiveFailures,
  host,
  pid,
  now = Date.now(),
}) {
  return {
    schema_version: 1,
    written_at: new Date(now).toISOString(),
    started_at: startedAt ? new Date(startedAt).toISOString() : null,
    last_sync_at: lastSyncAt ? new Date(lastSyncAt).toISOString() : null,
    last_sync_ok: lastSyncOk,
    last_change_at: lastChangeAt ? new Date(lastChangeAt).toISOString() : null,
    consecutive_failures: consecutiveFailures,
    host,
    pid,
  };
}

/**
 * Debouncer that schedules a single call after `wait` ms. Subsequent calls
 * within the wait window reset the timer. Pure / testable: caller injects
 * its own timer functions for tests.
 */
export function makeDebouncer(wait, fn, timers = global) {
  let t = null;
  return {
    fire() {
      if (t !== null) timers.clearTimeout(t);
      t = timers.setTimeout(() => {
        t = null;
        fn();
      }, wait);
    },
    pending() {
      return t !== null;
    },
    cancel() {
      if (t !== null) timers.clearTimeout(t);
      t = null;
    },
  };
}

/**
 * Simple circuit breaker: tracks consecutive failures and reports whether
 * the breaker is open. Pure / testable.
 */
export function makeCircuitBreaker(threshold, pauseMs, now = Date.now) {
  let consecutiveFailures = 0;
  let openedAt = 0;
  return {
    recordSuccess() {
      consecutiveFailures = 0;
      openedAt = 0;
    },
    recordFailure() {
      consecutiveFailures++;
      if (consecutiveFailures >= threshold) {
        openedAt = now();
      }
    },
    isOpen() {
      if (openedAt === 0) return false;
      // Auto-close after the pause window so a transient outage recovers.
      if (now() - openedAt >= pauseMs) {
        consecutiveFailures = 0;
        openedAt = 0;
        return false;
      }
      return true;
    },
    failures() {
      return consecutiveFailures;
    },
  };
}

// --- runtime / IO ---------------------------------------------------------

const isTty = process.stdout.isTTY;
const c = (code, s) => (isTty ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s) => c("2", s);
const green = (s) => c("32", s);
const red = (s) => c("31", s);
const yellow = (s) => c("33", s);
const cyan = (s) => c("36", s);

function ts() {
  const d = new Date();
  return d.toISOString().slice(11, 19);
}

function log(level, msg) {
  const tag =
    level === "ok"
      ? green("OK")
      : level === "err"
        ? red("ERR")
        : level === "warn"
          ? yellow("WARN")
          : cyan("..");
  process.stdout.write(`${dim(ts())} ${tag} ${msg}\n`);
}

/**
 * Run one shell command via spawn and resolve with {ok, code, stdout, stderr}.
 * On Windows we need shell:true so `aws.cmd` is found on PATH.
 */
function runCommand(argv) {
  return new Promise((res) => {
    const [cmd, ...args] = argv;
    // aws.exe is a real executable on Windows; no shell needed. Dropping
    // shell:true also avoids backslash-escape hazards in argument values.
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (err) => {
      res({ ok: false, code: -1, stdout, stderr: stderr + String(err) });
    });
    child.on("close", (code) => {
      res({ ok: code === 0, code, stdout, stderr });
    });
  });
}

/**
 * Startup checks. Returns a list of human-readable problems; empty list = OK.
 */
export function checkSanity({ chroniclesDir, files }) {
  const problems = [];
  if (!existsSync(chroniclesDir)) {
    problems.push(`Chronicles dir not found: ${chroniclesDir}`);
  } else {
    const present = files.filter((f) =>
      existsSync(normalize(join(chroniclesDir, f)))
    );
    if (present.length === 0) {
      problems.push(
        `None of the watch targets exist under ${chroniclesDir}: ${files.join(", ")}`
      );
    }
  }
  return problems;
}

async function checkAwsCli() {
  const r = await runCommand(["aws", "--version"]);
  return r.ok;
}

/**
 * Regenerate src/data/claude-usage*.json by invoking the existing usage
 * script. Logs success / failure but never throws — usage stats are nice
 * to have, not load-bearing, so we don't want a broken Claude transcript
 * directory to take down the whole watcher.
 */
async function regenerateUsageStats() {
  const usageScript = join(ROOT, "scripts", "claude-usage.js");
  if (!existsSync(usageScript)) {
    log("warn", `usage script missing: ${usageScript}`);
    return;
  }
  const r = await runCommand(["node", usageScript]);
  if (r.ok) {
    // Pull the headline message off the script's stdout (last 2-3 lines
    // typically have "Usage: X msg / Y budget = Z%"). Trim aggressively
    // so the watcher log stays readable.
    const summary = r.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("Usage:") || l.startsWith("Pace:"))
      .join(" · ");
    log("ok", `usage stats refreshed${summary ? " — " + summary : ""}`);
  } else {
    log(
      "warn",
      `usage stats refresh failed (exit ${r.code}): ${r.stderr.split("\n")[0] || "(no stderr)"}`
    );
  }
}

// --- heartbeat ------------------------------------------------------------

/**
 * Write heartbeat JSON to a temp file and upload to S3. Short cache so the
 * dashboard sees fresh values within ~30s of a write.
 */
async function uploadHeartbeat({ state, dryRun, bucket, region }) {
  const body = buildHeartbeat({
    startedAt: state.startedAt,
    lastSyncAt: state.lastSyncAt,
    lastSyncOk: state.lastSyncOk,
    lastChangeAt: state.lastChangeAt,
    consecutiveFailures: state.consecutiveFailures,
    host: hostname(),
    pid: process.pid,
  });
  if (dryRun) {
    log("..", `[dry-run] heartbeat ${body.written_at}`);
    return true;
  }
  const tmp = join(tmpdir(), `sync-heartbeat-${process.pid}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(body, null, 2));
  } catch (err) {
    log("warn", `heartbeat tmp write failed: ${err.message}`);
    return false;
  }
  const tmpPosix = tmp.replace(/\\/g, "/");
  const argv = [
    "aws",
    "s3",
    "cp",
    tmpPosix,
    `s3://${bucket}/test-snapshot/heartbeat.json`,
    "--region",
    region,
    "--cache-control",
    "public, max-age=20, must-revalidate",
    "--content-type",
    "application/json",
  ];
  const r = await runCommand(argv);
  if (!r.ok) {
    log("warn", `heartbeat upload failed: ${r.stderr.split("\n")[0] || "?"}`);
  }
  return r.ok;
}

// --- sync runner ----------------------------------------------------------

async function runSync({ dryRun, chroniclesDir, bucket, region, breaker }) {
  if (breaker && breaker.isOpen()) {
    log(
      "warn",
      `circuit open (${breaker.failures()} consecutive failures) — skipping sync`
    );
    return { ok: false, skipped: true };
  }

  const cmds = buildSyncCommands({ chroniclesDir, bucket, region });
  let allOk = true;
  for (const { label, argv, localPath } of cmds) {
    if (dryRun) {
      log("..", `[dry-run] ${label}: ${argv.slice(0, 4).join(" ")} …`);
      continue;
    }
    if (localPath && !existsSync(localPath)) {
      log("warn", `${label}: source ${localPath} does not exist — skipping`);
      continue;
    }
    const display = label;
    log("..", `uploading ${display}`);
    const result = await runCommand(argv);
    if (result.ok) {
      log("ok", `${display}`);
    } else {
      allOk = false;
      log(
        "err",
        `${display} failed (exit ${result.code}): ${result.stderr.split("\n")[0] || "(no stderr)"}`
      );
    }
  }
  if (!dryRun && breaker) {
    if (allOk) breaker.recordSuccess();
    else breaker.recordFailure();
  }
  return { ok: allOk, skipped: false };
}

// --- watcher --------------------------------------------------------------

function startWatchers({ chroniclesDir, files, onChange }) {
  const watchers = [];
  for (const rel of files) {
    const full = normalize(join(chroniclesDir, rel));
    if (!existsSync(full)) {
      log("warn", `watch target missing, skipping: ${rel}`);
      continue;
    }
    try {
      const w = watch(full, { persistent: true }, (eventType) => {
        // Both 'change' and 'rename' (atomic-write editors) should fire.
        onChange(rel, eventType);
      });
      watchers.push(w);
      log("..", `watching ${rel}`);
    } catch (err) {
      log("err", `failed to watch ${rel}: ${err.message}`);
    }
  }
  return watchers;
}

// --- self-test mode -------------------------------------------------------

async function runSelfTest() {
  const t = (label, fn) => {
    try {
      fn();
      console.log(`  ${green("✓")} ${label}`);
      return true;
    } catch (err) {
      console.log(`  ${red("✗")} ${label}: ${err.message}`);
      return false;
    }
  };
  let ok = true;

  console.log("buildSyncCommands");
  ok =
    t("returns 5 commands", () => {
      const cmds = buildSyncCommands({
        chroniclesDir: "/tmp/chr",
        bucket: "b",
        region: "r",
      });
      if (cmds.length !== 5)
        throw new Error(`expected 5, got ${cmds.length}`);
    }) && ok;
  ok =
    t("first cmd uploads test_index.json", () => {
      const c0 = buildSyncCommands({
        chroniclesDir: "/tmp/chr",
        bucket: "b",
        region: "r",
      })[0];
      if (c0.label !== "test_index.json") throw new Error(c0.label);
      if (!c0.argv.includes("s3://b/test-snapshot/test_index.json"))
        throw new Error("missing destination");
      if (!c0.argv.includes("--region") || !c0.argv.includes("r"))
        throw new Error("missing region");
    }) && ok;
  ok =
    t("test_results uses sync (not cp)", () => {
      const c2 = buildSyncCommands({
        chroniclesDir: "/tmp/chr",
        bucket: "b",
        region: "r",
      })[2];
      if (!c2.argv.includes("sync"))
        throw new Error("expected aws s3 sync");
    }) && ok;
  ok =
    t("excludes .gdignore and *.import", () => {
      const c2 = buildSyncCommands({
        chroniclesDir: "/tmp/chr",
        bucket: "b",
        region: "r",
      })[2];
      const args = c2.argv.join(" ");
      if (!args.includes(".gdignore"))
        throw new Error("missing .gdignore exclude");
      if (!args.includes("*.import"))
        throw new Error("missing *.import exclude");
    }) && ok;

  console.log("\nmakeDebouncer");
  ok =
    t("debounce coalesces rapid fires", () => {
      let now = 0;
      const calls = new Map();
      const fakeTimers = {
        setTimeout(fn, ms) {
          const id = Symbol();
          calls.set(id, { fn, fireAt: now + ms });
          return id;
        },
        clearTimeout(id) {
          calls.delete(id);
        },
      };
      let fired = 0;
      const d = makeDebouncer(100, () => fired++, fakeTimers);
      d.fire();
      d.fire();
      d.fire();
      if (calls.size !== 1)
        throw new Error(`expected 1 pending, got ${calls.size}`);
      if (fired !== 0)
        throw new Error(`should not have fired yet, got ${fired}`);
      // Manually fire the only pending timer
      now = 200;
      for (const { fn } of calls.values()) fn();
      if (fired !== 1)
        throw new Error(`expected 1 fire, got ${fired}`);
    }) && ok;
  ok =
    t("debounce.cancel clears pending", () => {
      const calls = new Map();
      const fakeTimers = {
        setTimeout(fn, ms) {
          const id = Symbol();
          calls.set(id, fn);
          return id;
        },
        clearTimeout(id) {
          calls.delete(id);
        },
      };
      const d = makeDebouncer(100, () => {}, fakeTimers);
      d.fire();
      d.cancel();
      if (calls.size !== 0)
        throw new Error(`expected 0 pending after cancel`);
      if (d.pending()) throw new Error("pending() should return false");
    }) && ok;

  console.log("\nmakeCircuitBreaker");
  ok =
    t("opens after N failures", () => {
      let now = 1000;
      const cb = makeCircuitBreaker(3, 60000, () => now);
      cb.recordFailure();
      cb.recordFailure();
      if (cb.isOpen()) throw new Error("opened too early");
      cb.recordFailure();
      if (!cb.isOpen()) throw new Error("should be open after 3 failures");
    }) && ok;
  ok =
    t("auto-closes after pause window", () => {
      let now = 1000;
      const cb = makeCircuitBreaker(2, 5000, () => now);
      cb.recordFailure();
      cb.recordFailure();
      if (!cb.isOpen()) throw new Error("should be open");
      now = 7000;
      if (cb.isOpen()) throw new Error("should auto-close after pause");
    }) && ok;
  ok =
    t("recordSuccess resets counter", () => {
      let now = 1000;
      const cb = makeCircuitBreaker(3, 60000, () => now);
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      cb.recordFailure();
      cb.recordFailure();
      if (cb.isOpen()) throw new Error("counter should reset on success");
    }) && ok;

  console.log("\nbuildHeartbeat");
  ok =
    t("produces schema v1 with ISO timestamps", () => {
      const hb = buildHeartbeat({
        startedAt: 1000,
        lastSyncAt: 2000,
        lastSyncOk: true,
        lastChangeAt: 1500,
        consecutiveFailures: 0,
        host: "h",
        pid: 42,
        now: 3000,
      });
      if (hb.schema_version !== 1) throw new Error("schema_version");
      if (!hb.written_at.endsWith("Z")) throw new Error("written_at not ISO");
      if (hb.last_sync_ok !== true) throw new Error("last_sync_ok");
      if (hb.pid !== 42) throw new Error("pid");
      if (hb.consecutive_failures !== 0) throw new Error("failures");
    }) && ok;
  ok =
    t("nulls out missing timestamps", () => {
      const hb = buildHeartbeat({
        startedAt: null,
        lastSyncAt: null,
        lastSyncOk: null,
        lastChangeAt: null,
        consecutiveFailures: 0,
        host: "h",
        pid: 1,
        now: 1000,
      });
      if (hb.last_sync_at !== null) throw new Error("last_sync_at should be null");
      if (hb.started_at !== null) throw new Error("started_at should be null");
    }) && ok;

  console.log("\ncheckSanity");
  ok =
    t("flags missing chronicles dir", () => {
      const probs = checkSanity({
        chroniclesDir: "/this/path/does/not/exist/" + Date.now(),
        files: ["test_index.json"],
      });
      if (probs.length === 0) throw new Error("expected at least 1 problem");
    }) && ok;
  ok =
    t("returns empty for healthy state", () => {
      const probs = checkSanity({
        chroniclesDir: ROOT,
        files: ["package.json"],
      });
      if (probs.length !== 0) throw new Error(`unexpected: ${probs.join(", ")}`);
    }) && ok;

  console.log();
  if (ok) {
    console.log(green("self-test: ALL PASS"));
    process.exit(0);
  } else {
    console.log(red("self-test: FAILURES"));
    process.exit(1);
  }
}

// --- main -----------------------------------------------------------------

function parseArgs(argv) {
  const args = {
    once: false,
    dryRun: false,
    selfTest: false,
    help: false,
  };
  for (const a of argv.slice(2)) {
    if (a === "--once") args.once = true;
    else if (a === "--dry-run") args.dryRun = true;
    else if (a === "--self-test") args.selfTest = true;
    else if (a === "--help" || a === "-h") args.help = true;
  }
  return args;
}

function printHelp() {
  console.log(`
sync-test-data-watcher.js — local file watcher for prod test-data sync

Usage:
  node scripts/sync-test-data-watcher.js              # watch + auto-sync (default)
  node scripts/sync-test-data-watcher.js --once       # one immediate sync, exit
  node scripts/sync-test-data-watcher.js --dry-run    # print commands, don't upload
  node scripts/sync-test-data-watcher.js --self-test  # run internal sanity tests

Watches in: ${CHRONICLES_DIR}
Uploads to: s3://${BUCKET}/test-snapshot/
`);
}

async function main() {
  const args = parseArgs(process.argv);

  if (args.help) {
    printHelp();
    return;
  }
  if (args.selfTest) {
    await runSelfTest();
    return;
  }

  // Sanity checks
  const problems = checkSanity({
    chroniclesDir: CHRONICLES_DIR,
    files: WATCH_FILES,
  });
  if (problems.length > 0) {
    for (const p of problems) log("err", p);
    process.exit(2);
  }
  if (!args.dryRun) {
    const cliOk = await checkAwsCli();
    if (!cliOk) {
      log("err", "aws CLI not found on PATH");
      process.exit(2);
    }
  }

  log("..", `chronicles: ${CHRONICLES_DIR}`);
  log("..", `bucket:     s3://${BUCKET}`);
  if (args.dryRun) log("warn", "DRY RUN — no actual uploads");

  if (args.once) {
    const { ok } = await runSync({
      dryRun: args.dryRun,
      chroniclesDir: CHRONICLES_DIR,
      bucket: BUCKET,
      region: REGION,
    });
    await uploadHeartbeat({
      state: {
        startedAt: Date.now(),
        lastSyncAt: Date.now(),
        lastSyncOk: ok,
        lastChangeAt: null,
        consecutiveFailures: ok ? 0 : 1,
      },
      dryRun: args.dryRun,
      bucket: BUCKET,
      region: REGION,
    });
    process.exit(ok ? 0 : 1);
  }

  // Long-running watcher mode
  const breaker = makeCircuitBreaker(FAILURE_THRESHOLD, CIRCUIT_PAUSE_MS);
  const hbState = {
    startedAt: Date.now(),
    lastSyncAt: null,
    lastSyncOk: null,
    lastChangeAt: null,
    consecutiveFailures: 0,
  };
  let pendingChange = null;
  const debouncer = makeDebouncer(DEBOUNCE_MS, async () => {
    log("..", `change detected (${pendingChange}) — syncing`);
    pendingChange = null;
    const { ok } = await runSync({
      dryRun: args.dryRun,
      chroniclesDir: CHRONICLES_DIR,
      bucket: BUCKET,
      region: REGION,
      breaker,
    });
    hbState.lastSyncAt = Date.now();
    hbState.lastSyncOk = ok;
    hbState.consecutiveFailures = breaker.failures();
    await uploadHeartbeat({
      state: hbState,
      dryRun: args.dryRun,
      bucket: BUCKET,
      region: REGION,
    });
  });

  const watchers = startWatchers({
    chroniclesDir: CHRONICLES_DIR,
    files: WATCH_FILES,
    onChange: (rel) => {
      pendingChange = rel;
      hbState.lastChangeAt = Date.now();
      debouncer.fire();
    },
  });

  if (watchers.length === 0) {
    log("err", "no watchers started — nothing to do");
    process.exit(2);
  }

  log("ok", `watching ${watchers.length} file(s) — Ctrl-C to stop`);

  // Initial sync on startup so prod is current the moment the watcher comes up
  log("..", "initial sync on startup");
  const initial = await runSync({
    dryRun: args.dryRun,
    chroniclesDir: CHRONICLES_DIR,
    bucket: BUCKET,
    region: REGION,
    breaker,
  });
  hbState.lastSyncAt = Date.now();
  hbState.lastSyncOk = initial.ok;
  hbState.consecutiveFailures = breaker.failures();
  await uploadHeartbeat({
    state: hbState,
    dryRun: args.dryRun,
    bucket: BUCKET,
    region: REGION,
  });

  // Periodic heartbeat so the dashboard can tell "alive and idle" apart from
  // "dead". Uploads regardless of whether a sync happened.
  const hbInterval = setInterval(() => {
    uploadHeartbeat({
      state: hbState,
      dryRun: args.dryRun,
      bucket: BUCKET,
      region: REGION,
    });
  }, HEARTBEAT_MS);

  // Refresh src/data/claude-usage*.json on a cadence so the Console tab's
  // weekly stats track reality without anyone running `npm run usage`.
  // Fire once immediately so a fresh watcher start picks up data right away.
  if (!args.dryRun) {
    regenerateUsageStats();
  }
  const usageInterval = setInterval(() => {
    if (args.dryRun) return;
    regenerateUsageStats();
  }, USAGE_REFRESH_MS);

  // Graceful shutdown
  const shutdown = () => {
    log("..", "shutdown — closing watchers");
    clearInterval(hbInterval);
    clearInterval(usageInterval);
    debouncer.cancel();
    for (const w of watchers) {
      try {
        w.close();
      } catch {}
    }
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

// Only invoke main when run directly, not when imported by tests.
// pathToFileURL handles Windows path quirks (file:/// vs file://) cleanly.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    log("err", err.stack || String(err));
    process.exit(1);
  });
}
