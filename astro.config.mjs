import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync, statSync, appendFileSync, readFileSync, writeFileSync, realpathSync, watch as fsWatch } from "node:fs";
import { join, normalize, resolve, sep, relative } from "node:path";
import { spawn } from "node:child_process";
import chokidar from "chokidar";

const chroniclesRoot = resolve(
  process.env.CHRONICLES_DIR ||
    "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis"
);

// Dev-only proxy: serves /test-data/* AND /godot/* live from the Chronicles
// repo so neither the test dashboard nor the playable Godot demo need a manual
// copy step when CON Claude rebuilds. In prod, /test-snapshot/* and /godot/*
// come from the S3 bucket populated by `npm run push-assets`.
function chroniclesProxy() {
  // Where Godot's HTML5 export lands inside the Chronicles repo.
  const godotExportRel = "WebBootstrap/export";

  function streamFile(full, res, isGodot) {
    res.setHeader("Cache-Control", "no-store");
    if (isGodot) {
      res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
      res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
      res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
    }
    const lower = full.toLowerCase();
    if (lower.endsWith(".json")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    } else if (lower.endsWith(".ndjson")) {
      res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    } else if (lower.endsWith(".html") || lower.endsWith(".htm")) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
    } else if (lower.endsWith(".js")) {
      res.setHeader("Content-Type", "application/javascript; charset=utf-8");
    } else if (lower.endsWith(".wasm")) {
      res.setHeader("Content-Type", "application/wasm");
    } else if (lower.endsWith(".pck")) {
      res.setHeader("Content-Type", "application/octet-stream");
    } else if (lower.endsWith(".png")) {
      res.setHeader("Content-Type", "image/png");
    } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      res.setHeader("Content-Type", "image/jpeg");
    } else if (lower.endsWith(".webm")) {
      res.setHeader("Content-Type", "video/webm");
    } else if (lower.endsWith(".log") || lower.endsWith(".txt")) {
      res.setHeader("Content-Type", "text/plain; charset=utf-8");
    }
    createReadStream(full).pipe(res);
  }

  function makeProxy(prefix, baseRel, isGodot) {
    return (req, res, next) => {
      try {
        const url = new URL(req.url || "/", "http://localhost");
        const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
        const baseDir = baseRel
          ? normalize(join(chroniclesRoot, baseRel))
          : chroniclesRoot;
        const full = normalize(join(baseDir, rel));
        // First check: the normalized path must be under baseDir (catches ../
        // traversal in the URL).
        if (!full.startsWith(baseDir + sep) && full !== baseDir) {
          res.statusCode = 400;
          return res.end("bad path");
        }
        if (!existsSync(full) || !statSync(full).isFile()) {
          return next();
        }
        // Second check: resolve symlinks, reject if the real path escapes
        // baseDir. Protects against a symlink inside Chronicles pointing out.
        let realFull;
        try {
          realFull = realpathSync(full);
        } catch {
          res.statusCode = 500;
          return res.end("cannot resolve path");
        }
        const realBase = realpathSync(baseDir);
        if (!realFull.startsWith(realBase + sep) && realFull !== realBase) {
          res.statusCode = 403;
          return res.end("forbidden");
        }
        streamFile(realFull, res, isGodot);
      } catch (err) {
        res.statusCode = 500;
        res.end(String(err && err.message ? err.message : err));
      }
    };
  }

  return {
    name: "allbyte-chronicles-proxy",
    configureServer(server) {
      server.middlewares.use("/test-data", makeProxy("/test-data", "", false));
      server.middlewares.use("/godot", makeProxy("/godot", godotExportRel, true));
    },
  };
}

