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
import { execSync } from "node:child_process";

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

// Hour key (YYYY-MM-DD HH local)
function hourBucketFor(ts) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hr = String(d.getHours()).padStart(2, "0");
  return `${y}-${m}-${day} ${hr}`;
}

// Collect hourly message counts + project split + token usage
const hourly = new Map(); // hourKey → { total, byProject: Map, weekKey, inputTokens, outputTokens, cacheCreate, cacheRead }

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

    const hk = hourBucketFor(ts);
    if (!hourly.has(hk)) hourly.set(hk, { total: 0, byProject: new Map(), weekKey: weekBucketFor(ts), inputTokens: 0, outputTokens: 0, cacheCreate: 0, cacheRead: 0 });
    const bucket = hourly.get(hk);
    bucket.total++;
    bucket.byProject.set(projectLabel, (bucket.byProject.get(projectLabel) ?? 0) + 1);
    const usage = obj.message?.usage;
    if (usage) {
      bucket.inputTokens += usage.input_tokens ?? 0;
      bucket.outputTokens += usage.output_tokens ?? 0;
      bucket.cacheCreate += usage.cache_creation_input_tokens ?? 0;
      bucket.cacheRead += usage.cache_read_input_tokens ?? 0;
    }
  }
}

// Build sorted hour array (oldest first)
const hourKeys = [...hourly.keys()].sort();

// Git stats: commits + line churn per hour across repos
const REPOS = [
  resolve("."), // allbyte-web (this repo)
  resolve(process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis"),
  // TacticalTestDev — the pre-Arc Chronicles sibling. Commits here reflect
  // real Claude-driven work during April 5-9 that would otherwise be missing.
  "C:/Users/drew/Documents/GitHub/TacticalTestDev",
];

const gitByHour = new Map(); // hourKey → { commits, insertions, deletions }

for (const repo of REPOS) {
  let out;
  try {
    out = execSync(`git log --since="6 weeks ago" --pretty=format:"=C=%H|%aI" --numstat`, {
      cwd: repo, encoding: "utf-8", maxBuffer: 50 * 1024 * 1024,
    });
  } catch {
    continue; // repo not a git dir or no log
  }
  // Two-pass: first accumulate per-commit totals so we can skip bulk imports
  const commits = [];
  let cur = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("=C=")) {
      if (cur) commits.push(cur);
      const [hash, iso] = line.slice(3).split("|");
      cur = { hash, iso, ins: 0, del: 0, paths: [] };
    } else if (cur && line.trim()) {
      const [insStr, delStr, path] = line.split("\t");
      const ins = parseInt(insStr, 10);
      const del = parseInt(delStr, 10);
      if (Number.isFinite(ins) && Number.isFinite(del) && path) {
        cur.paths.push({ ins, del, path });
        cur.ins += ins;
        cur.del += del;
      }
    }
  }
  if (cur) commits.push(cur);

  // Skip "bulk import" commits: > 10k net insertions likely means a
  // large codebase import/merge, not organic Claude-driven work.
  const BULK_THRESHOLD = 10000;
  const skippedCommits = commits.filter(c => c.ins > BULK_THRESHOLD).map(c => c.hash.slice(0, 7));
  if (skippedCommits.length) {
    console.log(`  skipping bulk commits in ${repo.split(/[\\/]/).pop()}: ${skippedCommits.join(", ")}`);
  }

  let currentHour = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("=C=")) {
      const [hash, iso] = line.slice(3).split("|");
      if (!iso) { currentHour = null; continue; }
      const c = commits.find(x => x.hash === hash);
      if (c && c.ins > BULK_THRESHOLD) { currentHour = null; continue; }
      currentHour = hourBucketFor(Date.parse(iso));
      if (!gitByHour.has(currentHour)) gitByHour.set(currentHour, { commits: 0, insertions: 0, deletions: 0 });
      gitByHour.get(currentHour).commits++;
    } else if (currentHour && line.trim()) {
      // numstat line: "<ins>\t<del>\t<path>"
      const [insStr, delStr, path] = line.split("\t");
      const ins = parseInt(insStr, 10);
      const del = parseInt(delStr, 10);
      if (Number.isFinite(ins) && Number.isFinite(del) && path) {
        // Skip files that inflate LOC without reflecting Claude effort:
        // - generated/data files
        // - narrative markdown (devlogs are prose, not code)
        // - WebBootstrap/ ports (mostly copies of existing Chronicles code)
        // - pack_src/ (Godot pack source copies)
        // - screenshots and binary-ish assets
        // - imported Godot project files
        const excluded =
          /package-lock|node_modules|claude-usage(-history)?\.json|asset-index\.json|test_index\.json|test_roadmap\.json|sprite-gifs\.json/.test(path) ||
          /DEVLOG[_-]|devlog[_-]|content\/devlogs\//i.test(path) ||
          /^WebBootstrap\//.test(path) ||
          /packs_src\//.test(path) ||
          /\.import$|\.tscn\.remap$|\.translation$/.test(path) ||
          /screenshot|\.png$|\.jpg$|\.jpeg$|\.webp$|\.wav$|\.ogg$|\.mp3$|\.mp4$/i.test(path);
        if (excluded) continue;
        gitByHour.get(currentHour).insertions += ins;
        gitByHour.get(currentHour).deletions += del;
      }
    }
  }
}

