/**
 * trigger-auth.mjs — ONE implementation of the deploy-trigger signing contract.
 *
 * Shared by every transport that can start a deploy: the file queue and the
 * HTTP endpoint. That is the entire point of it being a module. Two copies of
 * an HMAC contract is how the signer and the verifier quietly stop agreeing —
 * this project has already paid for duplicated contracts twice (the launcher
 * spine vs the save registry, the datacenter table vs the analytics Lambda),
 * and an auth check that silently stops matching is worse than both.
 *
 * Arc signs from Python; this verifies from Node. The canonical payload is
 * therefore a FIXED FIELD ORDER joined by newlines and NOT JSON, because JSON
 * key ordering differs between languages and a canonicalisation both sides can
 * get wrong is a contract that fails silently.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

// --- trigger identity -------------------------------------------------------
// WHAT THIS IS AND IS NOT: the signature authorises and ATTRIBUTES the trigger.
// It ships nothing by itself — promote-artifact's attestation gate is still the
// only thing that decides what goes live, so even a leaked identity cannot push
// unattested bytes. That bound is what makes this proportionate.
//
// The realistic threat here is not an attacker on the owner's own machine; it
// is a CONFUSED WRITER — a harness, a leftover fixture, a stray script dropping
// a file into requests/ and causing a real promote. Signing turns "anything
// that can write the mount can trigger" into "only a holder of a named identity
// can trigger, and the record says which one".
//
// HMAC over the request content, NOT a bearer token inside the request: a token
// written into the file would sit in requests/ and processed/ forever, so
// reading the audit trail would hand you the credential. A signature leaks
// nothing, and because it covers artifact_sha256 it cannot be lifted off one
// request and replayed onto another with different bytes.
const IDENTITY_FILE =
  process.env.TRIGGER_IDENTITY_FILE ||
  join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "queue", ".trigger-identity");
const MAX_AGE_MS = Number(process.env.TRIGGER_MAX_AGE_MS || 15 * 60 * 1000);

/** name -> secret. Never logged, never echoed into a result. */
export function loadIdentities() {
  if (!existsSync(IDENTITY_FILE)) return null;
  const out = new Map();
  const CR = String.fromCharCode(13), LF = String.fromCharCode(10);
  for (const rawLine of readFileSync(IDENTITY_FILE, "utf8").split(LF)) {
    const line = rawLine.split(CR).join("");
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const name = t.slice(0, eq).trim();
    const secret = t.slice(eq + 1).trim();
    if (name && secret.length >= 32) out.set(name, secret);
  }
  return out.size ? out : null;
}

/**
 * The exact bytes that get signed. Deliberately a fixed field order joined by
 * newlines rather than JSON: JSON key ordering differs between languages, and
 * Arc signs this from Python while we verify from Node — a canonicalisation
 * both sides can get wrong is a contract that silently fails.
 */
export function canonical(r) {
  const LF = String.fromCharCode(10);
  return [
    String(r.request_id || ""),
    String(r.action || ""),
    String(r.artifact_sha256 || ""),
    String(r.git_sha || ""),
    r.dry_run === true ? "1" : "0",
    String(r.issued_at || ""),
  ].join(LF);
}

export function verifyTrigger(r) {
  const ids = loadIdentities();
  if (!ids) {
    return { ok: false, reason: "E_NO_IDENTITY_CONFIGURED",
      detail: `no trigger identities configured at ${IDENTITY_FILE} — refusing every request rather than accepting unsigned ones` };
  }
  const who = String(r.signed_by || "");
  const secret = ids.get(who);
  if (!secret) return { ok: false, reason: "E_UNKNOWN_SIGNER", detail: `signed_by "${who}" is not a configured identity` };
  if (!r.issued_at || Number.isNaN(Date.parse(r.issued_at))) {
    return { ok: false, reason: "E_BAD_SIGNATURE", detail: "issued_at must be an ISO-8601 timestamp (it is signed, and bounds replay)" };
  }
  const age = Date.now() - Date.parse(r.issued_at);
  if (age > MAX_AGE_MS) {
    return { ok: false, reason: "E_STALE_TRIGGER", detail: `issued_at is ${Math.round(age / 60000)} min old (max ${Math.round(MAX_AGE_MS / 60000)}) — a request that sat around is not a fresh intent` };
  }
  const expect = createHmac("sha256", secret).update(canonical(r)).digest("hex");
  const got = String(r.signature || "");
  // Constant-time compare: lengths must match first or timingSafeEqual throws.
  const a = Buffer.from(expect, "utf8");
  const b = Buffer.from(got, "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, reason: "E_BAD_SIGNATURE", detail: "signature does not match the request content — it may have been altered after signing" };
  }
  return { ok: true, who };
}


/** Exposed so a caller can name the file in an error without re-deriving it. */
export const TRIGGER_IDENTITY_FILE = IDENTITY_FILE;