// Dev-only proxy for autoplay-capture artifacts. Serves files from the
// local capture output dir (default .tmp/capture-out/) at /captures-local/*
// so the marketing-queue UI can fetch manifest.json + clip MP4s + thumbs
// without committing the (large, churn-heavy) artifact files to git.
//
// In prod, the marketing-queue will read from S3 instead — this proxy
// doesn't ship.
function captureLocalProxy() {
  const captureRoot = resolve(
    process.env.CAPTURE_OUT_DIR ||
      join(process.cwd(), ".tmp", "capture-out")
  );

  function streamLocalFile(full, res) {
    res.setHeader("Cache-Control", "no-store");
    const lower = full.toLowerCase();
    if (lower.endsWith(".json")) {
      res.setHeader("Content-Type", "application/json; charset=utf-8");
    } else if (lower.endsWith(".mp4")) {
      res.setHeader("Content-Type", "video/mp4");
    } else if (lower.endsWith(".png")) {
      res.setHeader("Content-Type", "image/png");
    } else if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
      res.setHeader("Content-Type", "image/jpeg");
    }
    createReadStream(full).pipe(res);
  }

  return {
    name: "allbyte-capture-local-proxy",
    configureServer(server) {
      server.middlewares.use("/captures-local", (req, res, next) => {
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
          const full = normalize(join(captureRoot, rel));
          if (!full.startsWith(captureRoot + sep) && full !== captureRoot) {
            res.statusCode = 400;
            return res.end("bad path");
          }
          if (!existsSync(full) || !statSync(full).isFile()) {
            return next();
          }
          // Symlink-safety: same realpath check as chroniclesProxy. Capture
          // root may not exist on a fresh checkout — bail to next() in that
          // case so the UI's empty-state path renders cleanly.
          let realFull, realBase;
          try {
            realFull = realpathSync(full);
            realBase = realpathSync(captureRoot);
          } catch {
            return next();
          }
          if (!realFull.startsWith(realBase + sep) && realFull !== realBase) {
            res.statusCode = 403;
            return res.end("forbidden");
          }
          streamLocalFile(realFull, res);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err && err.message ? err.message : err));
        }
      });
    },
  };
}

// Dev-only POST endpoint for publishing marketing-queue clips to Postiz.
// Spawns the `postiz` global CLI under the marketing/postiz.ps1 wrapper
// so POSTIZ_API_KEY + POSTIZ_API_URL come from the gitignored .env file
// (never the env of this dev server). Receives { platform, content,
// mediaUrl, dryRun } and returns the CLI exit code + stdout/stderr.
//
// Production deploy doesn't include this middleware — the marketing UI
// hides publish buttons when import.meta.env.DEV is false.
function marketingPublish() {
  const MAX_BODY = 32 * 1024;
  const ALLOWED_PLATFORMS = new Set([
    "discord", "bluesky", "mastodon", "twitter", "x", "youtube",
    "instagram", "tiktok", "reddit", "linkedin", "threads",
  ]);

  function spawnPostiz(args, cb) {
    // Wrapper resolves env (key, URL) and forwards to global `postiz`.
    // Using PowerShell since the wrapper is .ps1 (Windows-only as written).
    const wrapper = join(process.cwd(), "infrastructure", "marketing", "postiz.ps1");
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", wrapper, ...args],
      { cwd: process.cwd() },
    );
    let stdout = "", stderr = "";
    child.stdout.on("data", (d) => { stdout += d.toString(); });
    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("close", (code) => cb(code, stdout, stderr));
    child.on("error", (err) => cb(-1, stdout, stderr + String(err)));
  }

  function findIntegrationId(platform, cb) {
    spawnPostiz(["integrations:list"], (code, stdout, stderr) => {
      if (code !== 0) return cb(new Error(`integrations:list exit ${code}: ${stderr}`));
      // CLI prints a header line, then a JSON array. Find the JSON.
      const jsonStart = stdout.indexOf("[");
      if (jsonStart === -1) return cb(new Error("no JSON in integrations:list output"));
      try {
        const list = JSON.parse(stdout.slice(jsonStart));
        const match = list.find((i) => i.identifier === platform && !i.disabled);
        if (!match) return cb(new Error(`no enabled integration for platform '${platform}'`));
        cb(null, match.id, match);
      } catch (e) {
        cb(new Error(`failed to parse integrations: ${e.message}`));
      }
    });
  }

  return {
    name: "allbyte-marketing-publish",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST" || (req.url || "").replace(/\/$/, "") !== "/api/marketing/publish") {
          return next();
        }
        let body = "", tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (body.length > MAX_BODY) {
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ error: "body too large" }));
            req.destroy();
          }
        });
        req.on("end", () => {
          if (tooLarge) return;
          let payload;
          try { payload = JSON.parse(body); } catch {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "invalid JSON body" }));
          }
          const { platform, content, mediaUrl, dryRun } = payload || {};
          if (!platform || typeof platform !== "string" || !ALLOWED_PLATFORMS.has(platform)) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "platform required and must be a known identifier" }));
          }
          if (!content || typeof content !== "string" || content.length === 0 || content.length > 4000) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "content required, 1-4000 chars" }));
          }
          if (mediaUrl && typeof mediaUrl !== "string") {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "mediaUrl must be a string if present" }));
          }

          findIntegrationId(platform, (err, integrationId, integration) => {
            if (err) {
              res.statusCode = 502;
              return res.end(JSON.stringify({ error: err.message }));
            }
            if (dryRun) {
              res.setHeader("Content-Type", "application/json");
              return res.end(JSON.stringify({ ok: true, dryRun: true, integration }));
            }
            const args = [
              "posts:create",
              "-c", content,
              "-s", new Date().toISOString(),
              "-i", integrationId,
              "-t", "schedule",
            ];
            if (mediaUrl) args.push("-m", mediaUrl);
            spawnPostiz(args, (code, stdout, stderr) => {
              res.setHeader("Content-Type", "application/json");
              if (code !== 0) {
                res.statusCode = 502;
                return res.end(JSON.stringify({
                  error: `posts:create exit ${code}`,
                  stdout: stdout.slice(-2000),
                  stderr: stderr.slice(-2000),
                }));
              }
              res.end(JSON.stringify({
                ok: true,
                integration: { id: integrationId, platform, name: integration.name },
                stdout: stdout.slice(-2000),
              }));
            });
          });
        });
      });
    },
  };
}

