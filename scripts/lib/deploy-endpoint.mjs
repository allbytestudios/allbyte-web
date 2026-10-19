/**
 * deploy-endpoint.mjs — the authenticated deploy trigger, as HTTP.
 *
 * WHY THIS SHAPE (owner, 2026-10-19): "why does App need a listener for Arc to
 * just press a button on the website?" The honest answer is that any push
 * trigger needs something listening — what this avoids is a NEW dedicated
 * daemon. It mounts into the Astro dev server, which is already running during
 * normal work and already hosts POST /api/decisions and POST /api/answers the
 * same way.
 *
 * SSG strips middleware, so none of this can ever reach production. That is a
 * safety property, not an accident: a deploy trigger must not be reachable from
 * the public internet, and here it cannot be.
 *
 * WHAT IT CANNOT DO: it cannot decide anything. It verifies a signature and
 * execs the real script; `promote-artifact.mjs`'s attestation gate remains the
 * only authority over what ships. A trigger surface able to bypass the gate
 * would make the gate decorative, so the power here stops at "start one of two
 * known scripts with validated arguments".
 *
 * The dev server binds 0.0.0.0, so this endpoint is reachable from the LAN.
 * The HMAC is therefore doing real work rather than ceremony — which is why an
 * unsigned request is refused rather than treated as local-and-therefore-fine.
 */
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { verifyTrigger, TRIGGER_IDENTITY_FILE } from "./trigger-auth.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const HEX40 = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const REQUEST_ID = /^[A-Za-z0-9._-]{1,64}$/;
const MAX_BODY = 16 * 1024;

/**
 * Jobs for the async path. In memory on purpose: publish takes minutes, the dev
 * server is the thing running it, and if it restarts mid-publish the job is
 * genuinely gone — persisting a record that claims otherwise would be worse
 * than losing it. The sealed receipt on the shared mount is the durable record
 * of what actually published; this is only progress reporting.
 */
const jobs = new Map();

/**
 * AUDIT LOG — every trigger that reaches this endpoint, decided or refused.
 *
 * The owner's point when this layer went in: "ensure logs exist to troubleshoot
 * at each handoff as we're adding complexity and layers." This is the handoff
 * that had none — the file queue wrote a result file per request, but the HTTP
 * path kept everything in memory, so a refused trigger left no trace at all and
 * "Arc says he triggered it, nothing happened" would have been unanswerable.
 *
 * Append-only JSONL on the shared mount, so Arc can read back what the host
 * decided about his own request without asking. REFUSALS ARE LOGGED TOO, and
 * that is the point: a successful deploy is self-evident from the receipt, a
 * rejected one is the thing nobody can otherwise see. Never records the
 * signature or any secret — identity and verdict only.
 */
const AUDIT_DIR =
  process.env.DEPLOY_AUDIT_DIR ||
  join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "deploy-audit");

