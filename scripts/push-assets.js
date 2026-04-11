/**
 * Push game assets to S3 and invalidate CloudFront.
 *
 * Uploads local game assets (music, sprites, fonts, backgrounds, the Godot
 * HTML5 export, and root-level game files) to the S3 site bucket so they're
 * available via CloudFront without being committed to git. Then issues a
 * single CloudFront invalidation for exactly the paths that were touched.
 *
 * Usage:
 *   node scripts/push-assets.js            # full push + invalidation
 *   node scripts/push-assets.js --dry-run  # print commands without executing
 *
 * Environment:
 *   AWS_S3_BUCKET                  default: allbyte.studio-site
 *   AWS_REGION                     default: us-east-1
 *   AWS_CLOUDFRONT_DISTRIBUTION_ID CloudFront distribution ID. If unset, the
 *                                  script will try to read it from the
 *                                  CloudFormation stack output.
 *   CLOUDFORMATION_STACK           stack to read distribution ID from
 *                                  (default: allbyte-studio-site)
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
const stackName = process.env.CLOUDFORMATION_STACK || "allbyte-studio-site";
const dryRun = process.argv.includes("--dry-run");

// Paths to invalidate in CloudFront. Using a Set so repeated entries collapse.
// Every successful upload branch below adds its path here; we issue one
// invalidation at the end covering all of them.
const invalidationPaths = new Set();

function run(cmd) {
  if (dryRun) {
    console.log(`[dry-run] ${cmd}`);
    return;
  }
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit" });
}

function capture(cmd) {
  return execSync(cmd, { encoding: "utf8" }).trim();
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

console.log(`\nPushing game assets to s3://${bucket}${dryRun ? " (DRY RUN)" : ""}\n`);

// 1. Sync the assets/ directory with immutable cache headers
if (existsSync(join(publicDir, "assets"))) {
  run(
    `aws s3 sync "${join(publicDir, "assets")}" s3://${bucket}/assets ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=31536000, immutable"`
  );
  invalidationPaths.add("/assets/*");
} else {
  console.log("No public/assets/ directory found. Run `npm run sync` first.");
}

// 2. Sync the godot/ HTML5 export. Most files are immutable (.wasm, .pck,
// worklets), but index.html must revalidate so updates land without a
// manual CloudFront invalidation of that specific key.
const godotDir = join(publicDir, "godot");
const godotIndex = join(godotDir, "index.html");
if (existsSync(godotDir) && existsSync(godotIndex)) {
  run(
    `aws s3 sync "${godotDir}" s3://${bucket}/godot ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=31536000, immutable" ` +
      `--exclude "index.html" ` +
      `--exclude ".gitkeep"`
  );
  run(
    `aws s3 cp "${godotIndex}" s3://${bucket}/godot/index.html ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=0, must-revalidate" ` +
      `--content-type "text/html"`
  );
  // Invalidate /godot/* so existing sessions pick up new pck/wasm hashes
  // even though S3 already has the new bytes. Also hit /play/ since its
  // cached HTML references the export.
  invalidationPaths.add("/godot/*");
  invalidationPaths.add("/play/*");
} else {
  console.log("No public/godot/index.html found. Skipping Godot export.");
}

// 3. Upload root-level game files individually
for (const file of rootFiles) {
  const filePath = join(publicDir, file);
  if (existsSync(filePath)) {
    run(
      `aws s3 cp "${filePath}" s3://${bucket}/${file} ` +
        `--region ${region} ` +
        `--cache-control "public, max-age=31536000, immutable"`
    );
    invalidationPaths.add(`/${file}`);
  } else {
    console.log(`Skip: ${file} not found locally`);
  }
}

// 3b. Sync the test dashboard snapshot from the Chronicles repo.
// The dashboard client fetches these from /test-snapshot/* in prod (see
// src/lib/testDataSource.ts). Short cache so snapshots land fast after
// CON uploads a new one; readers can still hit revalidate on each poll.
const chroniclesRoot =
  process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis";
const chroniclesIndex = join(chroniclesRoot, "test_index.json");
const chroniclesResults = join(chroniclesRoot, "test_results");
if (existsSync(chroniclesIndex)) {
  run(
    `aws s3 cp "${chroniclesIndex}" s3://${bucket}/test-snapshot/test_index.json ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=30, must-revalidate" ` +
      `--content-type "application/json"`
  );
  invalidationPaths.add("/test-snapshot/test_index.json");
  if (existsSync(chroniclesResults)) {
    // Sync test_results/ — screenshots, logs, status snapshot. Short cache so
    // the client picks up fresh status.json within a minute of upload.
    run(
      `aws s3 sync "${chroniclesResults}" s3://${bucket}/test-snapshot/test_results ` +
        `--region ${region} ` +
        `--cache-control "public, max-age=30, must-revalidate" ` +
        `--exclude ".gdignore" ` +
        `--exclude "*.import"`
    );
    invalidationPaths.add("/test-snapshot/test_results/*");
  } else {
    console.log(
      `No ${chroniclesResults} directory found. Uploading index only.`
    );
  }
} else {
  console.log(
    `No test_index.json at ${chroniclesRoot}. Skipping test dashboard snapshot.`
  );
}

// 4. Resolve CloudFront distribution ID and issue one invalidation.
function resolveDistributionId() {
  if (process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID) {
    return process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID;
  }
  try {
    const id = capture(
      `aws cloudformation describe-stacks ` +
        `--stack-name ${stackName} ` +
        `--region ${region} ` +
        `--query "Stacks[0].Outputs[?OutputKey=='DistributionId'].OutputValue" ` +
        `--output text`
    );
    if (id && id !== "None") return id;
  } catch (err) {
    console.warn(
      `Could not read DistributionId from stack '${stackName}': ${err.message.split("\n")[0]}`
    );
  }
  return null;
}

if (invalidationPaths.size === 0) {
  console.log("\nNothing uploaded. Skipping CloudFront invalidation.");
} else {
  const pathsArg = [...invalidationPaths].map((p) => `"${p}"`).join(" ");
  console.log(`\nInvalidation paths: ${[...invalidationPaths].join(", ")}`);

  const distributionId = resolveDistributionId();
  if (!distributionId) {
    console.warn(
      "\nCloudFront distribution ID not found. Set AWS_CLOUDFRONT_DISTRIBUTION_ID\n" +
        "or make sure the CloudFormation stack is named via CLOUDFORMATION_STACK.\n" +
        "Skipping invalidation — run manually:\n" +
        `  aws cloudfront create-invalidation --distribution-id <ID> --paths ${pathsArg}`
    );
  } else {
    run(
      `aws cloudfront create-invalidation ` +
        `--distribution-id ${distributionId} ` +
        `--paths ${pathsArg}`
    );
  }
}

console.log(`\nAsset push complete${dryRun ? " (dry run, nothing was uploaded)" : ""}.`);