// Dev-only POST endpoint for caption drafting via the host's `claude` CLI.
// Spawns tests/autoplay-capture/caption_drafter.py which shells out to
// `claude -p ... --json-schema ...`. Consumes Claude Code subscription
// quota, NOT the Anthropic API (per the owner's "use this account" pref).
//
// Request shape:
//   { clip?: string }  — if present, draft just that one clip's captions.
//                        Otherwise drafts the whole manifest.
//
// Production: middleware doesn't exist. UI button hides in prod.
function captionDrafter() {
  const MAX_BODY = 2 * 1024;
  return {
    name: "allbyte-caption-drafter",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method !== "POST" || (req.url || "").replace(/\/$/, "") !== "/api/marketing/draft-captions") {
          return next();
        }
        let body = "", tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (body.length > MAX_BODY) {
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ error: "body too large" }));
            req.destroy();
          }
        });
        req.on("end", () => {
          if (tooLarge) return;
          let payload = {};
          if (body) {
            try { payload = JSON.parse(body); } catch {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "invalid JSON body" }));
            }
          }
          const clip = typeof payload.clip === "string" ? payload.clip : null;
          if (clip && !/^[A-Za-z0-9_-]{1,64}$/.test(clip)) {
            res.statusCode = 400;
            return res.end(JSON.stringify({ error: "invalid clip name" }));
          }

          const scriptPath = join(
            process.cwd(),
            "tests", "autoplay-capture", "caption_drafter.py",
          );
          const captureOut = process.env.CAPTURE_OUT_DIR ||
            join(process.cwd(), ".tmp", "capture-out");
          const clipsDir = join(captureOut, "clips");

          const args = [scriptPath];
          if (clip) args.push(clip);

          const child = spawn("python", args, {
            cwd: process.cwd(),
            env: {
              ...process.env,
              CLIPS_DIR: clipsDir,
              // CAPTION_BACKEND defaults to "cli" inside the script.
            },
          });
          let stdout = "", stderr = "";
          child.stdout.on("data", (d) => { stdout += d.toString(); });
          child.stderr.on("data", (d) => { stderr += d.toString(); });
          child.on("close", (code) => {
            res.setHeader("Content-Type", "application/json");
            if (code !== 0) {
              res.statusCode = 502;
              return res.end(JSON.stringify({
                error: `caption_drafter exit ${code}`,
                stdout: stdout.slice(-2000),
                stderr: stderr.slice(-2000),
              }));
            }
            res.end(JSON.stringify({
              ok: true,
              stdout: stdout.slice(-2000),
              clip,
            }));
          });
          child.on("error", (err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err.message ?? err) }));
          });
        });
      });
    },
  };
}