// Ticket completions per hour from phaseHistory
const ticketsByHour = new Map(); // hourKey → { done, moved }
try {
  const CHRONICLES_DIR = resolve(process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis");
  const ticketsData = JSON.parse(readFileSync(join(CHRONICLES_DIR, "tickets/tickets.json"), "utf-8"));
  for (const t of ticketsData.tickets ?? []) {
    for (const h of t.phaseHistory ?? []) {
      if (!h.entered) continue;
      const hk = hourBucketFor(Date.parse(h.entered));
      if (!ticketsByHour.has(hk)) ticketsByHour.set(hk, { done: 0, moved: 0 });
      ticketsByHour.get(hk).moved++;
      if (h.phase === "done") ticketsByHour.get(hk).done++;
    }
  }
} catch {
  // tickets.json unavailable
}

// Arc's efficiency metrics per hour (if available).
// Arc writes tickets/efficiency_metrics.ndjson with per-cycle data.
// Tolerant field reading: accepts multiple naming conventions for tokens
// (input_tokens/inputTokens, output_tokens/outputTokens, etc.)
function pick(obj, ...keys) {
  for (const k of keys) {
    if (obj[k] != null) return obj[k];
  }
  return 0;
}

const efficiencyByHour = new Map(); // hourKey → { cycles, tickets_moved, agents_spawned, arcMessages, arcInput, arcOutput, arcCacheCreate, arcCacheRead }
try {
  const CHRONICLES_DIR = resolve(process.env.CHRONICLES_DIR || "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis");
  const content = readFileSync(join(CHRONICLES_DIR, "tickets/efficiency_metrics.ndjson"), "utf-8");
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    try {
      const m = JSON.parse(line);
      const hk = hourBucketFor(Date.parse(m.timestamp));
      if (!efficiencyByHour.has(hk)) efficiencyByHour.set(hk, {
        cycles: 0, tickets_moved: 0, agents_spawned: 0,
        arcMessages: 0, arcInput: 0, arcOutput: 0, arcCacheCreate: 0, arcCacheRead: 0,
        arcTotalTokens: 0,
      });
      const b = efficiencyByHour.get(hk);
      b.cycles++;
      b.tickets_moved += pick(m, "tickets_moved", "ticketsMoved");
      b.agents_spawned += pick(m, "agents_spawned", "agentsSpawned")
                        + pick(m, "subagents_spawned", "subagentsSpawned");
      // Token fields — Arc may write either single total or split breakdown
      b.arcMessages    += pick(m, "messages", "messageCount", "message_count");
      b.arcInput       += pick(m, "input_tokens", "inputTokens");
      b.arcOutput      += pick(m, "output_tokens", "outputTokens");
      b.arcCacheCreate += pick(m, "cache_creation_input_tokens", "cacheCreationInputTokens", "cache_create_tokens", "cacheCreateTokens");
      b.arcCacheRead   += pick(m, "cache_read_input_tokens", "cacheReadInputTokens", "cache_read_tokens", "cacheReadTokens");
      b.arcTotalTokens += pick(m, "tokens", "totalTokens", "total_tokens");
    } catch {}
  }
} catch {
  // efficiency_metrics.ndjson unavailable
}

// Merge all hour-keys (message hours + git hours + ticket hours)
const allHourKeys = [...new Set([
  ...hourKeys,
  ...gitByHour.keys(),
  ...ticketsByHour.keys(),
  ...efficiencyByHour.keys(),
])].sort();

