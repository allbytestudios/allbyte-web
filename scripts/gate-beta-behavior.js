#!/usr/bin/env node
/**
 * gate-beta-behavior.js — add (or verify) the CloudFront behavior that
 * edge-gates the beta channel: PathPattern "/godot/beta/*" with
 * TrustedKeyGroups enabled, cloned from the existing "/godot/*" behavior so
 * COOP/COEP response headers and the cache policy stay identical.
 *
 * The distribution is CLI-managed (infrastructure/cloudformation.yaml has
 * drifted and is NOT the source of truth), so this follows the same pattern
 * as the other CloudFront ops: read live config, modify, update with ETag.
 *
 *   node scripts/gate-beta-behavior.js                        # dry-run: show the plan
 *   node scripts/gate-beta-behavior.js --key-group <KG_ID> --apply
 *   node scripts/gate-beta-behavior.js --remove --apply       # roll the behavior back out
 *
 * Safety:
 *  - Always snapshots the pre-change config to .tmp/cf-config-<ts>.json
 *    (restore path: put the snapshot's DistributionConfig back with the
 *    then-current ETag).
 *  - Idempotent: existing /godot/beta/* behavior with the same key group is a
 *    no-op; a different key group is updated in place.
 *  - The new behavior is inserted BEFORE /godot/* — CloudFront matches
 *    patterns in list order, so behind it the gate would never fire.
 *
 * IMPORTANT ordering note (custom error responses): this distribution maps
 * 403/404 → /index.html with HTTP 200. An anonymous request to a gated path
 * therefore gets the SITE FALLBACK PAGE with 200, not a raw 403 — no game
 * bytes leak, but don't write a verification that expects status 403 from a
 * browser path; use smoke_prod.py --channel beta --locked-only, which
 * body-sniffs for real game content.
 */

import { execSync } from "child_process";
import { writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const DIST_ID = process.env.AWS_CLOUDFRONT_DISTRIBUTION_ID || "E1M9YWY7UW7130";
const apply = process.argv.includes("--apply");
const remove = process.argv.includes("--remove");
const kgIdx = process.argv.indexOf("--key-group");
const keyGroup = kgIdx !== -1 ? process.argv[kgIdx + 1] : null;

function die(msg) { console.error(`[gate-beta] ERROR: ${msg}`); process.exit(1); }

if (apply && !remove && !keyGroup) die("--apply requires --key-group <CloudFront key group id> (from `aws cloudfront list-key-groups`)");

const out = execSync(`aws cloudfront get-distribution-config --id ${DIST_ID}`, { encoding: "utf8" });
const { ETag, DistributionConfig: cfg } = JSON.parse(out);

// Snapshot BEFORE any change — the revert path for a CLI-managed distribution.
const snapDir = join(root, ".tmp");
mkdirSync(snapDir, { recursive: true });
const snap = join(snapDir, `cf-config-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
writeFileSync(snap, out);
console.log(`[gate-beta] pre-change config snapshot: ${snap} (ETag ${ETag})`);

const behaviors = cfg.CacheBehaviors?.Items || [];
const existing = behaviors.findIndex((b) => b.PathPattern === "/godot/beta/*");
const godotIdx = behaviors.findIndex((b) => b.PathPattern === "/godot/*");
if (godotIdx === -1) die('no "/godot/*" behavior found to clone — distribution layout changed?');

if (remove) {
  if (existing === -1) { console.log("[gate-beta] no /godot/beta/* behavior — nothing to remove."); process.exit(0); }
  behaviors.splice(existing, 1);
  cfg.CacheBehaviors.Quantity = behaviors.length;
  finish(`removed /godot/beta/* behavior`);
} else {
  const clone = JSON.parse(JSON.stringify(behaviors[godotIdx]));
  clone.PathPattern = "/godot/beta/*";
  clone.TrustedKeyGroups = { Enabled: true, Quantity: 1, Items: [keyGroup || "<KEY_GROUP_ID>"] };
  if (existing !== -1) {
    const cur = behaviors[existing];
    const curKg = cur.TrustedKeyGroups?.Items?.[0];
    if (cur.TrustedKeyGroups?.Enabled && (!keyGroup || curKg === keyGroup)) {
      console.log(`[gate-beta] /godot/beta/* already gated (key group ${curKg}) — no-op.`);
      process.exit(0);
    }
    behaviors[existing] = clone;
    finish(`updated /godot/beta/* behavior (key group → ${keyGroup})`);
  } else {
    // Insert BEFORE /godot/* — order is match priority.
    behaviors.splice(godotIdx, 0, clone);
    cfg.CacheBehaviors.Quantity = behaviors.length;
    finish(`inserted /godot/beta/* behavior before /godot/* (key group ${keyGroup || "<dry-run>"})`);
  }
}

function finish(what) {
  if (!apply) {
    console.log(`[dry-run] plan for distribution ${DIST_ID}: ${what}`);
    console.log(`[dry-run] resulting behavior order: ${behaviors.map((b) => b.PathPattern).join("  →  ")}`);
    process.exit(0);
  }
  const payload = join(snapDir, "cf-config-update.json");
  writeFileSync(payload, JSON.stringify(cfg));
  execSync(
    `aws cloudfront update-distribution --id ${DIST_ID} --if-match ${ETag} --distribution-config file://${payload}`,
    { stdio: "inherit" }
  );
  console.log(`[gate-beta] ✅ ${what}. Distribution is deploying (takes a few minutes).`);
  console.log(`[gate-beta] verify: python scripts/smoke_prod.py --channel beta --locked-only`);
  console.log(`[gate-beta] revert: restore ${snap} DistributionConfig via update-distribution with the current ETag.`);
}