// Dev-only POST endpoint for owner decision write-back.
// Writes to agent_chat.ndjson in the Chronicles repo.
function decisionWriteback() {
  return {
    name: "allbyte-decision-writeback",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.replace(/\/$/, "") ?? "";
        if (req.method !== "POST" || url !== "/api/decisions") return next();
        // Body size cap — prevents a trivial flood that appends megabytes
        // to agent_chat.ndjson. 16KB is plenty for a decision + note.
        const MAX_BODY = 16 * 1024;
        let body = "";
        let tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (body.length > MAX_BODY) {
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ error: "body too large" }));
            req.destroy();
          }
        });
        req.on("end", () => {
          if (tooLarge) return;
          try {
            const { decisionId, choice } = JSON.parse(body);
            if (!decisionId || !choice) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "decisionId and choice required" }));
            }
            // Validate decisionId shape: letters/digits/dash/underscore only,
            // max 64 chars. Blocks injection via weird IDs.
            if (typeof decisionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(decisionId)) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "invalid decisionId format" }));
            }
            // Choice: string, max 4KB (custom replies allowed, but not essays).
            if (typeof choice !== "string" || choice.length > 4096) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "invalid choice" }));
            }
            const chatPath = normalize(join(chroniclesRoot, "tickets", "agent_chat.ndjson"));
            // Append owner decision as a new chat message
            const msg = {
              timestamp: new Date().toISOString(),
              from: "Owner",
              to: "Arc",
              channel: "decisions",
              message: `Decision ${decisionId}: ${choice}`,
              decision: { id: decisionId, choice, status: "resolved" },
            };
            appendFileSync(chatPath, JSON.stringify(msg) + "\n");
            // Update the original decision's status in the NDJSON
            const lines = readFileSync(chatPath, "utf-8").trim().split("\n");
            let updated = false;
            const newLines = lines.map((line) => {
              try {
                const parsed = JSON.parse(line);
                if (parsed.decision?.id === decisionId && parsed.from !== "Owner") {
                  parsed.decision.status = "resolved";
                  parsed.decision.chosenBy = "Owner";
                  parsed.decision.chosenOption = choice;
                  updated = true;
                  return JSON.stringify(parsed);
                }
              } catch {}
              return line;
            });
            if (updated) writeFileSync(chatPath, newLines.join("\n") + "\n");
            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, decisionId, choice }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
      });
    },
  };
}

