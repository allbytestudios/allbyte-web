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
import { existsSync, readFileSync } from "fs";
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

// 2. Godot HTML5 export: obfuscate the WASM key first (idempotent, self-heals
//    after re-exports), verify HTML/shim consistency, then sync to S3.
//
// History: 2026-05-31 we shipped a build whose index.html was overwritten by a
// Godot re-export after obfuscation, leaving an XOR'd WASM but no un-obfuscator
// in the page. Engine booted, every PCK MD5 mismatched, black screen. The
// obfuscator now embeds a SHA-256 of the obfuscated WASM in the shim so
// repeated runs can no-op / self-heal / refuse safely. Running it here on every
// push means a re-export can never silently outpace obfuscation again.
//
// Set SKIP_GODOT_OBFUSCATION=1 to bypass (debugging only — won't deploy obfuscated
// state, will deploy whatever's in public/godot/ verbatim).
const godotDir = join(publicDir, "godot");
const godotIndex = join(godotDir, "index.html");
const shimPath = join(godotDir, "pck-key-shim.js");
if (existsSync(godotDir) && existsSync(godotIndex)) {
  // 2a. Obfuscator. Non-zero exit = refuse state, deploy halts so we don't
  // ship a half-broken build. The script's own stderr explains what to fix.
  if (process.env.SKIP_GODOT_OBFUSCATION === "1") {
    console.log("[push-assets] SKIP_GODOT_OBFUSCATION=1 — skipping obfuscator.");
  } else {
    const obfuscateCmd =
      `node "${join(root, "scripts", "obfuscate-godot-export.js")}" "${godotDir}"`;
    if (dryRun) {
      console.log(`[dry-run] ${obfuscateCmd}`);
    } else {
      console.log("[push-assets] Running Godot key obfuscator...");
      try {
        execSync(obfuscateCmd, { stdio: "inherit" });
      } catch (err) {
        console.error(
          "\n[push-assets] Obfuscator refused. Fix local state per the message " +
            "above before retrying. Aborting deploy."
        );
        process.exit(1);
      }
    }
  }

  // 2b. Consistency gate. The shim file and HTML must agree on whether
  // obfuscation is active. A mismatch reproduces the exact 2026-05-31 bug, so
  // halt before uploading to S3.
  const shimExists = existsSync(shimPath);
  if (!dryRun) {
    const htmlRefsShim = readFileSync(godotIndex, "utf8").includes("pck-key-shim.js");
    if (shimExists !== htmlRefsShim) {
      console.error(
        `\n[push-assets] HALT: shim/HTML mismatch — ` +
          `pck-key-shim.js ${shimExists ? "exists" : "missing"}, ` +
          `index.html ${htmlRefsShim ? "references" : "does not reference"} it. ` +
          `Deploying this would break /play/. Aborting.`
      );
      process.exit(1);
    }
  }

  // 2b-public. Same obfuscation + consistency gate for the player-facing
  // public build at /godot/public/ — the debug obfuscation above only covers
  // /godot/, so without this the public build would ship with its script key
  // exposed in index.wasm. Skips cleanly if the public subdir isn't present.
  const publicGodotDir = join(godotDir, "public");
  const publicGodotIndex = join(publicGodotDir, "index.html");
  const publicShimPath = join(publicGodotDir, "pck-key-shim.js");
  const havePublicBuild = existsSync(publicGodotDir) && existsSync(publicGodotIndex);
  if (havePublicBuild) {
    if (process.env.SKIP_GODOT_OBFUSCATION === "1") {
      console.log("[push-assets] SKIP_GODOT_OBFUSCATION=1 — skipping public-build obfuscator.");
    } else {
      const cmd = `node "${join(root, "scripts", "obfuscate-godot-export.js")}" "${publicGodotDir}"`;
      if (dryRun) {
        console.log(`[dry-run] ${cmd}`);
      } else {
        console.log("[push-assets] Running Godot key obfuscator (public build)...");
        try {
          execSync(cmd, { stdio: "inherit" });
        } catch (err) {
          console.error(
            "\n[push-assets] Public-build obfuscator refused. Fix local state per " +
              "the message above before retrying. Aborting deploy."
          );
          process.exit(1);
        }
      }
    }
    if (!dryRun) {
      const pubShimExists = existsSync(publicShimPath);
      const pubHtmlRefsShim = readFileSync(publicGodotIndex, "utf8").includes("pck-key-shim.js");
      if (pubShimExists !== pubHtmlRefsShim) {
        console.error(
          `\n[push-assets] HALT: public-build shim/HTML mismatch — ` +
            `pck-key-shim.js ${pubShimExists ? "exists" : "missing"}, ` +
            `public/index.html ${pubHtmlRefsShim ? "references" : "does not reference"} it. ` +
            `Aborting.`
        );
        process.exit(1);
      }
    }
  }

  // 2c. Upload. Most files are immutable (.wasm, .pck, worklets), but every
  // index.html must revalidate so updates land without a manual CloudFront
  // invalidation. Note: `--exclude "index.html"` matches the top-level key
  // only — the nested public/index.html key is "public/index.html", so it
  // needs its own exclude + must-revalidate cp (else it ships immutable and
  // the public build can't update).
  run(
    `aws s3 sync "${godotDir}" s3://${bucket}/godot ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=31536000, immutable" ` +
      `--exclude "index.html" ` +
      `--exclude "public/index.html" ` +
      `--exclude ".gitkeep"`
  );
  run(
    `aws s3 cp "${godotIndex}" s3://${bucket}/godot/index.html ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=0, must-revalidate" ` +
      `--content-type "text/html"`
  );
  if (havePublicBuild) {
    run(
      `aws s3 cp "${publicGodotIndex}" s3://${bucket}/godot/public/index.html ` +
        `--region ${region} ` +
        `--cache-control "public, max-age=0, must-revalidate" ` +
        `--content-type "text/html"`
    );
  }

  // 2d. Orphan-shim cleanup. `aws s3 sync` by default doesn't delete
  // files that exist in S3 but not locally, so when the obfuscator self-
  // heals and removes pck-key-shim.js locally, S3 keeps the stale file.
  // The 2026-06-01 black screen was caused by a stale shim on S3
  // (May 16) being loaded by any cached old HTML that still referenced
  // it — old shim XORs the new plaintext-key WASM, scrambling 32 bytes,
  // engine boots with corrupted key, every PCK MD5 mismatches.
  //
  // If pck-key-shim.js isn't present locally, delete it from S3 too.
  // Cheap belt-and-suspenders; rm against an absent key is a no-op.
  if (!shimExists) {
    if (dryRun) {
      console.log(`[dry-run] aws s3 rm s3://${bucket}/godot/pck-key-shim.js`);
    } else {
      try {
        execSync(
          `aws s3 rm s3://${bucket}/godot/pck-key-shim.js --region ${region}`,
          { stdio: "inherit" }
        );
      } catch {
        // 'No object found' is fine — that's the steady state.
      }
    }
  }

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
const chroniclesRoadmap = join(chroniclesRoot, "test_roadmap.json");
const chroniclesResults = join(chroniclesRoot, "test_results");
if (existsSync(chroniclesIndex)) {
  run(
    `aws s3 cp "${chroniclesIndex}" s3://${bucket}/test-snapshot/test_index.json ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=30, must-revalidate" ` +
      `--content-type "application/json"`
  );
  invalidationPaths.add("/test-snapshot/test_index.json");
  if (existsSync(chroniclesRoadmap)) {
    run(
      `aws s3 cp "${chroniclesRoadmap}" s3://${bucket}/test-snapshot/test_roadmap.json ` +
        `--region ${region} ` +
        `--cache-control "public, max-age=30, must-revalidate" ` +
        `--content-type "application/json"`
    );
    invalidationPaths.add("/test-snapshot/test_roadmap.json");
  }
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

// 3c. Sync the Chronicles save-fixture bundle for the marketing-queue
// fixture-picker UI. Arc's reply (CON_CLAUDE_FIXTURE_PUBLISH_OWNERSHIP.md
// 2026-06-06) confirmed publishing is AppC's lane — his container has no
// aws CLI. The bundle is ~16KB across MANIFEST.json + cond_*.json files;
// changes ~once per gameplay-milestone, so syncing on every push-assets
// run is cheap and avoids coordination overhead (Option B from his reply).
//
// AppC's marketing-fixtures.json references files by their actual
// Chronicles filenames (cond_NN_after_event_M.json), so we upload them
// verbatim to s3://allbyte.studio-site/savefixtures/data/. The src/lib/
// marketingFixtures.ts surfaces that path in prod.
const fixturesDir = join(chroniclesRoot, "WebTests", "fixtures", "saves", "frontier");
if (existsSync(fixturesDir)) {
  run(
    `aws s3 sync "${fixturesDir}" s3://${bucket}/savefixtures/data ` +
      `--region ${region} ` +
      `--cache-control "public, max-age=300, must-revalidate" ` +
      `--exclude "*" ` +
      `--include "MANIFEST.json" ` +
      `--include "cond_*.json"`
  );
  invalidationPaths.add("/savefixtures/data/*");
} else {
  console.log(
    `No save fixtures at ${fixturesDir}. Skipping fixture bundle sync.`
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

// Post-deploy smoke. Hits the live URL via Playwright and waits for
// the Godot engine to actually boot, then scrapes window._consoleLogs
// for the MD5/encryption failure signatures. Catches the class of bugs
// the in-script version-stamp smoke misses — current_version.txt loads
// independent of the PCK, so a wrong-key build still shows the correct
// version while the engine is dying silently in the iframe.
//
// Skip with SKIP_SMOKE=1 (e.g., asset-only deploys where you're
// confident the game itself didn't change). Exits non-zero on failure
// but the deploy is already live by then — manual intervention.
if (!dryRun && invalidationPaths.size > 0 && process.env.SKIP_SMOKE !== "1") {
  // Give CloudFront ~5s to start propagating before hitting the URL.
  // Most edges flip within seconds for must-revalidate HTML; the heavy
  // /godot/* assets are usually already warm. Not a guarantee — if smoke
  // fails on a cold edge, just rerun `npm run smoke:prod`.
  console.log("\nWaiting 5s for CloudFront to start propagating...");
  execSync("node -e \"setTimeout(()=>{}, 5000)\"", { stdio: "ignore" });
  console.log("[push-assets] Running post-deploy smoke (~30-60s)...");
  try {
    execSync(`python "${join(root, "scripts", "smoke_prod.py")}"`, {
      stdio: "inherit",
    });
  } catch {
    console.error(
      "\n[push-assets] SMOKE FAILED. The deploy is already live but " +
        "the engine isn't booting cleanly. Investigate before users hit it."
    );
    process.exitCode = 1;
  }
}
