/**
 * The gate's refusals are the product here, so they are what gets tested: an
 * attestation that authorises a promote it should not is the failure mode this
 * whole mechanism exists to prevent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { validate, evaluate, GATE, MUST_CHECKS, SCHEMA_VERSION } from "../scripts/lib/attestation.mjs";

const SHA = "a".repeat(64);
const OTHER = "b".repeat(64);

const green = (id) => ({ check_id: id, verdict: "green", observed: { scene: "Title" }, evidence: { shot: `${id}.png` } });

const record = (over = {}) => ({
  schema_version: SCHEMA_VERSION,
  suite_id: GATE.requiredSuiteId,
  suite_version: GATE.minSuiteVersion,
  artifact_sha256: SHA,
  driver_build: "roan@1.2.3",
  run_id: "run-1",
  created_at: new Date().toISOString(),
  checks: MUST_CHECKS.map(green),
  ...over,
});

test("a complete, current attestation authorises its own artifact", () => {
  const r = evaluate(record(), SHA);
  assert.equal(r.ok, true, r.detail);
});

test("an attestation for different bytes is irrelevant, not weaker evidence", () => {
  const r = evaluate(record(), OTHER);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_ATTESTATION_MISMATCH");
});

test("a missing MUST check is not a pass", () => {
  const r = evaluate(record({ checks: MUST_CHECKS.slice(1).map(green) }), SHA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_CHECKS_MISSING");
  assert.match(r.detail, /boot_title/);
});

test("one red MUST check refuses the promote", () => {
  const checks = MUST_CHECKS.map(green);
  checks[4] = { check_id: MUST_CHECKS[4], verdict: "red", evidence: {} };
  const r = evaluate(record({ checks }), SHA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_CHECKS_RED");
  assert.match(r.detail, new RegExp(MUST_CHECKS[4]));
});

test("a waiver passes but is reported, never silent", () => {
  const checks = MUST_CHECKS.map(green);
  checks[6] = { check_id: "import_export_roundtrip", verdict: "waived", waiver_signoff: "owner: demo does not surface save transfer" };
  const r = evaluate(record({ checks }), SHA);
  assert.equal(r.ok, true);
  assert.equal(r.waived.length, 1);
  assert.match(r.waived[0].signoff, /owner:/);
});

test("a waiver without a sign-off string is malformed — not a quiet skip", () => {
  const checks = MUST_CHECKS.map(green);
  checks[6] = { check_id: "import_export_roundtrip", verdict: "waived" };
  const r = evaluate(record({ checks }), SHA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_ATTESTATION_MALFORMED");
  assert.match(r.detail, /waiver_signoff is REQUIRED/);
});

test("green without an observed postcondition is a claim, not a green", () => {
  const checks = MUST_CHECKS.map(green);
  checks[0] = { check_id: "boot_title", verdict: "green", evidence: { toast: "ok" } };
  const r = evaluate(record({ checks }), SHA);
  assert.equal(r.ok, false);
  assert.match(r.detail, /observed is REQUIRED/);
});

test("a suite cannot self-certify against a tightened gate", () => {
  // The gate's minimum lives on App's side, so a record emitted under the old
  // suite cannot satisfy a gate that has since been tightened — which is the
  // whole point of bumping suite_version when "green" changes meaning.
  const tightened = { ...GATE, minSuiteVersion: GATE.minSuiteVersion + 1 };
  const r = evaluate(record(), SHA, tightened);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_SUITE_VERSION");
});

test("suite_version below 1 is malformed, not merely insufficient", () => {
  const { ok, errors } = validate(record({ suite_version: 0 }));
  assert.equal(ok, false);
  assert.match(errors.join(";"), /positive integer/);
});

test("a renamed or forked suite is a different suite", () => {
  const r = evaluate(record({ suite_id: "prod_eligibility_min_v2_fork" }), SHA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_SUITE_ID");
});

test("a stale green is not evidence about today", () => {
  const old = new Date(Date.now() - (GATE.maxAgeDays + 1) * 86400000).toISOString();
  const r = evaluate(record({ created_at: old }), SHA);
  assert.equal(r.ok, false);
  assert.equal(r.reason, "E_ATTESTATION_STALE");
});

test("a duplicated check_id is malformed", () => {
  const checks = MUST_CHECKS.map(green);
  checks.push(green(MUST_CHECKS[0]));
  const { ok, errors } = validate(record({ checks }));
  assert.equal(ok, false);
  assert.match(errors.join(";"), /appears more than once/);
});

test("artifact_sha256 must be the publisher's canonical digest form", () => {
  const { ok, errors } = validate(record({ artifact_sha256: "not-a-digest" }));
  assert.equal(ok, false);
  assert.match(errors.join(";"), /64 lowercase hex/);
});
