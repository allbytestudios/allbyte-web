# Game-build deploy system

How Godot web builds reach `s3://allbyte.studio-site/godot/*`. Owner + App-Claude
maintained. (Site content deploys separately via GitHub Actions on push to `main`;
this doc is only the **game** builds Arc produces.)

## Channels

Five build "channels", each a path under `/godot/`. Availability is published at
**runtime** via `/godot/channels.json` — no source commit flips a build live.

| id | UI label | path | min tier | lane | server-side gate |
|----|----------|------|----------|------|------------------|
| `alpha` | Demo | `/godot/public/` | default (everyone) | live — full deploy | none (free) |
| `alpha-debug` | Demo (Debug) | `/godot/` | legend | live | none (debug chrome only) |
| `beta` | Beta | `/godot/beta/` | initiate | live | **CloudFront signed cookies** (see Content gating) |
| `beta-debug` | Beta (Debug) | `/godot/beta-debug/` | legend | dev — fast lane | none (deliberate — see Content gating) |
| `develop` | Develop (Debug) | `/godot/develop/` | legend | dev — fast lane, **auto every build** | none (deliberate) |

Source of truth for the id→path/tier map: `src/lib/gameVersions.ts`. The ids are
wire contract (manifests, channels.json, S3 paths) and stay `alpha`/`beta`; only
the user-facing **labels** say "Demo". `develop`/`beta-debug` are **dev channels**
(deploy freely). `alpha`/`alpha-debug`/`beta` are **live** and require an explicit
`--promote` — the auto lane never passes it, so it physically cannot clobber the
live game.

## Content gating

Two independent server-side gates protect paid content. Client-side tier checks
(`gameVersions.ts`, the picker) are UI only — never the boundary.

**Zone packs — `GET https://api.allbyte.studio/pck-url?pack=<Name>`** (deployed,
canonical; `infrastructure/pack-gating.yaml` is a superseded design — do not
deploy it). Packs live in the private `allbyte-studio-packs` bucket; the Lambda
presigns 15-min GET URLs. Public packs need no auth; tiered packs verify the JWT
+ tier (per-pack map `PACK_TIER_REQUIREMENTS` inside the Lambda in
`stripe-backend.yaml`). PackLoader.gd gets the endpoint injected via
`window.PACK_AUTH_ENDPOINT`. Stage-throttled (burst 20 / rate 10); the 15-min
TTL is the anti-scrape control.

**Beta base build — CloudFront signed cookies on `/godot/beta/*`.**
`GET https://api.allbyte.studio/game/beta-cookies` (Bearer JWT) re-reads the
caller's tier from the users table (revocation: a stale JWT tier claim doesn't
help a lapsed subscriber) and issues 12h signed cookies scoped to
`Domain=allbyte.studio; Path=/godot/beta`. A CloudFront behavior
(`/godot/beta/*`, TrustedKeyGroups) enforces them at the edge for every asset
fetch. Client half: `src/lib/betaGate.ts` (fetch with credentials, refresh at
~80% TTL); `GodotEmbed` holds the iframe until the grant lands and shows an
upsell message on denial.

**Deliberately ungated:** `beta-debug` + `develop` (Legend/admin debug lanes,
low stakes, no paid content beyond what the pack gate already covers).
Revisit trigger: the day either carries paid content not behind `/pck-url`.

**Custom-error quirk:** the distribution rewrites 403/404 → `/index.html` with
HTTP 200, so an anonymous hit on a gated path gets the site fallback page, not
a raw 403. No game bytes leak, but never verify the gate by status code alone —
use `python scripts/smoke_prod.py --channel beta --locked-only` (body-sniffs
for real game content).

### Enabling the beta gate (owner ritual, one-time)

