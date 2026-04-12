---
title: "A File Watcher, Because I Couldn't Think of Anything Better"
description: "A local daemon that pushes Chronicles test data to prod on file change — and why every cleaner option fell apart."
pubDate: 2026-04-11
category: engineering
devlog: studio
tags: ["infrastructure", "aws", "node", "automation"]
draft: true
---

> This post assumes you've read the one about the private Test Suite dashboard. I haven't written that one yet, so consider this a draft parked behind the admin gate until it has something to point at.

## The problem

Two repos. Two git identities.

- **ChroniclesOfNesis** — the game, private, pushed with my personal GitHub account.
- **allbyte-web** — this site, public, pushed with the `allbytestudios` account.

The game writes test results to `ChroniclesOfNesis/test_results/test_run_status.json` plus `test_index.json` and `test_roadmap.json` at the repo root. The web app reads those files and paints a dashboard on `/test/`. In dev that's free: a Vite middleware serves them directly from disk. In prod they live at `s3://allbyte.studio-site/test-snapshot/`, uploaded by `scripts/push-assets.js` during a normal web deploy.

Which means: the only way to refresh prod test data is to push the web repo. Every time I ran tests on the game, prod stayed stale until I found an excuse to ship the site again. And I wanted to see test progress from my phone while I was away from the desk — which is the entire reason the dashboard exists.

Easy fix, right? Wrong. Every clean option broke on a different constraint.

## The options I ruled out

**Git hook on the game repo.** A `post-commit` in Chronicles could push the three files straight to S3. But `git/config` on that repo is tied to my personal identity, the AWS credentials on my machine are tied to the Allbyte account, and I do not want the game repo to know anything about the web app's bucket. Cross-contamination waiting to happen.

**Git hook on the web repo.** Can't: the trigger lives in the wrong repo. The web repo has no idea the game ran tests.

**A scheduled GitHub Action polling S3.** Runners can't see my laptop. The test files only exist on my local disk.

**A scheduled GitHub Action that runs the game's test suite in CI.** The game is a Godot 3.5 project with a private asset pipeline. Setting up headless Godot in a GitHub runner for the sake of this is a week of yak-shaving for a problem I could solve in an afternoon.

**Cloud-side polling.** Same problem: nothing in the cloud can see my laptop.

**Commit the test files into the web repo via a cross-repo git hook.** Now I'm writing a script that talks to two git identities. Nope.

**Just remember to run `npm run push-assets` after every test run.** I forget. Every time. And it syncs far more than I want.

What kept surviving the cut was a dumb, local, long-running daemon: watch three files, push to S3 on change, stay out of git entirely.

## The daemon

`scripts/sync-test-data-watcher.js`. Pure Node, no new dependencies. It:

1. `fs.watch`es the three game files.
2. Debounces changes with a 2-second window (atomic writes fire `change` + `rename`; I don't want to trigger two syncs for the same save).
3. Shells out to `aws s3 cp` / `aws s3 sync` to push to `test-snapshot/`.
4. Trips a circuit breaker after three consecutive failures and pauses uploads for 60 seconds so a dead VPN connection doesn't burn my request quota.
5. Writes a heartbeat file to S3 every 60 seconds so the dashboard can tell the watcher is alive.

The first four I had before I started writing this post. The fifth I added *while* writing this post, because Claude asked "do we actually see the watcher running?" and the honest answer was "no — if it dies silently, prod goes stale and I find out hours later when I look at my phone and the numbers haven't moved."

That's the part worth talking about.

## The silent-death problem

Daemons that do nothing are indistinguishable from daemons that are broken. The whole pitch of the watcher is "you don't have to think about it." Which means the whole failure mode is "you stopped thinking about it and it stopped working."

The fix is cheap: along with every successful sync, the watcher also uploads `test-snapshot/heartbeat.json`:

```json
{
  "schema_version": 1,
  "written_at": "2026-04-11T22:44:00Z",
  "started_at": "2026-04-11T18:00:00Z",
  "last_sync_at": "2026-04-11T22:43:58Z",
  "last_sync_ok": true,
  "last_change_at": "2026-04-11T22:43:56Z",
  "consecutive_failures": 0,
  "host": "drew-desktop",
  "pid": 12872
}
```

It refreshes every 60 seconds regardless of whether any files changed. That way "no tests ran in the last hour" is still observable — an idle, living watcher keeps stamping a fresh `written_at`.

The dashboard fetches `heartbeat.json` every 45 seconds and renders a status pill next to the test counts:

- **live · 12s ago** — cyan, gently pulsing. Heartbeat written in the last three minutes.
- **stale · 5m ago** — amber. Either a missed beat, or `last_sync_ok` is false.
- **offline** — red. Heartbeat older than ten minutes, or missing entirely.

A red banner also drops in above the columns when the pill goes amber or red, because a tiny corner pill is easy to miss and stale numbers are easy to trust.

The thresholds are numbers I might regret (3 minutes is short, 10 minutes is long), but they're in one place and easy to change.

## Things that went sideways

**Windows `import.meta.url`.** I wanted the script to run normally as `node scripts/sync-test-data-watcher.js` but also be importable so tests could exercise the pure helpers. The standard idiom is `import.meta.url === \`file://${process.argv[1]}\``. On Windows that comparison is `file:///C:/...` (three slashes, forward slashes) vs `file://C:\Users\...` (two slashes, backslashes). Nothing matched; `main()` never ran. Fix was `pathToFileURL(process.argv[1]).href`, which produces the same shape Node uses for `import.meta.url`.

**fs.watch fires twice.** Most editors do atomic writes: write to a temp file, rename over the target. `fs.watch` reports one `change` and one `rename` for every save. The 2-second debounce collapses those back into a single sync.

**Self-tests without a framework.** I didn't want to add a runner for six functions, so there's an inline `--self-test` mode with a tiny `t(label, fn)` that catches exceptions and prints a check or an X. Eleven tests covering `buildSyncCommands`, `makeDebouncer`, `makeCircuitBreaker`, `buildHeartbeat`, `checkSanity`. Runs in well under a second. Good enough.

## What I didn't build

- **A service wrapper.** This is a `node scripts/sync-test-data-watcher.js` in a terminal that I start in the morning and stop when I shut down. If I start rebooting more often than once a day I'll wrap it in NSSM, but for now a terminal window is fine.
- **Alerting.** The heartbeat is passive — I notice the warning banner when I open the dashboard. If this were a real service I'd want it paging me when the beat goes stale, but "Drew checks his phone" is an alerting system too.
- **A push channel back to the game.** I considered having the watcher emit websocket events to the dashboard so the dashboard could refresh in real time. It already polls every 500ms during an active run, so the cost of adding a second delivery mechanism wasn't worth it.

## The lesson, maybe

There's a whole class of problems that look distributed but are really "I have one computer and I want it to do something." Git hooks, CI runners, cloud schedulers, pub/sub buses — they all feel like the right shape because the problem *feels* like integration between systems. But when the data never leaves my laptop in the first place, a long-running local process is the right answer, and the only real engineering is making sure it doesn't die without telling you.

The heartbeat is the whole trick. Everything else is plumbing.
