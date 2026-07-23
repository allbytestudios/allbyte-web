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

## How `develop` deploys — git push (token-gated) → CodeBuild (LIVE, hands-off)

`develop` builds and deploys itself **from source** on a git push. There is **no
host daemon** and nothing to run on the laptop.

- **Trigger (TOKEN-GATED, cost fix 2026-07-23):** a push to the `develop` branch
  of the private game repo fires the CodeBuild project `allbyte-godot-develop`
  **only when the HEAD commit message contains `[deploy-develop]`**. Ordinary
  pushes no longer build — develop was auto-building ~14×/day (~$15/mo, the bulk
  of the AWS bill). To deploy, Arc tags the push (`git commit --allow-empty -m
  "[deploy-develop] <what/why>"`) — only when the owner asks. Consequence: the
  deployed `develop` channel reflects the **last tagged deploy, not the branch
  HEAD**. The filter is the `COMMIT_MESSAGE` FilterGroup in
  `deploy/godot-export-codebuild.yaml`; remove it to restore build-on-push.
- **Build (isolated in AWS):** CodeBuild clones the repo via CodeConnections
  (OAuth — no token in the pipeline), installs the custom **key-baked** web export
  template from private S3, then runs `tools/ci/cloud_export.sh` (headless import →
  bootstrap + pack export → Tier-2 gate → `build_manifest.json`).
- **Deploy:** `node /opt/exporter/push-channel.js --manifest <p>` (the same deployer
  described above, baked into the exporter image) → obfuscate → gzip WASM → `s3 sync`
  → merge `channels.json` → invalidate. The build's IAM role can write **only**
  `godot/develop/*` + `channels.json` — it cannot touch live channels or other buckets.
- **Result:** `/godot/develop/` updated, laptop-independent, no creds off AWS. Proven
  to boot + decrypt packs (boot_check).

Infra: `deploy/godot-export-codebuild.yaml` (CodeBuild project + scoped IAM +
webhook + `DevelopBuildFailure` alarm) and `deploy/exporter-image-ci.yaml` +
`.github/workflows/exporter-image.yml` (builds the Godot exporter Docker image → ECR
on Dockerfile/deployer-script change). Encryption key: Secrets Manager
(`allbyte-studio/godot-script-key-*`). Key-baked template: private S3
(`allbyte-studio-cfn-deploy/godot-templates/`). Spec:
`Desktop/GameDev/APP_CLAUDE_CLOUD_EXPORTER_SPEC.md`.

**To ship develop:** Arc commits to `develop` and pushes. Do **not** use the old local
`develop_pipeline.sh` + `DEPLOY_READY` marker lane (see Retired).

### Retired: the host deploy-watcher daemon
`scripts/deploy-watcher.js` + `Startup\AllByteDeployWatcher.vbs` were the **interim
bridge** before the cloud path — they polled Arc's `DEPLOY_READY` markers and ran
`push-channel.js` host-side. **Retired 2026-07-04; do not run it.** The code stays
committed but dormant. If the cloud path is ever down and you must ship develop by
hand, use the break-glass manual push in *Manual ops* — never the daemon.

### Live channels (alpha / alpha-debug / beta) — still manual, by design
The cloud path covers **develop only** so far. Live releases are still the deliberate
host-side `npm run promote -- --channel <ch>` (a conscious manual act — see the promote
command in `CLAUDE.md`). Wiring alpha/beta to CodeBuild (`buildspec.alpha/beta` +
`--promote`) is the planned next step.

## Runbook

| Symptom | Cause | Fix |
|---|---|---|
| `sha256 mismatch for pack X` | torn/in-flux build — a pack changed after the manifest | not ours; wait for a clean rebuild, then re-push `develop` (no auto-retry — a push re-triggers the build). |
| `mixed_build:true` refusal | build flagged inconsistent upstream | wait for a clean build. |
| obfuscator `stale shim` and it did NOT self-heal | key unavailable | check `GODOT_RELEASE_SCRIPT_KEY` in `docker/.env` (game key). |
| `test_gate != pass` refusal | gate failed on Arc's side | fix the game/tests; not a deploy issue. |
| prod `develop` behind a `develop`-branch commit | CodeBuild build failed or the webhook didn't fire | check the `allbyte-godot-develop` build history + the `DevelopBuildFailure` alarm; fix game/gate and re-push, or retry the build in the CodeBuild console. |
| nothing deploying after a `develop` push | **expected** unless the commit message carried `[deploy-develop]` (token gate, 2026-07-23) — or the push didn't land on `develop` | to actually deploy, re-push with the token (`git commit --allow-empty -m "[deploy-develop] …"`); confirm the commit is on `develop`; check `allbyte-godot-develop` build history for a triggered run. |
| a live channel needs shipping | live channels aren't on the cloud path yet | promote deliberately host-side: `npm run promote -- --channel <alpha\|alpha-debug\|beta>`. |
| `develop` deploy step green but the game is broken | the light post-deploy boot smoke failed after upload — artifacts are live on the dev path | read the CodeBuild logs for the smoke output; bad build → fix + re-push; false alarm → `python scripts/smoke_prod.py --channel develop --boot-only` to re-check. |
| entitled user gets 403 / fallback page on beta | expired cookies (12h TTL), key-pair-id mismatch, or the Lambda can't read the signing secret | re-login → `betaGate` refetches; check `allbyte-studio-beta-cookies` CloudWatch AUDIT lines; confirm `CfBetaKeyPairId` matches the public key in the key group. |
| beta serves REAL game content anonymously | the `/godot/beta/*` behavior lost `TrustedKeyGroups` (or was reordered behind `/godot/*`) | `python scripts/smoke_prod.py --channel beta --locked-only` confirms; re-apply `node scripts/gate-beta-behavior.js --key-group <id> --apply`. This is the alarm case — treat as an incident. |
| `channels.json` lists a dead/retired channel | file is merge-only (each deploy adds; nothing removes) | GET the file, delete the key, PUT it back, invalidate `/godot/channels.json` (the picker drops it live). |
| a dev/beta channel serves stale small files (index.js, worklets) after a deploy | SW cached them under the old cache-first rule | one-time legacy issue: rule is network-first since 2026-07-07; a hard reload (or the boot watchdog) clears it. `.wasm`/`.pck` staleness instead → check the export carries `?v=` (push-channel warns). |

## Manual ops

Normal develop deploys need none of this — Arc pushes `develop` with a `[deploy-develop]`-tagged commit and CodeBuild does it.
These are **break-glass**, for when the cloud path is down and a build must ship by hand
against a host-mounted manifest:

```bash
# dry-run any channel (plans everything, uploads nothing)
node scripts/push-channel.js --manifest <path> --dry-run
# push a dev channel by hand (break-glass; normally the cloud path does this)
node scripts/push-channel.js --manifest <path>
# deliberately promote a live channel
node scripts/push-channel.js --manifest <path> --promote
# what's live right now
curl -s https://allbyte.studio/godot/channels.json
```

## Roadmap

- **Live channels on the cloud path** — extend CodeBuild to `alpha`/`beta`
  (`buildspec.alpha/beta` in the game repo + `--promote`) so live releases are also
  git-push-triggered. Until then live promotes are the manual `npm run promote`.
- **Generalized exporter** — the CodeBuild image + `cloud_export.sh` are ~80%
  game-agnostic; the seed of a "point at any Godot source → build → serve PWA" tool.