// Dev-only POST endpoint for owner answer write-back. Append-only NDJSON
// stream at tickets/owner_answers.ndjson — Arc tails this and applies
// answers to the source-of-truth files (tickets, epics, agent_chat).
// Kept separate from agent_chat.ndjson so verification + freeText answers
// don't pollute the conversation stream. Choice answers are mirrored to
// BOTH this file AND agent_chat.ndjson during a transition window so the
// existing decision-resolved flow keeps working.
function ownerAnswerWriteback() {
  return {
    name: "allbyte-owner-answer-writeback",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url?.replace(/\/$/, "") ?? "";
        if (req.method !== "POST" || url !== "/api/answers") return next();
        const MAX_BODY = 16 * 1024;
        let body = "";
        let tooLarge = false;
        req.on("data", (chunk) => {
          if (tooLarge) return;
          body += chunk;
          if (body.length > MAX_BODY) {
            tooLarge = true;
            res.statusCode = 413;
            res.end(JSON.stringify({ error: "body too large" }));
            req.destroy();
          }
        });
        req.on("end", () => {
          if (tooLarge) return;
          try {
            const parsed = JSON.parse(body);
            const { questionId, answerType, choice, verified, issueNote, freeText } = parsed;
            if (!questionId || !answerType) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "questionId and answerType required" }));
            }
            // Validate questionId — same rule as decisionId
            if (typeof questionId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(questionId)) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "invalid questionId format" }));
            }
            if (!["choice", "verification", "freeText"].includes(answerType)) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "invalid answerType" }));
            }
            // Per-type field validation. Exactly one payload field per type.
            if (answerType === "choice") {
              if (typeof choice !== "string" || choice.length === 0 || choice.length > 4096) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: "choice must be 1-4096 char string" }));
              }
            } else if (answerType === "verification") {
              if (typeof verified !== "boolean") {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: "verified must be boolean" }));
              }
              if (verified === false && issueNote != null && (typeof issueNote !== "string" || issueNote.length > 4096)) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: "issueNote must be 0-4096 char string when present" }));
              }
            } else if (answerType === "freeText") {
              if (typeof freeText !== "string" || freeText.length === 0 || freeText.length > 4096) {
                res.statusCode = 400;
                return res.end(JSON.stringify({ error: "freeText must be 1-4096 char string" }));
              }
            }
            const answersPath = normalize(join(chroniclesRoot, "tickets", "owner_answers.ndjson"));
            const entry = {
              questionId,
              answeredAt: new Date().toISOString(),
              answeredBy: "AllByte",
              answerType,
              choice: answerType === "choice" ? choice : null,
              verified: answerType === "verification" ? verified : null,
              issueNote: answerType === "verification" && verified === false ? (issueNote ?? null) : null,
              freeText: answerType === "freeText" ? freeText : null,
            };
            appendFileSync(answersPath, JSON.stringify(entry) + "\n");

            res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ ok: true, questionId, answerType }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ error: String(err?.message ?? err) }));
          }
        });
      });
    },
  };
}

// Shared SSE client set + broadcast. Used by both testDataEvents (Chronicles
// file changes) and godotReload (public/godot/ deploy detection). Hoisted to
// module scope so both plugins can push to connected browsers.
const sseClients = new Set();
function sseBroadcast(relPath) {
  const payload = JSON.stringify({ path: relPath, at: Date.now() });
  const msg = `event: change\ndata: ${payload}\n\n`;
  for (const res of sseClients) {
    try { res.write(msg); } catch {}
  }
}

// Dev-only SSE endpoint pushing file-change events from the Chronicles repo
// to connected browsers, so the dashboard updates within ~200ms of Arc's daemon
// mutating state instead of waiting for the next 5s poll. Polling remains as
// fallback if the SSE connection drops.
function testDataEvents() {
  // Files we broadcast. Everything else in Chronicles is ignored to keep the
  // event stream quiet and the subscriber surface small.
  const WATCHED_RELS = [
    ".beads/issues.jsonl",
    "tickets/owner_questions.json",
    "tickets/owner_answers.ndjson",
    "tickets/.answer_daemon_heartbeat.json",
    "test_index.json",
    "test_roadmap.json",
  ];

  // Debounce map: relPath -> timer. fs.watch fires multiple events per write
  // (rename + change on atomic replace). Coalesce to one broadcast per ~50ms.
  const pending = new Map();

  function scheduleBroadcast(relPath) {
    if (pending.has(relPath)) return;
    const t = setTimeout(() => {
      pending.delete(relPath);
      sseBroadcast(relPath);
    }, 50);
    pending.set(relPath, t);
  }

  function startWatchers() {
    const dirs = new Map(); // dir -> Set<basename we care about>
    for (const rel of WATCHED_RELS) {
      const full = normalize(join(chroniclesRoot, rel));
      const dir = full.substring(0, full.lastIndexOf(sep));
      const base = full.substring(full.lastIndexOf(sep) + 1);
      if (!dirs.has(dir)) dirs.set(dir, new Set());
      dirs.get(dir).add(base);
    }
    for (const [dir, bases] of dirs) {
      if (!existsSync(dir)) continue; // Chronicles not present, skip silently
      try {
        fsWatch(dir, { persistent: false }, (_event, filename) => {
          if (!filename) return;
          if (!bases.has(filename)) return;
          const relPath = relative(chroniclesRoot, join(dir, filename)).replace(/\\/g, "/");
          scheduleBroadcast(relPath);
        });
      } catch {
        // fs.watch can fail on some mounts; fall through — clients still poll.
      }
    }
  }

  let watchersStarted = false;

  return {
    name: "allbyte-test-data-events",
    configureServer(server) {
      server.middlewares.use("/test-data-events", (req, res, next) => {
        if (req.method !== "GET") return next();
        if (!watchersStarted) {
          watchersStarted = true;
          startWatchers();
        }
        res.setHeader("Content-Type", "text/event-stream");
        res.setHeader("Cache-Control", "no-store, no-transform");
        res.setHeader("Connection", "keep-alive");
        res.setHeader("X-Accel-Buffering", "no");
        res.flushHeaders?.();
        res.write(`event: ready\ndata: {}\n\n`);
        sseClients.add(res);
        // Heartbeat every 15s so proxies / browsers don't close idle connections
        const hb = setInterval(() => {
          try { res.write(`event: ping\ndata: {}\n\n`); } catch {}
        }, 15000);
        req.on("close", () => {
          clearInterval(hb);
          sseClients.delete(res);
        });
      });
    },
  };
}

