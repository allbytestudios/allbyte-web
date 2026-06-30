#!/usr/bin/env node
/**
 * sync-marketing-posts.mjs — the AUTOMATED half of the hybrid marketing-posts
 * dataset that feeds the "Marketing Posts" chart in the Dev Console.
 *
 * Pulls published posts straight from the self-hosted Postiz Postgres (the 6
 * automated channels: Bluesky / Discord / Mastodon / YouTube / Threads /
 * dev.to) and merges them into src/data/marketing-posts.json, PRESERVING every
 * hand-logged entry (source="manual": X / Reddit / TikTok / Patreon).
 *
 *   npm run sync:marketing
 *
 * Requires the marketing stack to be up:
 *   docker compose -f infrastructure/marketing/docker-compose.yml up -d
 *
 * No DB credentials are handled here — we `docker exec` into the Postgres
 * container and let psql's local trust auth do the work. Container / db / user
 * default to the committed compose values; override via env if yours differ:
 *   POSTIZ_PG_CONTAINER (default allbyte-marketing-postgres)
 *   POSTIZ_PG_USER      (default postiz-user)
 *   POSTIZ_PG_DB        (default postiz-db-local)
 */

import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_FILE = join(__dirname, "..", "src", "data", "marketing-posts.json");

const PG_CONTAINER = process.env.POSTIZ_PG_CONTAINER || "allbyte-marketing-postgres";
const PG_USER = process.env.POSTIZ_PG_USER || "postiz-user";
const PG_DB = process.env.POSTIZ_PG_DB || "postiz-db-local";

// Postiz is a Prisma/Postgres app. Published posts live in "Post"; the channel
// is on the joined "Integration" via "providerIdentifier" (bluesky/discord/…).
// NOTE: Postiz's schema can drift across versions — if this query errors on a
// missing table/column, adjust the quoted identifiers to match your instance
// (`docker exec -it <container> psql -U postiz-user -d postiz-db-local -c '\d "Post"'`).
const SQL = `
  SELECT to_char(p."publishDate", 'YYYY-MM-DD') AS date,
         i."providerIdentifier" AS platform
  FROM "Post" p
  JOIN "Integration" i ON i.id = p."integrationId"
  WHERE p.state = 'PUBLISHED'
    AND p."publishDate" IS NOT NULL
    AND p."deletedAt" IS NULL
  ORDER BY p."publishDate";
`.trim();

function queryPostiz() {
  // -F',' field sep, -A unaligned, -t tuples-only → clean CSV of date,platform
  const out = execFileSync(
    "docker",
    ["exec", PG_CONTAINER, "psql", "-U", PG_USER, "-d", PG_DB, "-F,", "-A", "-t", "-c", SQL],
    { encoding: "utf8" }
  );
  const posts = [];
  for (const line of out.split("\n")) {
    const row = line.trim();
    if (!row) continue;
    const [date, platform] = row.split(",");
    if (!date || !platform) continue;
    posts.push({ date, platform, source: "postiz" });
  }
  return posts;
}

function main() {
  let existing;
  try {
    existing = JSON.parse(readFileSync(DATA_FILE, "utf8"));
  } catch (e) {
    console.error(`Could not read ${DATA_FILE}: ${e.message}`);
    process.exit(1);
  }

  // Keep every hand-logged entry; only the Postiz-sourced rows get replaced.
  const manual = (existing.posts ?? []).filter((p) => p.source === "manual");

  let automated;
  try {
    automated = queryPostiz();
  } catch (e) {
    console.error("Postiz query failed — is the marketing stack up?");
    console.error(`  docker compose -f infrastructure/marketing/docker-compose.yml up -d`);
    console.error(`  (${e.message.split("\n")[0]})`);
    console.error("Leaving marketing-posts.json untouched.");
    process.exit(1);
  }

  // Merge: manual first (stable), then automated, sorted by date.
  const merged = [...manual, ...automated].sort((a, b) =>
    a.date < b.date ? -1 : a.date > b.date ? 1 : 0
  );

  const output = {
    _comment: existing._comment,
    generatedAt: new Date().toISOString(),
    posts: merged,
  };
  writeFileSync(DATA_FILE, JSON.stringify(output, null, 2) + "\n");
  console.log(
    `Synced marketing posts: ${automated.length} from Postiz + ${manual.length} manual = ${merged.length} total.`
  );
}

main();
