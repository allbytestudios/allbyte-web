#!/usr/bin/env node
/**
 * deploy-watcher.js — the last link that keeps game deploys fully agent-free.
 *
 * Arc's CI pipeline (in the game container) stages every gated build and drops a
 * `DEPLOY_READY` file next to `build_manifest.json`. But that container has no
 * aws CLI / creds. This watcher runs in the environment that DOES (the host),
 * polls for DEPLOY_READY, runs push-channel.js, and acks by deleting it. Nobody
 * "manages" a deploy — you build on develop, this ships it.
 *
 * Auto-deploys DEV channels (develop, beta-debug) only. LIVE/player-facing
 * channels (alpha, alpha-debug, beta) are NEVER auto-promoted — they're left
 * with a DEPLOY_NEEDS_PROMOTE marker for a deliberate manual
 * `push-channel.js --promote`. So the watcher can only ever ship dev paths.
 *
 * Run:   npm run deploy-watcher           (keep running; or install as a
 *                                          login/startup task for hands-off)
 *        node scripts/deploy-watcher.js --once   (single scan, e.g. from cron)
 * Env:   EXPORT_ROOT (default: Chronicles WebBootstrap/export), POLL_MS (5000).
 */
import { spawnSync } from "child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync, appendFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const EXPORT_ROOT =
  process.env.EXPORT_ROOT ||
  "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis/WebBootstrap/export";
const POLL_MS = Number(process.env.POLL_MS || 5000);
const DEV_CHANNELS = new Set(["develop", "beta-debug"]);
const pusher = join(root, "scripts", "push-channel.js");
const once = process.argv.includes("--once");

// --log <path> (or DEPLOY_WATCHER_LOG) also appends to a file — a background
// daemon is invisible otherwise. The scheduled task passes --log.
const _logArg = process.argv.indexOf("--log");
const LOG_FILE = (_logArg !== -1 && process.argv[_logArg + 1]) || process.env.DEPLOY_WATCHER_LOG || "";
function log(...a) {
  const line = `[deploy-watcher ${new Date().toISOString()}] ${a.join(" ")}`;
  console.log(line);
  if (LOG_FILE) { try { appendFileSync(LOG_FILE, line + "\n"); } catch { /* best-effort */ } }
}

function processReady(dir) {
  const readyPath = join(dir, "DEPLOY_READY");
  const manifestPath = join(dir, "build_manifest.json");
  const failedPath = join(dir, "DEPLOY_FAILED");
  if (!existsSync(manifestPath)) { log(`⚠ ${dir}: DEPLOY_READY but no build_manifest.json — skipping`); return; }
  // Don't retry a build we already failed (DEPLOY_FAILED at/after the READY).
  if (existsSync(failedPath) && statSync(failedPath).mtimeMs >= statSync(readyPath).mtimeMs) return;

  let channel = "(unknown)";
  try { channel = JSON.parse(readFileSync(manifestPath, "utf8")).channel; } catch { /* handled below */ }

  if (!DEV_CHANNELS.has(channel)) {
    writeFileSync(
      join(dir, "DEPLOY_NEEDS_PROMOTE"),
      `${channel} is a LIVE channel — deploy deliberately:\n  node scripts/push-channel.js --manifest "${manifestPath}" --promote\n`
    );
    log(`↳ ${channel}: LIVE channel — left for a manual --promote (watcher never auto-promotes live).`);
    return;
  }

  log(`↳ ${channel}: deploying…`);
  const r = spawnSync("node", [pusher, "--manifest", manifestPath], { cwd: root, stdio: "inherit" });
  if (r.status === 0) {
    try { unlinkSync(readyPath); } catch { /* best-effort ack */ }
    try { if (existsSync(failedPath)) unlinkSync(failedPath); } catch { /* best-effort */ }
    log(`✅ ${channel}: deployed; DEPLOY_READY acked.`);
  } else {
    writeFileSync(failedPath, `push-channel exit ${r.status} at ${new Date().toISOString()}\n`);
    log(`❌ ${channel}: push failed (exit ${r.status}) — wrote DEPLOY_FAILED, left DEPLOY_READY for inspection.`);
  }
}

let busy = false;
function scan() {
  if (busy) return; // a long push can outlast the poll interval — don't overlap
  busy = true;
  try {
    if (!existsSync(EXPORT_ROOT)) { log(`⚠ EXPORT_ROOT not found: ${EXPORT_ROOT}`); return; }
    for (const name of readdirSync(EXPORT_ROOT)) {
      const dir = join(EXPORT_ROOT, name);
      try {
        if (statSync(dir).isDirectory() && existsSync(join(dir, "DEPLOY_READY"))) processReady(dir);
      } catch (e) { log(`error on ${dir}: ${e.message}`); }
    }
  } finally { busy = false; }
}

// Single-instance lock — this daemon mutates the shared export dir; two copies
// racing on one build would corrupt it. Refuse to start if a live instance holds
// the lock; take over a stale one (dead PID).
const LOCK = join(root, ".tmp", "deploy-watcher.lock");
try {
  if (!existsSync(join(root, ".tmp"))) mkdirSync(join(root, ".tmp"), { recursive: true });
  if (existsSync(LOCK)) {
    const pid = Number(readFileSync(LOCK, "utf8").trim());
    let alive = false;
    try { process.kill(pid, 0); alive = true; } catch { /* dead → stale lock */ }
    if (alive && pid !== process.pid) { log(`another instance (pid ${pid}) is running — exiting.`); process.exit(0); }
  }
  writeFileSync(LOCK, String(process.pid));
  const release = () => { try { if (existsSync(LOCK) && Number(readFileSync(LOCK, "utf8").trim()) === process.pid) unlinkSync(LOCK); } catch { /* best-effort */ } };
  process.on("exit", release);
  process.on("SIGINT", () => process.exit(0));
  process.on("SIGTERM", () => process.exit(0));
} catch (e) { log(`lock error (continuing): ${e.message}`); }

log(`watching ${EXPORT_ROOT} every ${POLL_MS}ms (auto dev channels: ${[...DEV_CHANNELS].join(", ")})`);
scan();
if (!once) setInterval(scan, POLL_MS);
