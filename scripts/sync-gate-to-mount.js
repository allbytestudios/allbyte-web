#!/usr/bin/env node
/**
 * sync-gate-to-mount.js — publish the attestation contract to the shared mount.
 *
 * WHY: Quinn PRODUCES attestations; this repo's gate CONSUMES them. Her
 * container cannot see this repo, so without a copy on the mount she has to
 * round-trip every validation through me — which reintroduces exactly the
 * "two halves that can't meet" gap the module was written to close, just spread
 * over hours instead of weeks.
 *
 * THE OBVIOUS RISK, HANDLED: a copy is a second source, and second sources
 * drift. This has bitten this project repeatedly (the launcher spine vs the
 * save registry; the datacenter table vs the analytics Lambda). So the copy is
 * NOT a copy anyone edits:
 *   - it is stamped GENERATED with the source path and a sha256 of the source,
 *   - `--check` re-derives that sha and reports drift with a non-zero exit,
 *   - the stamp names the one command that regenerates it.
 * The mount copy can still go stale, but it can no longer go stale INVISIBLY,
 * which is the part that actually hurts.
 *
 *   node scripts/sync-gate-to-mount.js           # publish
 *   node scripts/sync-gate-to-mount.js --check   # drift check only (CI-safe)
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const SOURCE = join(ROOT, "scripts", "lib", "attestation.mjs");
const MOUNT =
  process.env.GATE_MOUNT_DIR ||
  join(homedir(), "Desktop", "GameDev", "AutoplayRuntime", "gate");
const TARGET = join(MOUNT, "attestation.mjs");
const ATTESTATIONS = join(MOUNT, "..", "attestations");

const CHECK = process.argv.includes("--check");
const log = (...a) => console.log("[gate-sync]", ...a);

if (!existsSync(SOURCE)) {
  console.error(`[gate-sync] source missing: ${SOURCE}`);
  process.exit(1);
}
const src = readFileSync(SOURCE, "utf8");
const srcSha = createHash("sha256").update(src).digest("hex");

const MARKER = "// GENERATED-SOURCE-SHA256:";

const header = [
  "// ============================================================",
  "// GENERATED FILE — DO NOT EDIT HERE.",
  "//",
  "// Published from the webapp repo so the attestation PRODUCER can validate",
  "// its own output without round-tripping through the consumer.",
  "//",
  "//   source:     allbyte-web/scripts/lib/attestation.mjs",
  "//   regenerate: npm run sync:gate      (in allbyte-web)",
  "//   drift check: npm run sync:gate -- --check",
  "//",
  "// Edits made here are lost on the next sync AND make the two sides disagree",
  "// about what 'green' means, which is the one thing this contract exists to",
  "// prevent. Change the source, then re-sync.",
  `${MARKER} ${srcSha}`,
  "// ============================================================",
  "",
].join("\n");

if (CHECK) {
  if (!existsSync(TARGET)) {
    console.error(`[gate-sync] DRIFT: nothing published at ${TARGET} — run: npm run sync:gate`);
    process.exit(1);
  }
  // Compare the WHOLE published file against what a fresh sync would write.
  // Checking only the embedded stamp is worse than not checking at all: a
  // hand-edit to the body leaves the stamp untouched, so the check reports OK
  // while the two sides have already diverged. That is exactly what happened
  // while testing this script — the tamper went undetected.
  const cur = readFileSync(TARGET, 'utf8');
  if (cur === header + src) {
    log(`OK — published copy matches source byte for byte (${srcSha.slice(0, 12)}…)`);
    process.exit(0);
  }
  if (!cur.includes(`${MARKER} ${srcSha}`)) {
    console.error('[gate-sync] DRIFT: published copy is from a DIFFERENT source revision.');
    console.error('[gate-sync] the producer may be validating against a stale contract — run: npm run sync:gate');
  } else {
    console.error('[gate-sync] DRIFT: published copy was EDITED IN PLACE — body no longer matches the source.');
    console.error('[gate-sync] whatever changed there is invisible to the consumer. Re-sync: npm run sync:gate');
  }
  process.exit(1);
}



mkdirSync(MOUNT, { recursive: true });
writeFileSync(TARGET, header + src, "utf8");
// Create the directory the producer writes attestations into, so the agreed
// path exists before anyone needs it rather than being invented under pressure.
mkdirSync(ATTESTATIONS, { recursive: true });

log(`published → ${TARGET}`);
log(`source sha256 ${srcSha.slice(0, 16)}…`);
log(`attestations dir ready → ${ATTESTATIONS}`);
log("producer self-check:  node gate/attestation.mjs <record.json> --sha <artifact_sha256>");
