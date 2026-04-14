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
const HISTORY_PATH = resolve("src/data/claude-usage-history.json");

// Weekly budget — calibrated to Drew's Max account.
// 8907 msg since Wed reset = 69% weekly → budget ≈ 12900 messages/week.
// Tune CLAUDE_WEEKLY_MESSAGES env var if this drifts.
const WEEKLY_BUDGET_MESSAGES = Number(process.env.CLAUDE_WEEKLY_MESSAGES) || 12900;

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

// Week window matches Anthropic's reset: Wednesday 1pm local time.
// Override via CLAUDE_WEEK_RESET_DAY (0=Sun..6=Sat) and CLAUDE_WEEK_RESET_HOUR (0-23).
const RESET_DAY = Number(process.env.CLAUDE_WEEK_RESET_DAY ?? 3);   // 3 = Wednesday
const RESET_HOUR = Number(process.env.CLAUDE_WEEK_RESET_HOUR ?? 13); // 1pm

function getWeekProgress() {
  const now = new Date();
  // Find most recent reset (Wed 1pm local)
  const reset = new Date(now);
  reset.setHours(RESET_HOUR, 0, 0, 0);
  const daysBack = (reset.getDay() - RESET_DAY + 7) % 7;
  reset.setDate(reset.getDate() - daysBack);
  // If that computed reset is in the future (e.g., today is reset day but before 1pm),
  // back it up a week.
  if (reset.getTime() > now.getTime()) {
    reset.setDate(reset.getDate() - 7);
  }
  const elapsed = now.getTime() - reset.getTime();
  const pct = Math.min(100, (elapsed / weekMs) * 100);
  return { pct, weekStart: reset.toISOString(), elapsedMs: elapsed };
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

// ============================================================================
// Historical analysis — produce weekly buckets for as far back as logs exist
// ============================================================================

// Project path → friendly label
function labelProject(dir) {
  const name = dir.toLowerCase();
  if (name.includes("allbyte-web")) return "App (web)";
  if (name.includes("gamedev-docker")) return "Docker setup";
  if (name.includes("gamedev")) return "App (game-host)";
  if (name.includes("tacticaltestdev") && name.includes("worktree")) return "Worktree";
  if (name.includes("tacticaltestdev")) return "App (TTD)";
  return "Other";
}

// Week key for a timestamp — aligned to reset (Wed 1pm local)
function weekBucketFor(ts) {
  const d = new Date(ts);
  const reset = new Date(d);
  reset.setHours(RESET_HOUR, 0, 0, 0);
  const daysBack = (reset.getDay() - RESET_DAY + 7) % 7;
  reset.setDate(reset.getDate() - daysBack);
  if (reset.getTime() > d.getTime()) reset.setDate(reset.getDate() - 7);
  return reset.toISOString().slice(0, 10);
}

// Day key (YYYY-MM-DD local)
function dayBucketFor(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// Collect daily message counts + project split
const daily = new Map(); // dayKey → { total, byProject: Map, weekKey }

for (const file of files) {
  const parts = file.split(/[\\/]/);
  const projectDir = parts[parts.indexOf("projects") + 1] || "unknown";
  const projectLabel = labelProject(projectDir);

  let content;
  try { content = readFileSync(file, "utf-8"); }
  catch { continue; }

  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type !== "assistant") continue;
    const ts = obj.timestamp ? Date.parse(obj.timestamp) : null;
    if (!ts) continue;

    const dk = dayBucketFor(ts);
    if (!daily.has(dk)) daily.set(dk, { total: 0, byProject: new Map(), weekKey: weekBucketFor(ts) });
    const bucket = daily.get(dk);
    bucket.total++;
    bucket.byProject.set(projectLabel, (bucket.byProject.get(projectLabel) ?? 0) + 1);
  }
}

// Build sorted day array (oldest first)
const dayKeys = [...daily.keys()].sort();
const days = dayKeys.map((dk) => {
  const b = daily.get(dk);
  const byProject = {};
  for (const [k, v] of b.byProject) byProject[k] = v;
  return {
    date: dk,
    weekStart: b.weekKey,
    messages: b.total,
    pctOfWeeklyBudget: Math.round((b.total / WEEKLY_BUDGET_MESSAGES) * 100 * 10) / 10, // 1 decimal
    byProject,
  };
});

// Weekly summary (for the x-axis week boundaries)
const weekly = new Map();
for (const d of days) {
  if (!weekly.has(d.weekStart)) weekly.set(d.weekStart, { messages: 0, days: 0 });
  const w = weekly.get(d.weekStart);
  w.messages += d.messages;
  w.days++;
}
const weeks = [...weekly.keys()].sort().map((wk) => ({
  weekStart: wk,
  messages: weekly.get(wk).messages,
  pctOfWeeklyBudget: Math.round((weekly.get(wk).messages / WEEKLY_BUDGET_MESSAGES) * 100),
}));

const history = {
  schema_version: 2,
  lastUpdated: new Date().toISOString(),
  resetDay: RESET_DAY,
  resetHour: RESET_HOUR,
  weeklyBudget: WEEKLY_BUDGET_MESSAGES,
  days,
  weeks,
};

writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2));
console.log(`wrote ${HISTORY_PATH}`);
console.log(`  ${days.length} days across ${weeks.length} weeks`);
for (const w of weeks.slice(-6)) {
  const daysInWeek = days.filter((d) => d.weekStart === w.weekStart).length;
  console.log(`    week ${w.weekStart}: ${w.messages} msg = ${w.pctOfWeeklyBudget}% (${daysInWeek} days)`);
}
