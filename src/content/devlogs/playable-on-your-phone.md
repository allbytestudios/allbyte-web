---
title: "Playable on Your Phone, Without an App"
description: "How I turned The Chronicles of Nesis — a desktop-shaped tactical RPG — into something that runs on a phone from a URL, installs to the home screen like a native app, and updates itself without losing your save."
pubDate: 2026-06-02T00:00:00Z
category: "engineering"
devlog: "studio"
tags: ["pwa", "mobile", "godot", "service-worker", "architecture"]
---

The Chronicles of Nesis was always going to be a desktop game. Tactical RPGs live on mouse + keyboard. The Godot project is 1270×920, the UI was built for hover states, the controls assume a precision input. I never set out to make a mobile game.

But there's a difference between "designing for desktop" and "refusing to play on a phone." Two clicks shouldn't be a wall.

So I spent a week — alongside Arc, my game-side coordinator — turning the existing web build into something that:

- Plays on a phone from a URL, no app store
- Installs to your home screen like a native app
- Goes fullscreen + landscape on tap, hides Android system chrome
- Has a virtual gamepad in the letterbox bars (d-pad with diagonals, A/B/X/Y face buttons)
- Auto-updates itself at the title screen — never mid-game, never loses your save

None of the individual pieces are novel. The combination is.

## The architectural split

The cleanest decision was deciding what belongs where.

**Web side owns:** the iframe lifecycle. Auth state, save sync to my backend, the service worker that caches the heavy WASM + PCK files. The virtual gamepad — because the game has no touch-input system. Translating each touch into a synthetic `KeyboardEvent` the engine already knows what to do with.

**Game side owns:** everything inside the iframe. Title screen, menus, save UI, quit button, in-game UI for downloading future content. When the user is "in the game," the web side is just a transport layer.

This split matters because the temptation was always to put more on the web side. Need a Quit button? Easy, add it to the HTML chrome above the iframe. Need a Save/Load UI? Same. But every piece of chrome I added on top of the iframe was 52 pixels of screen the game lost — and on a phone in landscape, 52 pixels is a lot.

So I eventually pulled all of it back into the game. The web side is now the platform; the game owns its own visible behavior. The iframe gets 100% of the viewport.

## The virtual gamepad

The first instinct was a d-pad made of four `<button>` elements arranged in a cross. Tap up, tap right, etc. It worked, but felt wrong. You couldn't hold up-right for a diagonal — only one button gets the touch at a time. You couldn't slide your thumb from left to up without lifting first. It felt like a calculator pretending to be a controller.

The fix was abandoning the buttons-as-buttons model entirely. The d-pad is now **one touch zone with eight directional sectors**. A finger anywhere in the zone resolves to a direction by `atan2(-dy, dx)`. Sliding the finger transitions cleanly between sectors. Diagonals fire two adjacent cardinals simultaneously — `up + right` together, like a real D-pad does.

The face buttons (A/B/X/Y) use the same "one zone, multiple positions" model, but exclusive: only one button held at a time. So you can slide your thumb from B to A and the game sees release-of-B → press-of-A in one motion. Equipping a piece of gear and immediately unequipping it works the way you'd expect.

There's also a small bit of polish for menu nav: hold a face button past 400ms and it auto-repeats every 200ms, like a keyboard does. Without it, mashing the same button feels like a debounce bug.

## The PWA install path

You can play in a regular browser tab. But the better experience is installable.

The manifest declares `display: standalone`, `orientation: landscape`, with an apple-touch-icon and a 192×192 + 512×512 icon set. On Chrome desktop or Android, the browser offers an "Install Chronicles of Nesis" button after a couple of visits. I also surface my own "Install as App" link in the social bar — it triggers the same `beforeinstallprompt` flow without making the user dig through browser menus.

Once installed:

- Desktop: opens in its own window, no browser chrome. Behaves like a native app launcher
- Android: home screen icon, launches in standalone mode, system status bar + nav gestures hidden when the user taps Play
- iOS: technically works (PWA support is real on iOS Safari) but the install flow is rougher and orientation lock isn't supported in browser tabs — the manifest's `orientation: landscape` is only honored after the user does "Share → Add to Home Screen." I've left iOS as a future polish pass.

The most important manifest decision was actually *not* setting `display: fullscreen` globally. That seemed like the right answer initially — phones want fullscreen. But desktop installs of a fullscreen-display PWA take over the whole screen on launch, which is wildly uncomfortable for a desktop app. So the manifest is `standalone`, and the JS layer requests fullscreen + locks landscape *only on touch devices*. Desktop users get a windowed app; mobile users get the immersive game.

## Service worker, but with discipline

The naive PWA pattern caches everything aggressively. That's how you get the "install once and use offline" pitch. But aggressive caching also means stale code persists across deploys, which is exactly what users *don't* want for a game that's still iterating.

The service worker here caches `/godot/*` only — the heavy WASM + PCK bytes, around 100MB total. Everything else (the Astro-built website, the API endpoints, the auth flow) goes through normal HTTP cache + revalidation.

