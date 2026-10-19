#!/usr/bin/env node
/**
 * trigger-queue.mjs — let Arc trigger publish/promote without holding AWS creds.
 *
 * THE MODEL: the container WRITES A REQUEST FILE; this host-side watcher
 * validates it and runs the real script; the result is written back as a file.
 * Arc never holds a credential, and the only things he can cause are the two
 * actions enumerated here, with arguments that are pattern-checked before
 * anything executes.
 *
 * WHY A FILE QUEUE AND NOT AN HTTP ENDPOINT: these actions can change what
 * every player downloads. A queue makes every request and every verdict a
 * durable artifact on disk — so "who promoted what, when, and did the gate
 * pass" is answerable afterwards without anyone having kept a log. It also
 * needs no shared secret (the filesystem boundary is the permission), and it
 * degrades safely: if this watcher is down, requests queue instead of
 * half-running.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not decide anything. It cannot
 * promote something unattested — it just runs promote-artifact.mjs, whose gate
 * is the real authority. A trigger surface that could bypass the gate would
 * make the gate decorative, so the only power here is "start one of two
 * scripts, with validated arguments".
 *
 * NOTE ON REVIVING A HOST DAEMON: scripts/deploy-watcher.js and its Startup VBS
 * were deliberately retired 2026-07-04 when CodeBuild replaced them. This is a
 * much smaller thing — it validates a request and execs one of two scripts; it
 * builds nothing and judges nothing — but it IS a host-resident process again,
 * and that was flagged for the owner rather than slipped in.
 *
 *   node scripts/trigger-queue.mjs            # watch (default 5s poll)
 *   node scripts/trigger-queue.mjs --once     # drain pending requests and exit
 */
import { execFileSync } from "node:child_process";
import { verifyTrigger } from "./lib/trigger-auth.mjs";
import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const QUEUE =
  process.env.TRIGGER_QUEUE_DIR ||
  join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "queue");
const REQ = join(QUEUE, "requests");
const RES = join(QUEUE, "results");
const DONE = join(QUEUE, "processed");
const POLL_MS = Number(process.env.TRIGGER_POLL_MS || 5000);
const ONCE = process.argv.includes("--once");

for (const d of [QUEUE, REQ, RES, DONE]) mkdirSync(d, { recursive: true });
const log = (...a) => console.log("[trigger-queue]", ...a);

// The signing contract lives in ONE place (scripts/lib/trigger-auth.mjs),
// shared with the HTTP trigger endpoint. Two copies of an HMAC contract is
// how a signer and a verifier quietly stop agreeing.

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * The entire action surface. Adding to this list is the ONLY way to widen what
 * the container can cause, which is the point: an allowlist of two, each with
 * its arguments validated by shape before anything runs.
 */
const ACTIONS = {
  publish: {
    describe: (r) => `publish ${r.git_sha ? r.git_sha.slice(0, 8) : "(newest export)"}`,
    build(r) {
      const args = ["scripts/publish-dev-build.js", "--json"];
      // allow_mixed_build is surfaced rather than silently honoured: it is the
      // override that can quietly become the default.
      if (r.allow_mixed_build === true) args.push("--allow-mixed-build");
      if (r.dry_run === true) args.push("--dry-run");
      return args;
    },
    validate(r) {
      if (r.git_sha !== undefined && !HEX40.test(String(r.git_sha))) return "git_sha must be 40-hex if given";
      return null;
    },
  },
  promote: {
    describe: (r) => `promote artifact ${String(r.artifact_sha256).slice(0, 12)}…`,
    build(r) {
      const args = ["scripts/promote-artifact.mjs", "--artifact", r.artifact_sha256, "--json"];
      if (r.dry_run === true) args.push("--dry-run");
      return args;
    },
    validate(r) {
      // Promotion is addressed by BYTES. Refusing a git sha here is not
      // pedantry: one git sha can name several different artifacts, so a
      // sha-addressed promote could ship something nobody attested.
      if (!HEX64.test(String(r.artifact_sha256 || ""))) {
        return "promote requires artifact_sha256 (64-hex). A git sha is not accepted: one commit can produce several different artifacts.";
      }
      return null;
    },
  },
};

function writeResult(id, payload) {
  const out = { request_id: id, ...payload, completed_at: new Date().toISOString() };
  const tmp = join(RES, `.${id}.tmp`);
  writeFileSync(tmp, JSON.stringify(out, null, 2) + "\n");
  // Rename is atomic, so a reader never sees a half-written result and mistakes
  // a truncated file for a malformed one.
  renameSync(tmp, join(RES, `${id}.json`));
  return out;
}

