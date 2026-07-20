#!/usr/bin/env node
/**
 * Upload the private marketing distribution strategy to the private S3 bucket
 * that backs GET /admin/marketing/distribution.
 *
 * The strategy is gitignored (private/) and must never enter the public repo or
 * the public CDN, so it can't ride along with `npm run build`. This script is
 * the deliberate, manual publish step.
 *
 * Destination is the PACKS bucket, which is fully private (all public access
 * blocked) — not the site bucket, which is world-readable through CloudFront.
 * Putting this object in the site bucket would defeat the entire design.
 *
 *   npm run push-marketing-strategy
 *   npm run push-marketing-strategy -- --dry-run
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const SRC = resolve("./private/marketing/devlog-distribution.json");
const BUCKET = "allbyte-studio-packs";
const KEY = "marketing/devlog-distribution.json";
const REGION = "us-east-1";

const dryRun = process.argv.includes("--dry-run");

if (!existsSync(SRC)) {
  console.error(`✗ Missing ${SRC}`);
  console.error("  Nothing to push. This file is gitignored by design — it only exists locally.");
  process.exit(1);
}

// Validate before upload: a malformed file would make the console panel show a
// 500 with no clue why, and the Lambda streams the bytes through verbatim.
let parsed;
try {
  parsed = JSON.parse(readFileSync(SRC, "utf8"));
} catch (e) {
  console.error(`✗ ${SRC} is not valid JSON: ${e.message}`);
  process.exit(1);
}

const REQUIRED = ["channels", "venues", "calendar", "posted"];
const missing = REQUIRED.filter((k) => !(k in parsed));
if (missing.length) {
  console.error(`✗ Strategy file is missing required key(s): ${missing.join(", ")}`);
  console.error(`  The panel expects: ${REQUIRED.join(", ")}`);
  process.exit(1);
}

const bytes = Buffer.byteLength(JSON.stringify(parsed));
console.log(`  source   ${SRC}`);
console.log(`  dest     s3://${BUCKET}/${KEY}  (private bucket)`);
console.log(
  `  content  ${Object.keys(parsed.venues ?? {}).length} audiences · ` +
    `${(parsed.calendar ?? []).length} beats · ${Object.keys(parsed.posted ?? {}).length} posted logs · ${bytes} bytes`
);

if (dryRun) {
  console.log("\n(dry run — nothing uploaded)");
  process.exit(0);
}

try {
  execFileSync(
    "aws",
    [
      "s3", "cp", SRC, `s3://${BUCKET}/${KEY}`,
      "--region", REGION,
      "--content-type", "application/json",
      // No public-read ACL, deliberately. The bucket blocks public access
      // anyway; the Lambda is the only reader.
      "--cache-control", "no-store",
    ],
    { stdio: "inherit" }
  );
  console.log("\n✓ Strategy uploaded. The console panel picks it up on next load.");
} catch (e) {
  console.error(`\n✗ Upload failed: ${e.message}`);
  process.exit(1);
}
