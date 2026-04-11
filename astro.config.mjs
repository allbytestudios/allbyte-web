import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";
import { createReadStream, existsSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";

// Dev-only proxy: serves /test-data/* from the Chronicles repo so the local
// test dashboard can read test_index.json, test_run_status.json, screenshots,
// and event streams live without copying. In prod the dashboard reads from
// /test-snapshot/* baked into public/ instead.
function testDataProxy() {
  const chroniclesRoot = resolve(
    process.env.CHRONICLES_DIR ||
      "C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis"
  );
  return {
    name: "allbyte-test-data-proxy",
    configureServer(server) {
      server.middlewares.use("/test-data", (req, res, next) => {
        try {
          const url = new URL(req.url || "/", "http://localhost");
          const rel = decodeURIComponent(url.pathname).replace(/^\/+/, "");
          const full = normalize(join(chroniclesRoot, rel));
          if (!full.startsWith(chroniclesRoot + sep) && full !== chroniclesRoot) {
            res.statusCode = 400;
            return res.end("bad path");
          }
          if (!existsSync(full) || !statSync(full).isFile()) {
            res.statusCode = 404;
            return res.end("not found");
          }
          res.setHeader("Cache-Control", "no-store");
          if (full.endsWith(".json")) {
            res.setHeader("Content-Type", "application/json; charset=utf-8");
          } else if (full.endsWith(".ndjson")) {
            res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
          } else if (full.endsWith(".png")) {
            res.setHeader("Content-Type", "image/png");
          } else if (full.endsWith(".jpg") || full.endsWith(".jpeg")) {
            res.setHeader("Content-Type", "image/jpeg");
          } else if (full.endsWith(".webm")) {
            res.setHeader("Content-Type", "video/webm");
          } else if (full.endsWith(".log") || full.endsWith(".txt")) {
            res.setHeader("Content-Type", "text/plain; charset=utf-8");
          }
          createReadStream(full).pipe(res);
        } catch (err) {
          res.statusCode = 500;
          res.end(String(err && err.message ? err.message : err));
        }
      });
    },
  };
}

export default defineConfig({
  integrations: [svelte()],
  trailingSlash: "always",
  vite: {
    plugins: [tailwindcss(), testDataProxy()],
    server: {
      headers: {
        "Cross-Origin-Opener-Policy": "same-origin",
        "Cross-Origin-Embedder-Policy": "require-corp",
      },
    },
  },
});