```bash
# 1. Key ceremony — private key never leaves your machine unencrypted-at-rest.
openssl genrsa -out cf-beta.pem 2048
openssl rsa -pubout -in cf-beta.pem -out cf-beta.pub
aws cloudfront create-public-key --public-key-config \
  Name=allbyte-beta-gate,CallerReference=beta-gate-$(date +%s),EncodedKey="$(cat cf-beta.pub)"
#    → note the public key Id (K...)
aws cloudfront create-key-group --key-group-config \
  Name=allbyte-beta-gate,Items=<PUBLIC_KEY_ID>
#    → note the KeyGroup Id
aws secretsmanager create-secret --name allbyte-studio/cf-beta-signing-key \
  --secret-string file://cf-beta.pem
shred -u cf-beta.pem cf-beta.pub   # or secure-delete equivalents

# 2. Deploy the cookie endpoint (returns 503 until this parameter is set).
aws cloudformation deploy --template-file infrastructure/stripe-backend.yaml \
  --stack-name allbyte-studio-stripe --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides CfBetaKeyPairId=<PUBLIC_KEY_ID>

# 3. Add the edge behavior (dry-run first; snapshots the config to .tmp/).
node scripts/gate-beta-behavior.js                       # plan
node scripts/gate-beta-behavior.js --key-group <KEYGROUP_ID> --apply

# 4. Verify (works before any beta export exists — drop a placeholder
#    index.html at s3://allbyte.studio-site/godot/beta/ if the path is empty):
python scripts/smoke_prod.py --channel beta --locked-only   # anonymous: locked
SMOKE_JWT=<initiate+ token> python scripts/smoke_prod.py --channel beta  # entitled: boots
```

Roll back the behavior with `node scripts/gate-beta-behavior.js --remove --apply`.

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
7. Invalidates `/godot/<channel>/*` + `/godot/channels.json`. Then the
   lane-correct smoke: live alpha pair → full `smoke_prod.py` (sw-version +
   /play embed + public build); live beta → `--channel beta` (anonymous lock
   check + signed-cookie boot, needs `SMOKE_JWT` in the promoting shell); dev
   channels → `--channel <ch> --boot-only` (a failure exits 1 so the watcher
   records `DEPLOY_FAILED`). Live channels also stamp `sw.js`.

Dev channels deploy without `--promote`; live channels refuse without it.
`SKIP_GODOT_OBFUSCATION=1` ships the base verbatim; `SKIP_SMOKE=1` skips the
post-deploy smoke (both debugging only).

CI reruns the per-channel smoke after every site deploy: the `channel-smoke`
job in `.github/workflows/qa.yml` reads the live `channels.json` and boots
every published channel (gated channels get the anonymous lock check only — CI
holds no user tokens). Results land in `test-snapshot/qa-runs/<run-id>/`.

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
| dev deploy shows `DEPLOY_FAILED` but the channel updated | the light post-deploy smoke failed AFTER upload — artifacts are live on the dev path, marker tells Arc the build is bad | read the smoke output in the watcher log; bad build → wait for Arc's next; false alarm → `python scripts/smoke_prod.py --channel <ch> --boot-only` to re-check, then delete the marker. |
| entitled user gets 403 / fallback page on beta | expired cookies (12h TTL), key-pair-id mismatch, or the Lambda can't read the signing secret | re-login → `betaGate` refetches; check `allbyte-studio-beta-cookies` CloudWatch AUDIT lines; confirm `CfBetaKeyPairId` matches the public key in the key group. |
| beta serves REAL game content anonymously | the `/godot/beta/*` behavior lost `TrustedKeyGroups` (or was reordered behind `/godot/*`) | `python scripts/smoke_prod.py --channel beta --locked-only` confirms; re-apply `node scripts/gate-beta-behavior.js --key-group <id> --apply`. This is the alarm case — treat as an incident. |
| `channels.json` lists a dead/retired channel | file is merge-only (each deploy adds; nothing removes) | GET the file, delete the key, PUT it back, invalidate `/godot/channels.json` (the picker drops it live). |
| a dev/beta channel serves stale small files (index.js, worklets) after a deploy | SW cached them under the old cache-first rule | one-time legacy issue: rule is network-first since 2026-07-07; a hard reload (or the boot watchdog) clears it. `.wasm`/`.pck` staleness instead → check the export carries `?v=` (push-channel warns). |

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