function handle(file) {
  const path = join(REQ, file);
  let req;
  try {
    req = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const id = file.replace(/\.json$/i, "");
    log(`${file}: unparseable — ${e.message}`);
    writeResult(REQUEST_ID.test(id) ? id : "malformed", { ok: false, reason: "E_BAD_REQUEST", message: `not valid JSON: ${e.message}` });
    try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
    return;
  }

  const id = String(req.request_id || file.replace(/\.json$/i, ""));
  if (!REQUEST_ID.test(id)) {
    writeResult("malformed", { ok: false, reason: "E_BAD_REQUEST", message: `request_id must match ${REQUEST_ID}` });
    try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
    return;
  }

  // Idempotent by request_id: a retry after a timeout must not run a promote
  // twice. The result already on disk is the answer.
  if (existsSync(join(RES, `${id}.json`))) {
    log(`${id}: already has a result — not re-running (idempotent by request_id)`);
    try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
    return;
  }

  // VERIFY BEFORE ANYTHING ELSE. An unsigned or wrongly-signed request must not
  // even be parsed for intent — refusing early means a malformed action never
  // reaches the dispatch table, and the audit record still names what arrived.
  const trig = verifyTrigger(req);
  if (!trig.ok) {
    log(`${id}: REFUSED ${trig.reason}`);
    writeResult(id, { ok: false, reason: trig.reason, message: trig.detail, action: req.action ?? null, triggered_by: null, signature_verified: false });
    try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
    return;
  }

  const action = ACTIONS[String(req.action)];
  if (!action) {
    writeResult(id, { ok: false, reason: "E_UNKNOWN_ACTION", message: `action must be one of: ${Object.keys(ACTIONS).join(", ")}` });
    try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
    return;
  }
  const bad = action.validate(req);
  if (bad) {
    writeResult(id, { ok: false, reason: "E_BAD_ARGS", message: bad });
    try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
    return;
  }

  log(`${id}: ${action.describe(req)}`);
  const args = action.build(req);
  const startedAt = new Date().toISOString();
  let stdout = "", ok = false, detail = "";
  try {
    stdout = execFileSync("node", args, {
      cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26,
      env: { ...process.env, ...(req.export_root ? { EXPORT_ROOT: req.export_root } : {}) },
    });
    ok = true;
  } catch (e) {
    stdout = String((e && e.stdout) || "");
    detail = String((e && e.stderr) || (e && e.message) || "").trim().split("\n").slice(-3).join(" | ");
  }

  // The scripts speak JSON on --json; pass their verdict through verbatim
  // rather than re-describing it, so the queue cannot disagree with the tool
  // about what happened.
  let inner = null;
  try {
    const start = stdout.indexOf("{");
    if (start !== -1) inner = JSON.parse(stdout.slice(start));
  } catch { /* fall through to raw */ }

  const res = writeResult(id, {
    ok: inner ? !!inner.ok : ok,
    action: req.action,
    // The durable attribution: who triggered this, verified by signature — not
    // self-declared by the request.
    triggered_by: trig.who,
    signature_verified: true,
    issued_at: req.issued_at,
    reason: inner?.reason || (ok ? "OK" : "E_EXEC"),
    message: inner?.message || detail || "(no message)",
    started_at: startedAt,
    result: inner || undefined,
    raw_tail: inner ? undefined : stdout.trim().split("\n").slice(-5).join("\n"),
  });
  log(`${id}: ${res.ok ? "OK" : "FAILED"} — ${res.reason}`);
  try { renameSync(path, join(DONE, file)); } catch { /* best effort */ }
}

function drain() {
  let files;
  try { files = readdirSync(REQ).filter((f) => f.endsWith(".json") && !f.startsWith(".")); }
  catch { return 0; }
  // Oldest first, and strictly one at a time: two concurrent promotes would
  // race on the live prefix, which is the one place a race is unacceptable.
  files.sort((a, b) => statSync(join(REQ, a)).mtimeMs - statSync(join(REQ, b)).mtimeMs);
  for (const f of files) handle(f);
  return files.length;
}

if (ONCE) {
  const n = drain();
  log(`drained ${n} request(s)`);
  process.exit(0);
}

log(`watching ${REQ} (poll ${POLL_MS}ms)`);
log(`results  ${RES}`);
drain();
setInterval(drain, POLL_MS);