The cache invalidation key is tied to the **game version**, not the git commit. Originally I had it derive from `${gameVersion}-${gitShortSha}`, which technically worked but meant every unrelated commit — a typo fix in the homepage, a change to the dev console — invalidated the entire game cache and forced a fresh ~60MB download. After someone (me) complained about that, the SW now uses just the game version. Web-only deploys leave the game cache intact; game deploys correctly invalidate.

There's a subtle correctness concern here. If I deploy a website fix and then immediately bump the game, do users get the new game? Yes — because the next game version bump produces a new `sw.js` (different `BUILD_VERSION` constant), the browser detects it on next page navigation, the new SW activates, and the activate handler purges the old cache. Web-only deploys reach users through normal HTML revalidation (Astro emits `must-revalidate` on HTML, and JS bundles are content-hashed).

## Updates land at the title screen, not mid-game

The bug was easy to predict: every time I shipped a new version, users mid-game got their state reloaded out from under them. The naive auto-update flow had no concept of "is this a safe moment to reload?"

The fix has two halves. The web side, on detecting a new service worker has taken control, posts an `allbyte:update-available` message to the iframe and sets `window.allbyteUpdatePending = true`. It does *not* reload automatically.

The game side, in `Title.gd._ready`, polls `parent.allbyteUpdatePending`. If it's true, it waits one second (so the title screen actually renders before disappearing) and calls `parent.allbyteApplyUpdate()`. That triggers a brief "Updating to the latest version..." overlay and reloads the page.

Result: users who hit a fresh deploy mid-battle keep playing. Their save persists. The next time they reach Title — by quitting to title, dying, finishing a mission, whatever — the update applies invisibly.

This split between "detection" (web) and "application" (game) is the cleanest version of the pattern I've found. The web doesn't need to know what counts as a safe moment; the game does. Each side only does what it can verify it has the right context to do.

## What's slow, and what's next

Cold first load on a phone is still painful: ~37MB WASM download, ~24MB PCK, then ~40MB Laria zone pack, then single-threaded WASM compile on top. Total round trip can be 25–45 seconds on a mid-tier Android device with cold cache.

After that first visit, the service worker makes it sub-second.

The biggest lever I haven't pulled is the **threaded Godot build**. The current export is single-threaded; switching to the threaded template parallelizes WASM compile across cores. Estimated 30–60% faster initial compile on multi-core phones, plus runtime headroom for the game tick. The COOP/COEP infrastructure for that is already in place — it's purely a Godot export preset flip on Arc's side, queued behind the current combat-polish work.

I'm also still owed a proper iOS pass. The PWA install flow works on iOS Safari but the polish — apple-mobile-web-app-status-bar-style, safe-area-insets, fullscreen handling in browser tabs — needs deliberate testing on real devices.

And longer term, when the game grows past the current ~100MB asset budget, PCK splitting by zone (Title → Laria → other zones loaded on demand) keeps the initial download bounded.

## The smaller things that mattered

A few decisions that weren't load-bearing individually but added up:

- A load-status panel sits at the bottom of the play container while the engine boots. It shows the elapsed time, the last few lines of GDScript `print()` output (from a console interceptor inside the iframe), and a real download progress bar driven by `PerformanceObserver` on the iframe's resource entries. When the engine reports it's reached the Title scene, the panel hides. The whole point is the user (or me, debugging) sees *something* happening instead of staring at a black canvas wondering if it crashed.

- The Laria zone pack — about 40MB on its own — used to load only after the "Words on Black" intro scene finished, which created a noticeable pause. Now it kicks off downloading the moment the user hits Save on New Game, in parallel with the intro playing. Same overall time, much less perceived stall.

- The web hosts a `parent.__simulateUpdateAvailable()` debug function. From any iframe console, that one call fakes a service worker activation and exercises the entire update-at-title-screen flow without needing two real deploys. The reload happens, the title comes back, and the version stamp in the corner ticks up. About thirty seconds end to end, instead of waiting for a real CI cycle.

- Quit means different things in different contexts. In a browser tab, "quit" should return to the home page. In an installed PWA, "quit" should close the app window. The same `parent.allbyteRequestExit()` call from GDScript does both — it checks `display-mode: standalone` and routes to the right behavior.

## Why this matters

The pitch is small and concrete: someone shares a link with a friend. The friend clicks it, hits Play In Browser, and they're tapping the title screen on their phone fifteen seconds later. No install gate. No app store. No "where do I find this." Just a URL.

If the friend likes it enough to come back, they tap Install. From that moment on, it lives on their home screen with an icon and a name, opens in landscape, hides the system chrome, syncs their save to the cloud, and updates itself when there's something new. It feels like an app — because functionally, it *is* an app. It just happens to be made of HTML, WASM, and a service worker.

That's the architecture I wanted: low-friction entry, app-quality experience, zero ongoing cost from a platform that gets to decide whether my game is allowed to exist.

Whether anyone clicks the link is a different conversation. But "they tried but it didn't work" should never be the reason they bounced.
