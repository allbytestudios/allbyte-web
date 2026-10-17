/**
 * attestation.mjs — the QA attestation record: its schema, its validator, and
 * the gate that decides whether one authorises a promote.
 *
 * WHY THIS IS CODE AND NOT A PARAGRAPH IN A DOC: Quinn produces these records
 * and this gate consumes them. We already caught one version of this failure —
 * the whole contract keyed on `artifact_sha256` and nobody had defined what it
 * hashed — and we only caught it because she asked where the gate looks it up.
 * A schema agreed in prose has the same shape of hole. So the validator ships
 * here, she runs it against her emitter's output, and "the gate will accept
 * this" stops being a thing either of us has to take on faith.
 *
 * THE RULE THAT MATTERS MOST: an attestation never declares its own
 * sufficiency. It states what RAN. The gate — this file, on App's side — owns
 * `requiredSuiteId`, `minSuiteVersion` and the MUST set, and never reads them
 * from the record. Otherwise a suite could lower its own bar and self-certify:
 * the thing being checked would control the check, which is how the all-packs
 * mixed_build gate became noise.
 *
 * Check-set and granularity contract are Quinn's (QA_CLAUDE_PROD_PROMOTE_MIN_SUITE.md).
 */

/** Bump when the RECORD SHAPE changes — not when the suite's checks change. */
export const SCHEMA_VERSION = 1;

/**
 * The MUST set, agreed 2026-10-17. Each is a path where, if it is broken, the
 * build is dead on arrival for a player. Deliberately small: it runs on every
 * promote, and a gate that is slow or noisy is a gate people route around.
 */
export const MUST_CHECKS = [
  "boot_title",
  "new_game_entry",
  "scene_transition",
  "save_load_roundtrip",
  "combat_engage_exit",
  "menu_open_close",
  "import_export_roundtrip",
];

/** Gate policy. Lives HERE, never in the record. */
export const GATE = {
  requiredSuiteId: "prod_eligibility_min",
  minSuiteVersion: 1,
  mustChecks: MUST_CHECKS,
  /** A green older than this is not evidence about today's infrastructure. */
  maxAgeDays: 30,
};

const VERDICTS = new Set(["green", "red", "waived"]);
const HEX64 = /^[0-9a-f]{64}$/;

/**
 * Validate one attestation record's SHAPE. Returns {ok, errors[]}.
 *
 * Shape only — this says the record is well-formed and internally consistent,
 * NOT that it authorises anything. `evaluate()` decides that, and keeping the
 * two apart means a malformed record and a failing build produce different
 * messages instead of one confusing one.
 */
export function validate(rec) {
  const errors = [];
  const req = (cond, msg) => { if (!cond) errors.push(msg); };

  req(rec && typeof rec === "object", "record is not an object");
  if (errors.length) return { ok: false, errors };

  req(rec.schema_version === SCHEMA_VERSION,
      `schema_version must be ${SCHEMA_VERSION} (got ${JSON.stringify(rec.schema_version)})`);
  req(typeof rec.suite_id === "string" && rec.suite_id.length > 0, "suite_id must be a non-empty string");
  req(Number.isInteger(rec.suite_version) && rec.suite_version >= 1,
      "suite_version must be a positive integer (monotonic; not semver)");
  req(typeof rec.artifact_sha256 === "string" && HEX64.test(rec.artifact_sha256),
      "artifact_sha256 must be 64 lowercase hex chars (the publisher's canonical digest)");
  req(typeof rec.driver_build === "string" && rec.driver_build.length > 0,
      "driver_build must identify what drove the suite");
  req(typeof rec.run_id === "string" && rec.run_id.length > 0, "run_id must be a non-empty string");
  req(typeof rec.created_at === "string" && !Number.isNaN(Date.parse(rec.created_at)),
      "created_at must be an ISO-8601 timestamp");

  if (!Array.isArray(rec.checks) || rec.checks.length === 0) {
    errors.push("checks must be a non-empty array");
    return { ok: errors.length === 0, errors };
  }

  const seen = new Set();
  rec.checks.forEach((c, i) => {
    const at = `checks[${i}]`;
    if (!c || typeof c !== "object") { errors.push(`${at} is not an object`); return; }
    req(typeof c.check_id === "string" && c.check_id.length > 0, `${at}.check_id must be a non-empty string`);
    req(VERDICTS.has(c.verdict), `${at}.verdict must be green|red|waived (got ${JSON.stringify(c.verdict)})`);
    // A waiver is a decision someone made, so it must carry who made it.
    // Without this, "waived" would be indistinguishable from "skipped".
    if (c.verdict === "waived") {
      req(typeof c.waiver_signoff === "string" && c.waiver_signoff.trim().length > 0,
          `${at}.waiver_signoff is REQUIRED when verdict is "waived" (an owner sign-off string)`);
    }
    // Green must carry the observed value. The granularity contract says green
    // comes from an observed structured postcondition, never a toast or a verb
    // status:ok — so a green with nothing observed is not green, it is a claim.
    if (c.verdict === "green") {
      req(c.observed && typeof c.observed === "object" && Object.keys(c.observed).length > 0,
          `${at}.observed is REQUIRED when verdict is "green" (the observed postcondition, not a proxy)`);
    }
    if (c.check_id) {
      req(!seen.has(c.check_id), `${at}.check_id "${c.check_id}" appears more than once`);
      seen.add(c.check_id);
    }
  });

  return { ok: errors.length === 0, errors };
}