function audit(entry) {
  try {
    mkdirSync(AUDIT_DIR, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    appendFileSync(join(AUDIT_DIR, `${day}.jsonl`),
      JSON.stringify({ at: new Date().toISOString(), ...entry }) + "\n");
  } catch {
    // Never let logging break a deploy. A lost audit line is bad; a promote
    // that fails because the disk is full is worse.
  }
}

/** request_id -> result, so a retry after a timeout cannot run a promote twice. */
const seen = new Map();

function send(res, code, obj) {
  const body = JSON.stringify(obj, null, 2);
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  // No CORS headers, deliberately: this is not for browsers. A signed
  // server-to-server POST needs none, and adding them would invite a page to
  // try, which is not a door worth opening.
  res.end(body);
}

function readBody(req, limit = MAX_BODY) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const chunks = [];
    req.on("data", (c) => {
      n += c.length;
      if (n > limit) { reject(new Error("body too large")); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

/**
 * The signed fields may arrive in HEADERS (so the signed envelope is separable
 * from the payload) or in the body. Headers win; the body form stays supported
 * because the file queue already speaks it and one contract is better than two.
 */
function withEnvelope(req, body) {
  const h = (k) => {
    const v = req.headers[k];
    return Array.isArray(v) ? v[0] : v;
  };
  return {
    ...body,
    signature: h("x-deploy-signature") || body.signature,
    signed_by: h("x-deploy-identity") || body.signed_by,
    issued_at: h("x-deploy-issued-at") || body.issued_at,
  };
}

function runScript(args, { onDone }) {
  execFile("node", args, { cwd: ROOT, maxBuffer: 1 << 26 }, (err, stdout) => {
    let inner = null;
    try {
      const i = String(stdout).indexOf("{");
      if (i !== -1) inner = JSON.parse(String(stdout).slice(i));
    } catch { /* fall through to raw */ }
    onDone({
      ok: inner ? !!inner.ok : !err,
      reason: inner?.reason || (err ? "E_EXEC" : "OK"),
      message: inner?.message || (err ? String(err.message).split("\n")[0] : ""),
      result: inner || undefined,
      raw_tail: inner ? undefined : String(stdout).trim().split("\n").slice(-5).join("\n"),
    });
  });
}

export function deployTrigger() {
  return {
    name: "allbyte-deploy-trigger",
    configureServer(server) {
      const handle = async (req, res, next) => {
        const url = new URL(req.url || "/", "http://localhost");
        const path = url.pathname.replace(/\/+$/, "") || "/";
        if (!path.startsWith("/api/deploy")) return next();

        // --- job status (GET) ------------------------------------------------
        if (path.startsWith("/api/deploy/job/")) {
          if (req.method !== "GET") return send(res, 405, { ok: false, reason: "E_METHOD" });
          const id = path.slice("/api/deploy/job/".length);
          const job = jobs.get(id);
          if (!job) return send(res, 404, { ok: false, reason: "E_NO_JOB", message: `no job ${id} (the dev server may have restarted; the sealed receipt on the mount is the durable record)` });
          return send(res, 200, job);
        }

        if (path !== "/api/deploy/promote" && path !== "/api/deploy/publish") {
          return send(res, 404, { ok: false, reason: "E_NO_ROUTE", message: "POST /api/deploy/promote | POST /api/deploy/publish | GET /api/deploy/job/<id>" });
        }
        if (req.method !== "POST") return send(res, 405, { ok: false, reason: "E_METHOD", message: "POST only" });

        let body;
        try {
          const raw = await readBody(req);
          body = raw ? JSON.parse(raw) : {};
        } catch (e) {
          return send(res, 400, { ok: false, reason: "E_BAD_REQUEST", message: String(e.message) });
        }

        const reqObj = withEnvelope(req, body);

        // VERIFY FIRST — before the action is even looked at, so a malformed
        // intent never reaches dispatch and the refusal is about auth alone.
        const trig = verifyTrigger(reqObj);
        if (!trig.ok) {
          audit({ event: "refused", stage: "auth", path, reason: trig.reason,
                  claimed_identity: reqObj.signed_by || null, request_id: reqObj.request_id || null });
          return send(res, 401, {
            ok: false, reason: trig.reason, message: trig.detail,
            identity_file: trig.reason === "E_NO_IDENTITY_CONFIGURED" ? TRIGGER_IDENTITY_FILE : undefined,
            triggered_by: null, signature_verified: false,
          });
        }

        const id = String(reqObj.request_id || "");
        if (!REQUEST_ID.test(id)) {
          return send(res, 400, { ok: false, reason: "E_BAD_ARGS", message: `request_id must match ${REQUEST_ID}` });
        }
        // Idempotent: the answer already given IS the answer. A client that
        // timed out and retried must not cause a second promote.
        if (seen.has(id)) {
          audit({ event: "replayed", path, request_id: id, triggered_by: trig.who });
          return send(res, 200, { ...seen.get(id), replayed: true });
        }

        const attribution = { triggered_by: trig.who, signature_verified: true, issued_at: reqObj.issued_at, request_id: id };
        audit({ event: "accepted", path, request_id: id, triggered_by: trig.who,
                artifact_sha256: reqObj.artifact_sha256 || null, dry_run: reqObj.dry_run === true });

        if (path === "/api/deploy/promote") {
          // Promotion is addressed by BYTES. A git sha is refused: one commit
          // can produce several different artifacts, so a sha-addressed promote
          // could ship something nobody attested.
          if (!HEX64.test(String(reqObj.artifact_sha256 || ""))) {
            return send(res, 400, { ...attribution, ok: false, reason: "E_BAD_ARGS",
              message: "promote requires artifact_sha256 (64-hex). A git sha is not accepted: one commit can produce several different artifacts." });
          }
          const args = ["scripts/promote-artifact.mjs", "--artifact", reqObj.artifact_sha256, "--json"];
          if (reqObj.dry_run === true) args.push("--dry-run");
          // Synchronous: a promote is an S3 server-side copy, so the caller can
          // simply wait and get the gate's verdict in the response.
          return runScript(args, {
            onDone: (out) => {
              const payload = { ...attribution, action: "promote", ...out };
              // The verdict is the line someone will come looking for: it says
              // whether the GATE allowed this, which is the question that
              // matters after the fact.
              audit({ event: "promote_result", request_id: id, triggered_by: trig.who,
                      artifact_sha256: reqObj.artifact_sha256, ok: out.ok, reason: out.reason,
                      message: String(out.message || "").slice(0, 300) });
              seen.set(id, payload);
              send(res, out.ok ? 200 : 409, payload);
            },
          });
        }

        // --- publish: async, because an export runs for minutes -------------
        if (reqObj.git_sha !== undefined && !HEX40.test(String(reqObj.git_sha))) {
          return send(res, 400, { ...attribution, ok: false, reason: "E_BAD_ARGS", message: "git_sha must be 40-hex if given" });
        }
        const args = ["scripts/publish-dev-build.js", "--json"];
        if (reqObj.allow_mixed_build === true) args.push("--allow-mixed-build");
        if (reqObj.dry_run === true) args.push("--dry-run");

        const jobId = randomUUID();
        const job = { ...attribution, action: "publish", job_id: jobId, state: "running", started_at: new Date().toISOString() };
        jobs.set(jobId, job);
        runScript(args, {
          onDone: (out) => {
            const done = { ...job, state: "done", finished_at: new Date().toISOString(), ...out };
            audit({ event: "publish_result", request_id: id, job_id: jobId, triggered_by: trig.who,
                    ok: out.ok, reason: out.reason,
                    artifact_sha256: out.result?.artifact_sha256 || null,
                    url: out.result?.url || null,
                    message: String(out.message || "").slice(0, 300) });
            jobs.set(jobId, done);
            seen.set(id, done);
          },
        });
        return send(res, 202, { ...job, poll: `/api/deploy/job/${jobId}` });
      };

      // PREPENDED, not appended. astro.config sets `trailingSlash: "always"`,
      // and Astro installs a slash guard in its own post-configuration hook —
      // so an appended middleware never sees POST /api/deploy/promote at all
      // (measured: the slash-less form 404s before reaching the handler, while
      // the slashed form arrives fine). An API that silently 404s unless you
      // remember a trailing slash is a footgun for whoever is debugging at the
      // wrong hour, so we run ahead of the guard and accept both.
      //
      // Returning a function from configureServer is how Vite lets a plugin
      // install middleware AFTER the internal stack exists, which is the only
      // point where unshifting means anything.
      return () => server.middlewares.stack.unshift({ route: "", handle });
    },
  };
}
