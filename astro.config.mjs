import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync, statSync, appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

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
        if (!full.startsWith(baseDir + sep) && full !== baseDir) {
          res.statusCode = 400;
          return res.end("bad path");
        }
        if (!existsSync(full) || !statSync(full).isFile()) {
          return next();
        }
        streamFile(full, res, isGodot);
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
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          try {
            const { decisionId, choice } = JSON.parse(body);
            if (!decisionId || !choice) {
              res.statusCode = 400;
              return res.end(JSON.stringify({ error: "decisionId and choice required" }));
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

export default defineConfig({
  integrations: [svelte()],
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss(), decisionWriteback(), chroniclesProxy()],
    server: {
      host: "0.0.0.0",
      allowedHosts: true,
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  },
});
