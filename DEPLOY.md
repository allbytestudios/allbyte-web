# Game-build deploy system

How Godot web builds reach `s3://allbyte.studio-site/godot/*`. Owner + App-Claude
maintained. (Site content deploys separately via GitHub Actions on push to `main`;
this doc is only the **game** builds Arc produces.)

## Channels

Five build "channels", each a path under `/godot/`. Availability is published at
**runtime** via `/godot/channels.json` — no source commit flips a build live.

| id | path | min tier | lane |
|----|------|----------|------|
| `alpha` | `/godot/public/` | default (everyone) | live — full deploy |
| `alpha-debug` | `/godot/` | legend | live |
| `beta` | `/godot/beta/` | initiate | live |
| `beta-debug` | `/godot/beta-debug/` | legend | dev — fast lane |
| `develop` | `/godot/develop/` | legend | dev — fast lane, **auto every build** |

Source of truth for the id→path/tier map: `src/lib/gameVersions.ts`.
`develop`/`beta-debug` are **dev channels** (deploy freely). `alpha`/`alpha-debug`/`beta`
are **live** and require an explicit `--promote` — the auto lane never passes it, so it
physically cannot clobber the live game.

## `scripts/push-channel.js` — the one deployer

`node scripts/push-channel.js --manifest <path> [--promote] [--dry-run]`

Reads a `build_manifest.json` (`channel`, `version`, `git_sha`, `test_gate`,
`mixed_build`, base + packs with `sha256`). Then:
1. **Refuses** if `test_gate != "pass"` or `mixed_build === true`.
2. **Verifies sha256** of the base pck + every pack against disk (refuses on drift).
3. **Obfuscates** the base build (`obfuscate-godot-export.js`) — masks the Godot
   script-encryption key in the WASM + injects the un-masking shim. Idempotent.
   **Self-heals** the stale-shim case (game pipeline obfuscated then re-exported,
   orphaning the shim): deletes the shim and re-obfuscates using the key from the
   host env. Any other obfuscator refusal aborts.
4. Cache-bust assert (`.wasm?v=` in index.js), shim/HTML consistency gate.
5. Gzip-uploads the WASM; `s3 sync` base + packs → `godot/<channel>/`.
6. Merges this channel into `godot/channels.json` (GET-modify-PUT) — **self-publishes
   availability, no commit**.
7. Invalidates `/godot/<channel>/*` + `/godot/channels.json`. Live channels also stamp
   `sw.js` and run `smoke_prod.py`.

Dev channels deploy without `--promote`; live channels refuse without it.
`SKIP_GODOT_OBFUSCATION=1` ships the base verbatim (debugging only).

## `scripts/deploy-watcher.js` — the host daemon

Arc's game container has no aws creds; this host does. The watcher bridges them.

- Polls `<Chronicles>/WebBootstrap/export/*/DEPLOY_READY` every 5s (Arc drops it after
  a gated build).
- For **dev** channels (develop/beta-debug): runs `push-channel.js`. On success deletes
  `DEPLOY_READY` (Arc's ack). On failure writes `DEPLOY_FAILED` + leaves `DEPLOY_READY`.
- For **live** channels: writes `DEPLOY_NEEDS_PROMOTE` and leaves it — never auto-promotes.
- Single-instance **lock** (`.tmp/deploy-watcher.lock`); won't retry a build whose
  `DEPLOY_FAILED` is newer than its `DEPLOY_READY`.
- `--once` = single scan; `--log <path>` = also append to a file.

**Runs as a daemon** via `Startup\AllByteDeployWatcher.vbs` (launches hidden at logon).
- Check alive: `Get-Process node` + `.tmp/deploy-watcher.lock` (holds the PID) + tail
  `.tmp/deploy-watcher.log`.
- Stop: kill that PID (lock auto-releases). Disable autostart: delete the Startup `.vbs`.
- Start manually: `npm run deploy-watcher` (or run the Startup `.vbs`).

## Runbook

| Symptom | Cause | Fix |
|---|---|---|
| `sha256 mismatch for pack X` | torn/in-flux build — a pack changed after the manifest | not ours; wait for a clean rebuild + fresh `DEPLOY_READY`. Watcher retries automatically. |
| `mixed_build:true` refusal | build flagged inconsistent upstream | wait for a clean build. |
| obfuscator `stale shim` and it did NOT self-heal | key unavailable | check `GODOT_RELEASE_SCRIPT_KEY` in `docker/.env` (game key). |
| `test_gate != pass` refusal | gate failed on Arc's side | fix the game/tests; not a deploy issue. |
| `DEPLOY_NEEDS_PROMOTE` appeared | a live channel build was staged | promote deliberately: `node scripts/push-channel.js --manifest <p> --promote`. |
| prod `develop` behind local build | daemon down, or last build failed | check daemon (above); if `DEPLOY_FAILED` present, it's a bad build — wait for the next, or delete `DEPLOY_FAILED` to retry. |
| nothing deploying | no `DEPLOY_READY`, or daemon not running | confirm Arc drops `DEPLOY_READY`; confirm the daemon PID/log. |

## Manual ops

```bash
# dry-run any channel (plans everything, uploads nothing)
node scripts/push-channel.js --manifest <path> --dry-run
# deliberately promote a live channel
node scripts/push-channel.js --manifest <path> --promote
# what's live right now
curl -s https://allbyte.studio/godot/channels.json
```

## Cloud path (planned — supersedes the watcher for `develop`)

`infrastructure/godot-export-codebuild.yaml` moves the `develop` build+deploy to AWS
CodeBuild (build from source, IAM role, key from Secrets Manager) — no host daemon, no
creds off the laptop. Held until Arc confirms a hermetic build (bead `yp5`). Spec:
`Desktop/GameDev/APP_CLAUDE_CLOUD_EXPORTER_SPEC.md`. When it lands, the watcher stays as
the `beta-debug` fast lane / fallback.
