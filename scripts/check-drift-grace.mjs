#!/usr/bin/env node
// Exit successfully only when the verifier report has version-related failures
// and no other failures. Used by the scheduled drift monitor to grant the
// finalize workflow one bounded re-check without delaying unrelated alerts.
import { readFileSync } from "node:fs";

const reportPath = process.argv[2];
if (!reportPath) {
  console.error("usage: node scripts/check-drift-grace.mjs <verification-report.json>");
  process.exit(2);
}

const allowedFailures = new Set([
  "version coherence (sw.js == deployed)",
  "What's New matches live game",
]);

try {
  const report = JSON.parse(readFileSync(reportPath, "utf8"));
  const failures = report.checks?.filter((check) => check.ok === false) ?? [];
  const retryAllowed = failures.length > 0 && failures.every((check) => allowedFailures.has(check.name));
  if (!retryAllowed) {
    console.error("Drift is outside the finalize grace window; fail immediately.");
    process.exit(1);
  }
  console.log(`Finalize grace applies to: ${failures.map((check) => check.name).join(", ")}`);
} catch (error) {
  console.error(`Cannot classify verifier report: ${error.message}`);
  process.exit(2);
}
