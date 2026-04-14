#!/usr/bin/env node
// Compute rolling 7-day Claude Code usage from session JSONL logs.
// Outputs to src/data/claude-usage.json for the Console tab to render.
//
// Metric: "active hours" — number of hour-buckets (rounded) in which at
// least one assistant message happened. Better proxy for billing-window
// usage than raw message count (which varies wildly by tool usage).
//
// Usage: `node scripts/claude-usage.js`

import { readdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";

const CLAUDE_PROJECTS = join(homedir(), ".claude", "projects");
const OUT_PATH = resolve("src/data/claude-usage.json");

// Weekly budget — calibrated so this matches what Claude reports internally.
// Drew saw 69% at ~1384 messages → budget ≈ 2000 messages/week.
// Tune CLAUDE_WEEKLY_MESSAGES env var if this drifts from the real number.
const WEEKLY_BUDGET_MESSAGES = Number(process.env.CLAUDE_WEEKLY_MESSAGES) || 2000;

const nowMs = Date.now();
const weekMs = 7 * 24 * 60 * 60 * 1000;
const weekStartMs = nowMs - weekMs;

// Collect all JSONL paths across all projects
function walk(dir) {
  const out = [];
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); }
  catch { return out; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith(".jsonl")) out.push(p);
  }
  return out;
}

const files = walk(CLAUDE_PROJECTS);

// Set of hour-buckets with activity, and message count
const activeHours = new Set();
let messageCount = 0;
let firstActivityMs = Infinity;

for (const file of files) {
  // Quick filter: skip files whose mtime is older than a week
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime < weekStartMs) continue;
  } catch { continue; }

  let content;
  try { content = readFileSync(file, "utf-8"); }
  catch { continue; }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "assistant") continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
    if (!ts || ts < weekStartMs) continue;
    messageCount++;
    if (ts < firstActivityMs) firstActivityMs = ts;
    // Bucket by hour: round down to the hour
    const hourBucket = Math.floor(ts / (60 * 60 * 1000));
    activeHours.add(hourBucket);
  }
}

// Week progress: assume Drew's week is a rolling 7-day window starting 7 days ago
// at the same time of day. Progress = (now - weekStart) / weekDuration = always 100% for
// a rolling window, which isn't useful. Better: progress = (now - earliestActivity) / week
// Simpler and more intuitive: use ISO week (Monday 00:00 UTC → next Monday 00:00)
function getWeekProgress() {
  const now = new Date();
  // Find most recent Monday 00:00 local time
  const monday = new Date(now);
  const day = monday.getDay(); // 0=Sun, 1=Mon, ..., 6=Sat
  const daysFromMonday = (day + 6) % 7; // Mon=0, Tue=1, ... Sun=6
  monday.setDate(monday.getDate() - daysFromMonday);
  monday.setHours(0, 0, 0, 0);
  const elapsed = now.getTime() - monday.getTime();
  const pct = Math.min(100, (elapsed / weekMs) * 100);
  return { pct, weekStart: monday.toISOString(), elapsedMs: elapsed };
}

const weekProgress = getWeekProgress();

// Usage relative to week start (Monday) instead of rolling 7 days, so it resets
// on Monday and matches the week progress metric
const wkStart = Date.parse(weekProgress.weekStart);
const thisWeekActiveHours = new Set();
let thisWeekMessages = 0;
for (const file of files) {
  try {
    const mtime = statSync(file).mtimeMs;
    if (mtime < wkStart) continue;
  } catch { continue; }

  let content;
  try { content = readFileSync(file, "utf-8"); }
  catch { continue; }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "assistant") continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
    if (!ts || ts < wkStart) continue;
    thisWeekMessages++;
    const hourBucket = Math.floor(ts / (60 * 60 * 1000));
    thisWeekActiveHours.add(hourBucket);
  }
}

const usageHours = thisWeekActiveHours.size;
const usagePct = Math.min(100, (thisWeekMessages / WEEKLY_BUDGET_MESSAGES) * 100);

const output = {
  schema_version: 1,
  lastUpdated: new Date().toISOString(),
  week: {
    startedAt: weekProgress.weekStart,
    progressPct: Math.round(weekProgress.pct),
  },
  usage: {
    activeHours: usageHours,
    messages: thisWeekMessages,
    budgetMessages: WEEKLY_BUDGET_MESSAGES,
    usagePct: Math.round(usagePct),
  },
  // Quick interpretation: positive = ahead of schedule (burning fast), negative = behind
  paceDeltaPct: Math.round(usagePct - weekProgress.pct),
};

writeFileSync(OUT_PATH, JSON.stringify(output, null, 2));
console.log(`wrote ${OUT_PATH}`);
console.log(`  Week: ${output.week.progressPct}% elapsed since Monday ${weekProgress.weekStart.slice(0, 10)}`);
console.log(`  Usage: ${thisWeekMessages} msg / ${WEEKLY_BUDGET_MESSAGES} budget = ${output.usage.usagePct}%`);
console.log(`  Pace: ${output.paceDeltaPct > 0 ? "+" : ""}${output.paceDeltaPct}% (${output.paceDeltaPct > 5 ? "ahead" : output.paceDeltaPct < -5 ? "behind" : "on track"})`);
