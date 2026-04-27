import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync, statSync, appendFileSync, readFileSync, writeFileSync, realpathSync, watch as fsWatch } from "node:fs";
import { join, normalize, resolve, sep, relative } from "node:path";
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

            // Mirror choice answers to agent_chat.ndjson so the existing
            // decision-resolved flow keeps working during transition.
            if (answerType === "choice") {
              const chatPath = normalize(join(chroniclesRoot, "tickets", "agent_chat.ndjson"));
              const msg = {
                timestamp: entry.answeredAt,
                from: "Owner",
                to: "Arc",
                channel: "decisions",
                message: `Answer ${questionId}: ${choice}`,
                decision: { id: questionId, choice, status: "resolved", chosenBy: "Owner" },
              };
              try {
                appendFileSync(chatPath, JSON.stringify(msg) + "\n");
              } catch {
                // Mirror is best-effort; primary write already succeeded.
              }
            }

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
    "tickets/owner_questions.json",
    "tickets/tickets.json",
    "tickets/dashboard.json",
    "tickets/epics.json",
    "tickets/agents.json",
    "tickets/agent_activity.json",
    "tickets/agent_chat.ndjson",
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
    plugins: [tailwindcss(), decisionWriteback(), ownerAnswerWriteback(), testDataEvents(), godotReload(), chroniclesProxy()],
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