// Dev-only: watch public/godot/** and push a full-reload to connected clients
// when Arc's redeploy_web.sh finishes syncing. Debounced so one deploy (~8
// files copied in quick succession) produces one reload, not eight.
// awaitWriteFinish guards against partial reads of the large index.pck file.
function godotReload() {
  return {
    name: "allbyte-godot-reload",
    configureServer(server) {
      let timer = null;
      let changed = 0;
      const godotDir = resolve("public/godot");
      console.log(`[godot-reload] watching ${godotDir}`);
      const watcher = chokidar.watch(godotDir, {
        ignoreInitial: true,
        usePolling: true,
        interval: 500,
        awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
      });
      const trigger = () => {
        console.log(`[godot-reload] reload iframe (${changed} file(s))`);
        sseBroadcast("godot/reload");
        changed = 0;
      };
      watcher.on("all", () => {
        changed++;
        clearTimeout(timer);
        timer = setTimeout(trigger, 250);
      });
      server.httpServer?.once("close", () => watcher.close());
    },
  };
}

export default defineConfig({
  integrations: [svelte()],
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss(), decisionWriteback(), ownerAnswerWriteback(), testDataEvents(), godotReload(), chroniclesProxy(), captureLocalProxy(), marketingPublish(), captionDrafter()],
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "credentialless",
      },
      watch: {
        // Exclude public/godot/ from Vite's built-in watcher. Without this,
        // Vite detects changes to public/ and does a full program reload
        // (tearing down HMR) before our godot-reload plugin can send its
        // custom iframe-only reload event.
        ignored: ["**/public/godot/**"],
      },
      // Dev-only proxy: forwards /tempo-api/* to http://localhost:3200/api/*.
      // Tempo's HTTP query API has no built-in CORS, so the InFlightApp svelte
      // component fetches through this proxy instead of hitting Tempo directly.
      // In prod (allbyte.studio) this proxy doesn't exist; fetches 404 and the
      // in-flight UI silently shows empty — the desired behavior since Tempo
      // is bound 127.0.0.1-only and never reachable from the public site.
      //
      // Subtle: Astro's `trailingSlash: "always"` only routes through this
      // proxy when the request path itself carries a trailing slash before the
      // query string (e.g. /tempo-api/search/?tags=...). Tempo, however,
      // returns 404 for /api/search/ — it expects /api/search. So we strip
      // the trailing slash before forwarding. The InFlightApp client must
      // request paths in /tempo-api/<endpoint>/ form.
      proxy: {
        "/tempo-api": {
          target: "http://localhost:3200",
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/tempo-api/, "/api").replace(/\/(\?|$)/, "$1"),
        },
      },
    },
  },
});
