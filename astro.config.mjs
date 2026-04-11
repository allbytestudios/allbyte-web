import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

// Dev-only proxy: serves /test-data/* AND /godot/* live from the Chronicles
// repo so neither the test dashboard nor the playable Godot demo need a manual
// copy step when CON Claude rebuilds. In prod, /test-snapshot/* and /godot/*
// come from the S3 bucket populated by `npm run push-assets`.
function chroniclesProxy() {
  const chroniclesRoot = resolve(
    process.env.CHRONICLES_DIR ||
      "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis"
  );
  // Where Godot's HTML5 export lands inside the Chronicles repo.
  const godotExportRel = "WebBootstrap/export";

  function streamFile(full, res, isGodot) {
    res.setHeader("Cache-Control", "no-store");
    // Godot HTML5 needs the iframe to be cross-origin-isolated for
    // SharedArrayBuffer. Vite's vite.server.headers sets COOP/COEP on
    // responses Vite generates itself; this middleware bypasses that path
    // by piping streams directly, so we set them explicitly here for godot.
    // CORP=same-origin lets the parent (also same-origin) embed safely.
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
          // Fall through so Astro's static handler can still serve a baseline
          // copy from public/ if the live file isn't present.
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
      // /test-data/* — read from Chronicles repo root (test_index.json,
      // test_roadmap.json, test_results/...)
      server.middlewares.use("/test-data", makeProxy("/test-data", "", false));
      // /godot/* — read from Chronicles' WebBootstrap/export so CON's
      // rebuilds appear instantly with no copy step. Sets COOP/COEP/CORP
      // explicitly so the iframe is cross-origin-isolated.
      server.middlewares.use("/godot", makeProxy("/godot", godotExportRel, true));
    },
  };
}

export default defineConfig({
  integrations: [svelte()],
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss(), chroniclesProxy()],
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  },
});
