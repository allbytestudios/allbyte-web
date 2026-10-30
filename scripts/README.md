# scripts/

Two very different things live here, and the difference matters if you are
reading this repo as a reference.

**The toolkit** is written to work against *any* Godot project and is the part
worth copying. **The studio plumbing** is wired to AllByte's own accounts, its
private game repo, and its agents — it is kept in the open so the pipeline reads
end-to-end, but it will not run for you and is not meant to.

Shared helpers used by several of these live in [`lib/`](lib/).

## The toolkit — reusable for any Godot web build

| Script | What it does |
|---|---|
| `obfuscate-godot-export.js` | Per-release obfuscation of the Godot 4 web export's script-encryption key. The key ships as 32 contiguous bytes inside `index.wasm`; this XORs that slot with a random per-release mask and injects a shim that reverses it at load. Idempotent, and hard-aborts rather than shipping an inconsistent build. The flagship. |
| `verify-pck-encryption.js` | Catches the mixed-key / corrupt-encryption export bug before it reaches players. |
| `push-channel.js` | The one deployer: verifies the build manifest, obfuscates, gzip-uploads the WASM, syncs to the CDN, merges the channel index, invalidates. |
| `verify-deploy.mjs` | Post-deploy verification — version coherence, cross-origin isolation headers, player pages respond. Fast, no browser. |
| `smoke_prod.py` | Boots the deployed game in a headless browser and checks it reaches the title screen without encryption errors. |
| `inject-sw-version.js` | Build step: stamps the real build version into the service worker, so its cache key can never drift from what shipped. |
| `migrate_g3_to_g4_tscn.py` | Godot 3 → 4 scene migration, open-sourced from this game's own port. |
| `spritesheet-to-gif.py` | Sprite sheet → animated GIF. |
| `gate-beta-behavior.js` | Configures a CDN behaviour for signed-cookie gated content. |
| `check-imports-tracked.mjs` | Guard: fails the build if a source file imports something that is not committed. |
| `finalize-web-deploy.js`, `finalize-channel.js`, `promote.js` | The promote path: stamp the deployed version, regenerate the changelog, keep the service worker in step. |
| `push-assets.js`, `push-packs.js` | Upload build output and zone packs to their respective buckets. |
| `stamp-manual.js` | Build step: stamps a version/date placeholder in generated HTML. |

Start with [`../docs/BRING_YOUR_OWN_GAME.md`](../docs/BRING_YOUR_OWN_GAME.md),
which walks the toolkit against your own project.

## Studio plumbing — specific to this studio

Not reusable. These assume AllByte's AWS accounts, its private game repository,
or its agent workflow, and most will exit immediately without them.

- **Content sync from the private game repo** — `sync-assets.js`,
  `sync-manual.js`, `sync-dialogue.js`, `sync-walkthrough.js`,
  `sync-walkthrough-edits.js`, `sync-save-tree.js`, `sync-scenario-fixtures.js`,
  `sync-test-data-watcher.js`, `sync-gate-to-mount.js`,
  `remark-walkthrough-directives.mjs`
- **Manual authoring** — `manual-editor.js`, `manual-paired-edit.py`,
  `check-manual-drift.js`
- **Release orchestration** — `publish-dev-build.js`,
  `publish-deploy-manifest.js`, `promote-artifact.mjs`, `promote-prod.mjs`,
  `deploy-tree.js`, `trigger-queue.mjs`, `staging_deploy.sh`,
  `deploy-history.js`
- **Analytics and QA hygiene** — `play-report.py`, `dash-normalize.js`,
  `claude-usage.js`, `mark-internal-accounts.py`, `mark-owner-sessions.py`,
  `gen-datacenter-ranges.py`, `aggregate_qa_results.py`, `qa_channel_smoke.py`
- **Capture and marketing** — `capture_pitch_screenshots.py`,
  `sync-marketing-posts.mjs`, `push-marketing-strategy.js`
- **Local dev environment** — `copilot2_watchdog.py`

`push-marketing-strategy.js` is worth a look even though you cannot run it: it
is the public/private boundary expressed in code, explaining why a private
artifact goes to a locked bucket rather than the world-readable one.

## Retired — do not run

- `deploy-watcher.js` — superseded by the CI deploy path in 2026-07. Kept for
  reference only.
