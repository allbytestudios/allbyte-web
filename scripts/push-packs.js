#!/usr/bin/env node
// Upload Godot zone packs from the Chronicles build directory to the private
// S3 bucket (allbyte-studio-packs). These are served to the game client via
// short-lived signed URLs minted by the /pck-url Lambda — the bucket itself
// is never publicly readable.
//
// Usage: `npm run push-packs`
// Env:
//   PACKS_DIR  — source directory (default: Chronicles WebExport packs)
//   BUCKET     — target bucket (default: allbyte-studio-packs)

import { execSync } from "node:child_process";
import { existsSync, statSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";

const PACKS_DIR = resolve(
  process.env.PACKS_DIR ||
    "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis/DemoBuilds/WebExport/packs"
);
const BUCKET = process.env.BUCKET || "allbyte-studio-packs";
const REGION = process.env.AWS_REGION || "us-east-1";

function fail(msg) {
  console.error(`ERROR: ${msg}`);
  process.exit(1);
}

if (!existsSync(PACKS_DIR)) fail(`source directory not found: ${PACKS_DIR}`);
if (!statSync(PACKS_DIR).isDirectory()) fail(`not a directory: ${PACKS_DIR}`);

try {
  execSync("aws --version", { stdio: "ignore" });
} catch {
  fail("aws CLI not found on PATH");
}

const entries = readdirSync(PACKS_DIR).filter((f) => f.endsWith(".pck"));
if (entries.length === 0) fail(`no .pck files found in ${PACKS_DIR}`);

console.log(`Uploading ${entries.length} pack(s) to s3://${BUCKET}/packs/`);
for (const name of entries) {
  const src = join(PACKS_DIR, name);
  const dst = `s3://${BUCKET}/packs/${name}`;
  console.log(`  ${name}`);
  try {
    execSync(
      `aws s3 cp "${src}" "${dst}" --region "${REGION}" --cache-control "no-cache" --metadata-directive REPLACE`,
      { stdio: "inherit" }
    );
  } catch (e) {
    fail(`upload failed for ${name}: ${e.message}`);
  }
}

console.log(`\nDone. ${entries.length} pack(s) uploaded.`);
console.log("Next deploy / page load picks them up automatically — the /pck-url Lambda");
console.log("always mints a fresh signed URL pointing at the latest version.");
