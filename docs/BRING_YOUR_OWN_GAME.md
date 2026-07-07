# Bring your own game

What you'd need to know to reuse this webapp + deploy pipeline with a
**different Godot web export**. This is a coupling-point inventory and gotcha
list, not a turnkey product — there's no config file that swaps studios yet.
(That productized version — a CLI + addon + template — is a planned
post-Chronicles project; this doc is its raw material.)

The one-sentence mental model: **the webapp is a static Astro site that mounts
your Godot web export in a cross-origin-isolated iframe, caches it with a
version-keyed service worker, and deploys builds to path-based "channels" on a
CDN with availability published at runtime.**

## What generalizes as-is

- **The channel model** (`scripts/push-channel.js` + `/godot/channels.json`):
  path-per-channel, runtime availability, dev vs live lanes, `--promote`
  safety. Nothing AllByte-specific except the path names.
- **The deploy gates**: manifest `test_gate`/`mixed_build` refusal, per-file
  sha256 verification, the obfuscator's idempotence/self-heal rules.
- **The verification pattern** (`scripts/smoke_prod.py`): boot the deployed
  bytes headless, poll a window-level `gameState` hook, scan captured console
  logs for engine failure signatures. You'd swap the hook names and suspect
  patterns for your game's.
- **The service-worker strategy** (`public/sw.js`): version-keyed cache name,
  cache-first only for self-versioned (`?v=`) or immutable `.wasm`/`.pck`
  requests, network-first for everything else under the game path.

## Coupling points you must change

| What | Where | Notes |
|------|-------|-------|
| Site + API domains | `src/lib/auth.svelte.ts` (`API`), `src/lib/betaGate.ts`, `src/lib/playAnalytics.ts`, `scripts/smoke_prod.py`, `tests/cross-browser-qa/run.py`, CORS lists in `infrastructure/stripe-backend.yaml` | `allbyte.studio` / `api.allbyte.studio` are hardcoded in ~6 places. Grep for both. |
| S3 bucket + CloudFront distribution | `scripts/push-channel.js` (`AWS_S3_BUCKET`, `AWS_CLOUDFRONT_DISTRIBUTION_ID` env overrides exist), `scripts/gate-beta-behavior.js`, `.github/workflows/*` secrets | The env overrides mean scripts mostly work unchanged; CI needs your OIDC role + bucket secrets. |
| Channel map | `src/lib/gameVersions.ts` (`GAME_VERSIONS`) | **The** source of truth — ids, labels, paths, tiers. `push-channel.js`, `smoke_prod.py`, and the QA harness all parse this file (same regex), so one edit propagates. |
| Game repo location | `CHRONICLES_DIR` / `EXPORT_ROOT` env vars (`astro.config.mjs`, `scripts/deploy-watcher.js`, `scripts/promote.js`, sync scripts) | Defaults point at the Chronicles repo on the owner's machine; all overridable via env. |
| Tier/auth system | `src/lib/tier.ts`, `src/lib/auth.svelte.ts`, the Lambda stack | Channels gate on subscription tiers (`default/initiate/hero/legend/admin`). No auth? Set every channel `minTier: "default"` and skip the whole backend. |
| Game↔page contract | `src/components/GodotEmbed.svelte`, `src/lib/saves.svelte.ts` | The page reads `window.gameState` (scene, version) from the iframe and speaks a postMessage protocol for saves/fixtures/exit. Your game must expose equivalents or you strip those features. |
| Encryption key handling | `GODOT_RELEASE_SCRIPT_KEY` env (or Secrets Manager in the cloud path) | Only needed if you compile a script-encryption key into your export. Without one, the obfuscator skips cleanly (dev channels) or you ship unencrypted. |
| Version stamping | `src/data/game-version.json` + `scripts/inject-sw-version.js` + `scripts/finalize-web-deploy.js` | The SW cache name keys on this committed file. If you replace the version source, keep the invariant: **the committed version must match the deployed live build**, or returning users hang on stale caches. |

## Things to watch out for (earned the hard way)

1. **COOP/COEP or nothing.** Godot 4 web exports need `SharedArrayBuffer`,
   which needs `Cross-Origin-Opener-Policy: same-origin` +
   `Cross-Origin-Embedder-Policy: require-corp` on the pages AND the game
   assets. Here they come from a CloudFront response-headers policy scoped to
   `/play` + `/godot` (dev parity via `src/middleware.js`). Miss this and you
   get a silent black screen. Corollary: everything the game page embeds must
   be same-origin or send `Cross-Origin-Resource-Policy`.
2. **The service worker will serve you a corpse.** Any mismatch between cached
   wasm/pck and a fresh index.html hangs the engine (MD5 errors at best,
   silent loop at worst). Every cache rule in `public/sw.js` exists because of
   a specific incident — read its comments before "simplifying" it, and keep
   the boot watchdog (`GodotEmbed.svelte`) that self-heals a wedged cache.
3. **Your export must `?v=`-version its asset fetches** (Godot's
   `GODOT_CONFIG` does this when the export pipeline stamps it). Unversioned
   pck fetches pin stale in any cache-first layer — push-channel warns when it
   sees one.
4. **CDN error rewrites lie to your tooling.** This distribution maps 403/404
   → `/index.html` with HTTP 200 (SPA convention), so "did my gated channel
   leak?" can never be answered by status code — the smoke body-sniffs for
   engine markers instead. Yours will have the same class of problem.
5. **A client-side tier check is a menu, not a lock.** Anything paid must be
   gated server-side: private bucket + presigned URLs for packs, CloudFront
   signed cookies (trusted key groups) for whole paths. See the Content
   gating section of `DEPLOY.md`.
6. **Key obfuscation is a raised bar, not a wall.** The XOR-shim protects the
   script-encryption key from static WASM scanners; a determined attacker with
   a live browser can still dump it. Decide what that's worth for your game.
7. **Deploy markers beat deploy dashboards for a solo pipeline.** The
   file-marker protocol (`DEPLOY_READY` → deploy → delete, or `DEPLOY_FAILED`
   / `DEPLOY_NEEDS_PROMOTE`) is trivially debuggable and needs no
   infrastructure. Start there; add CloudWatch when something actually pages
   you.

## What you'd leave behind

Chronicles-specific and safe to delete: the scenario launcher
(`src/lib/scenarios.ts`), save-fixture tooling, the Dev Console's ticket/test
views (`src/pages/test/`), marketing pipeline, music player, and all
`src/content/` prose. The play surface (`/play`), SW, deploy scripts, and QA
harnesses are the reusable core.
