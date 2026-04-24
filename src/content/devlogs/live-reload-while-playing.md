---
title: "Live Reload While Playing: How My Agents Update the Game Without Interrupting My Tests"
description: "Fixes were landing faster than I could restart the game. So I built a live-reload pipeline that lets my AI agents deploy new builds while I'm mid-playtest — preserving my exact game state across each reload."
pubDate: 2026-04-16T18:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["godot", "live-reload", "agents", "workflow", "web-export", "testing"]
draft: true
---

When I'm playtesting Chronicles of Nesis in the browser, I notice things fast. Sprite is in the wrong spot. Menu subpanel isn't showing. Text should be on the far right. I rapid-fire these to Arc — my orchestrator agent — who cuts tickets and routes them to the right lead. Nix fixes the GDScript, Port rebuilds the web export, Arc redeploys. The whole cycle from "that looks wrong" to "fix is built" often takes under two minutes.

The problem was: after every fix, I had to manually refresh, wait for the WASM module to load, navigate back through the title screen, load my save, walk back to where I was, and reproduce the scenario I was testing. A 90-second fix followed by a 60-second manual reload loop. Multiply that by fifteen bugs in a session and I'd spent more time navigating menus than actually testing.

I wanted the game to just *update under me* while I played.

## The constraint

Godot 3.5's HTML5 export runs as a WebAssembly module inside an iframe. WASM can't hot-swap code — there's no mechanism to replace a running module's compiled functions without tearing down the entire instance. Any code update means restarting the engine from scratch.

So "live reload" for a Godot web game doesn't mean what it means for a React app. It means: kill the iframe, boot a fresh engine with the new code, and somehow get back to where you were. The engineering question isn't "can we avoid a restart" — it's "can we make the restart invisible."

## What I already had

My test infrastructure already had pieces of this. The [fixture system](/devlog/test-framework-four-tiers/) lets Vera (my test lead) boot the game into specific states by sending a `postMessage` with a fixture payload. The [save-sync protocol](/devlog/save-sync-without-a-backend/) defines how the game and the web app exchange save data over `postMessage`. The web app already hosted the game in an iframe with full control over its `src` attribute.

What I didn't have: the glue that connects "Arc just deployed new files" to "reload the iframe and restore state."

## Three problems, three layers

### 1. Detecting the deploy

Arc's redeploy script copies ~8 files into `public/godot/` — the `.pck` (game data), `.wasm` (engine binary), `.js` (loader), and supporting assets. The web app needs to notice when these files change.

First attempt: Vite's built-in `public/` directory watcher. It detected changes, but responded by restarting the entire dev server — tearing down the HMR WebSocket, killing the page, and dumping me back to the landing page. Exactly the opposite of what I wanted.

Fix: exclude `public/godot/` from Vite's watcher and run a separate [chokidar](https://github.com/paulmillr/chokidar) watcher with polling enabled (native `fs.watch` doesn't reliably fire on Windows for these write patterns). The watcher debounces changes — one deploy touching 8 files produces one reload event, not eight. The 14MB `.pck` file gets `awaitWriteFinish` protection so we don't try to reload while the file is still being copied.

### 2. Getting the signal to the browser

Second gotcha. The watcher runs server-side in the Vite dev middleware. Getting the signal to the browser tab turned out to be harder than expected.

First attempt: Vite's HMR custom events (`server.ws.send` with a custom event type). The Svelte component listens via `import.meta.hot.on()`. Clean API, well-documented. Didn't work. Turns out Astro's island hydration architecture doesn't reliably deliver custom HMR events to `client:load` components, and Vite 7 renamed the API from `server.ws` to `server.hot` anyway.

What did work: Server-Sent Events. I already had an SSE endpoint (`/test-data-events/`) for the [dev console](/devlog/dev-console-agent-dashboard/) — it pushes file-change notifications from the Chronicles repo to the dashboard for near-instant UI updates. Adding one more broadcast channel (`godot/reload`) to that existing SSE stream took one line on the server and one `subscribeToFile` call on the client. No new transport, no new failure modes, proven working.

### 3. Preserving game state across the reload

This is where the fixture system earned its keep. The iframe reload is unavoidable — WASM restarts. But the game can save its state before dying and restore it after booting.

The handshake:

1. **Before reload**: the web app sends `allbyte:prepare-reload` to the iframe via `postMessage`
2. **Game saves**: the engine writes current state to a reserved `reload_autosave` slot in `localStorage` and sets a `reload_marker` with a timestamp
3. **Game confirms**: the engine sends `allbyte:reload-ready` back
4. **Web app reloads**: swaps the iframe `src` with a cache-busting query string
5. **Game boots**: checks for `reload_marker` — if present and less than 60 seconds old, auto-loads the reload slot instead of showing the title screen

The 2-second timeout on step 3 is a safety valve. If the game is wedged or the Godot-side handler isn't in this build, the reload proceeds anyway — you just lose your position and start from the title screen. Degraded, not broken.

The reload slot is deliberately kept separate from the player's real save slots. It never shows up in the load-game menu, never syncs to the server, and expires after 60 seconds. It exists only for this one purpose.

## What it looks like now

I'm playing the game. I notice the character subpanel isn't rendering correctly. I say to Arc: "Elias subpanel not showing in pause menu." Two minutes later, without touching anything, the game flickers for a moment and I'm standing in the same spot with the fix applied. I open the pause menu — subpanel renders correctly. I keep playing.

Fifteen bugs in a session, fifteen live reloads, zero time spent navigating menus.

## The coordination story

This feature touched three agents and two codebases:

- **App Claude** (web app side): the chokidar watcher, SSE broadcast, iframe reload logic, `postMessage` handshake, and the `onMount` subscription in the landing page component
- **Nix** (Godot side): the `allbyte:prepare-reload` listener, the reserved reload slot, the save-on-demand logic, and the boot-time marker check that auto-loads instead of showing the title screen
- **Arc** (coordination): routing the design conversation, cutting the ticket, spawning Nix, and running the ~10 test deploys it took to get the boot-path restore working correctly

Nobody designed this feature upfront. It emerged from a real pain point during a live playtest session — the fixes were arriving faster than I could restart the game to see them. The whole thing went from "I wish the game would just update" to working in a single session.

## What doesn't work yet

**Mid-battle and mid-dialogue state.** The reload slot uses the existing save system, which only captures world-map state — party, inventory, quest flags, position. If I'm in a battle or a dialogue when a reload hits, I land at the last saveable position. That's Phase 2: extending the TestBridge to capture full ephemeral engine state (battle context, menu stack, dialogue position). It's significant engine work, but the `postMessage` protocol is already in place for when we get there.

**Rapid consecutive reloads.** Two reloads within a few seconds of each other can race — the game hasn't fully re-initialized from the first restore when the second `prepare-reload` arrives. Nix fixed this by re-registering the save listener after restore completes, but very fast back-to-back deploys can still occasionally miss. In practice this doesn't matter — deploys are at least 30 seconds apart.

## The dev loop I wanted

The playtest loop I have now is the one I always wanted:

1. Play the game
2. Notice something wrong
3. Describe it to Arc in plain language
4. Keep playing
5. The fix appears under me

No restarts, no menu navigation, no "hold on let me reload." The agents handle the engineering; I handle the testing. That's the division of labor this whole [multi-agent setup](/devlog/two-claudes-to-five/) was built for.
