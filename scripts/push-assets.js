/**
 * Push game assets to S3.
 *
 * Uploads local game assets (music, sprites, fonts, backgrounds, and
 * root-level game files) to the S3 site bucket so they're available
 * via CloudFront without being committed to git.
 *
 * Usage:
 *   node scripts/push-assets.js
 *
 * Requires:
 *   - AWS CLI configured with credentials
 *   - AWS_S3_BUCKET environment variable (or uses default)
 */

import { execSync } from "child_process";
import { existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const publicDir = join(root, "public");

const bucket = process.env.AWS_S3_BUCKET || "allbyte.studio-site";
const region = process.env.AWS_REGION || "us-east-1";

function run(cmd) {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

// Root-level game files that need to be on S3
const rootFiles = [
  "Anthem2.mp3",
  "cursor-move.wav",
  "ChroniclesOfNesisTitle.gif",
  "ChroniclesOfNesisTitle-still.png",
  "ChroniclesOfNesisTitleName.png",
  "BattleChargeRight.gif",
  "BattleChargeRight-still.png",
  "Flourish.png",
  "leftSword.png",
  "verticalSword.png",
  "fonts/ModernGoth.otf",
  "tier-initiate.png",
  "tier-none.png",
];

console.log(`\nPushing game assets to s3://${bucket}\n`);

// 1. Sync the assets/ directory with immutable cache headers
if (existsSync(join(publicDir, "assets"))) {
  run(
    `aws s3 sync "${join(publicDir, "assets")}" s3://${bucket}/assets ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=31536000, immutable"`
  );
} else {
  console.log("No public/assets/ directory found. Run `npm run sync` first.");
}

// 2. Upload root-level game files individually
for (const file of rootFiles) {
  const filePath = join(publicDir, file);
  if (existsSync(filePath)) {
    run(
      `aws s3 cp "${filePath}" s3://${bucket}/${file} ` +
        `--region ${region} ` +
        `--cache-control "public, max-age=31536000, immutable"`
    );
  } else {
    console.log(`Skip: ${file} not found locally`);
  }
}

console.log("\nAsset push complete.");