/**
 * Does this attestation authorise promoting `artifactSha256`?
 *
 * Returns {ok, reason, detail, waived[]}. Every refusal names WHICH condition
 * failed: "no attestation", "wrong suite" and "one check is red" want very
 * different responses from whoever is promoting.
 */
export function evaluate(rec, artifactSha256, gate = GATE, now = Date.now()) {
  const shape = validate(rec);
  if (!shape.ok) {
    return { ok: false, reason: "E_ATTESTATION_MALFORMED", detail: shape.errors.join("; "), waived: [] };
  }
  // The binding that makes the gate structural: this record is about THESE
  // bytes or it is about nothing. A record for a different artifact is not
  // weaker evidence, it is irrelevant evidence.
  if (rec.artifact_sha256 !== artifactSha256) {
    return {
      ok: false,
      reason: "E_ATTESTATION_MISMATCH",
      detail: `attestation is for ${rec.artifact_sha256.slice(0, 12)}…, promote is for ${String(artifactSha256).slice(0, 12)}…`,
      waived: [],
    };
  }
  if (rec.suite_id !== gate.requiredSuiteId) {
    return {
      ok: false,
      reason: "E_SUITE_ID",
      detail: `gate requires suite_id "${gate.requiredSuiteId}", record is "${rec.suite_id}" — a renamed or forked suite is a different suite`,
      waived: [],
    };
  }
  if (rec.suite_version < gate.minSuiteVersion) {
    return {
      ok: false,
      reason: "E_SUITE_VERSION",
      detail: `gate requires suite_version >= ${gate.minSuiteVersion}, record is ${rec.suite_version} — re-run the current suite`,
      waived: [],
    };
  }
  const ageDays = (now - Date.parse(rec.created_at)) / 86400000;
  if (ageDays > gate.maxAgeDays) {
    return {
      ok: false,
      reason: "E_ATTESTATION_STALE",
      detail: `attestation is ${ageDays.toFixed(1)} days old (max ${gate.maxAgeDays})`,
      waived: [],
    };
  }

  const byId = new Map(rec.checks.map((c) => [c.check_id, c]));
  const missing = gate.mustChecks.filter((id) => !byId.has(id));
  if (missing.length) {
    // Absent is NOT pass. A suite that did not run a MUST check has not
    // established the thing the gate exists to establish.
    return {
      ok: false,
      reason: "E_CHECKS_MISSING",
      detail: `MUST checks absent from the attestation: ${missing.join(", ")}`,
      waived: [],
    };
  }
  const red = gate.mustChecks.filter((id) => byId.get(id).verdict === "red");
  if (red.length) {
    return { ok: false, reason: "E_CHECKS_RED", detail: `MUST checks red: ${red.join(", ")}`, waived: [] };
  }

  const waived = gate.mustChecks
    .filter((id) => byId.get(id).verdict === "waived")
    .map((id) => ({ check_id: id, signoff: byId.get(id).waiver_signoff }));

  return {
    ok: true,
    reason: "OK",
    detail: `suite ${rec.suite_id} v${rec.suite_version}, ${gate.mustChecks.length} MUST checks satisfied` +
      (waived.length ? `, ${waived.length} waived` : ""),
    waived,
  };
}