const hours = allHourKeys.map((hk) => {
  const b = hourly.get(hk) ?? { total: 0, byProject: new Map(), weekKey: weekBucketFor(Date.parse(hk.replace(" ", "T") + ":00:00")), inputTokens: 0, outputTokens: 0, cacheCreate: 0, cacheRead: 0 };
  const byProject = {};
  for (const [k, v] of b.byProject) byProject[k] = v;
  const git = gitByHour.get(hk) ?? { commits: 0, insertions: 0, deletions: 0 };
  const tix = ticketsByHour.get(hk) ?? { done: 0, moved: 0 };
  const eff = efficiencyByHour.get(hk) ?? {
    cycles: 0, tickets_moved: 0, agents_spawned: 0,
    arcMessages: 0, arcInput: 0, arcOutput: 0, arcCacheCreate: 0, arcCacheRead: 0,
    arcTotalTokens: 0,
  };
  // Tag Arc's project bucket if he contributed here
  if (eff.arcMessages > 0) byProject["Arc (container)"] = (byProject["Arc (container)"] ?? 0) + eff.arcMessages;
  // If Arc only provided the total, use it as the "fresh tokens" fallback.
  // When Arc provides the split, the total field may still be present — prefer the split.
  const arcHasSplit = eff.arcInput + eff.arcOutput + eff.arcCacheCreate + eff.arcCacheRead > 0;
  const arcFresh = arcHasSplit
    ? (eff.arcInput + eff.arcOutput + eff.arcCacheCreate)
    : eff.arcTotalTokens;
  // Merged totals = host-side + Arc
  const mergedMessages = b.total + eff.arcMessages;
  const mergedInput    = b.inputTokens + eff.arcInput;
  const mergedOutput   = b.outputTokens + eff.arcOutput;
  const mergedCreate   = b.cacheCreate + eff.arcCacheCreate;
  const mergedRead     = b.cacheRead + eff.arcCacheRead;
  return {
    hour: hk,
    weekStart: b.weekKey,
    messages: mergedMessages,
    hostMessages: b.total,
    arcMessages: eff.arcMessages,
    pctOfWeeklyBudget: Math.round((mergedMessages / WEEKLY_BUDGET_MESSAGES) * 100 * 100) / 100,
    byProject,
    commits: git.commits,
    insertions: git.insertions,
    deletions: git.deletions,
    churn: git.insertions + git.deletions,
    ticketsDone: tix.done,
    ticketsMoved: tix.moved,
    efficiencyCycles: eff.cycles,
    inputTokens: mergedInput,
    outputTokens: mergedOutput,
    cacheCreate: mergedCreate,
    cacheRead: mergedRead,
    freshTokens: (mergedInput + mergedOutput + mergedCreate) + (arcHasSplit ? 0 : arcFresh),
  };
});

// Weekly summary — aggregate all signals per week
const weekly = new Map();
for (const h of hours) {
  if (!weekly.has(h.weekStart)) weekly.set(h.weekStart, { messages: 0, commits: 0, insertions: 0, deletions: 0, ticketsDone: 0, outputTokens: 0, freshTokens: 0 });
  const w = weekly.get(h.weekStart);
  w.messages += h.messages;
  w.commits += h.commits;
  w.insertions += h.insertions;
  w.deletions += h.deletions;
  w.ticketsDone += h.ticketsDone;
  w.outputTokens += h.outputTokens;
  w.freshTokens += h.freshTokens;
}
const weeks = [...weekly.keys()].sort().map((wk) => {
  const w = weekly.get(wk);
  return {
    weekStart: wk,
    messages: w.messages,
    pctOfWeeklyBudget: Math.round((w.messages / WEEKLY_BUDGET_MESSAGES) * 100),
    commits: w.commits,
    insertions: w.insertions,
    deletions: w.deletions,
    churn: w.insertions + w.deletions,
    ticketsDone: w.ticketsDone,
    outputTokens: w.outputTokens,
    freshTokens: w.freshTokens,
    msgPerCommit: w.commits > 0 ? Math.round(w.messages / w.commits) : null,
    msgPerTicket: w.ticketsDone > 0 ? Math.round(w.messages / w.ticketsDone) : null,
  };
});

const history = {
  schema_version: 4,
  lastUpdated: new Date().toISOString(),
  resetDay: RESET_DAY,
  resetHour: RESET_HOUR,
  weeklyBudget: WEEKLY_BUDGET_MESSAGES,
  hours,
  weeks,
};

// Safety: verify output doesn't accidentally leak paths/names before writing
const outStr = JSON.stringify(history, null, 2);
const LEAK_PATTERNS = [/drew/i, /bruce/i, /beitman/i, /C:[\\/]/i, /\/home\//i, /AppData/i];
for (const p of LEAK_PATTERNS) {
  if (p.test(outStr)) {
    console.error(`ERROR: output matches leak pattern ${p} — refusing to write`);
    process.exit(1);
  }
}
writeFileSync(HISTORY_PATH, outStr);
console.log(`wrote ${HISTORY_PATH}`);
console.log(`  ${hours.length} hours across ${weeks.length} weeks`);
for (const w of weeks.slice(-6)) {
  const hoursInWeek = hours.filter((h) => h.weekStart === w.weekStart).length;
  console.log(`    week ${w.weekStart}: ${w.messages} msg = ${w.pctOfWeeklyBudget}% (${hoursInWeek} active hours)`);
}
