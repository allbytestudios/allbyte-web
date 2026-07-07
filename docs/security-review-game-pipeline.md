# Security review — game-build deploy pipeline & content gating

Reviewed 2026-07-07 against the five-channel deploy system (`DEPLOY.md`), the
content gates, and the cloud-exporter design. Format: per threat — controls in
place, residual risk, and the trigger that should reopen the item.

## 1. Paid-content bypass

**Threat:** a free user obtains Beta+ content (base build or zone packs)
without an Initiate+ subscription.

**Controls**
- Zone packs live in the **private** `allbyte-studio-packs` bucket (no public
  read). Delivery only via `GET /pck-url`: per-pack tier map, JWT verification
  (HS256 + expiry), 15-min presigned URLs, API-stage throttling (burst 20 /
  rate 10), AUDIT log lines. (`infrastructure/pack-gating.yaml` is a
  superseded duplicate design — deliberately not deployed.)
- Beta base build: CloudFront behavior `/godot/beta/*` with **TrustedKeyGroups**
  — the edge refuses requests without valid signed cookies. Cookies are issued
  by `GET /game/beta-cookies` only after verifying the JWT **and re-reading the
  tier from the users table** (a lapsed subscriber's still-valid JWT does not
  help; worst-case entitlement overhang = cookie TTL, 12h).
- The client-side picker (`gameVersions.ts`) is explicitly *not* a control —
  code comments say so, and `smoke_prod.py --channel beta --locked-only`
  verifies the edge gate on every beta deploy and in CI (`channel-smoke` job).
- The signing private key exists only in Secrets Manager
  (`allbyte-studio/cf-beta-signing-key`); the key ceremony deletes local
  copies. CloudFront holds only the public key.

**Residual risk**
- An entitled user can hand cookies/presigned URLs to a friend for their
  lifetime (≤12h / ≤15min). Accepted: same class as account sharing.
- `beta-debug` + `develop` are **deliberately ungated** (Legend/admin debug
  lanes). They carry develop-branch content that is *not* behind the pack
  gate. Accepted while that content is pre-release iteration of what free
  players already see.
- The custom error responses (403/404 → `/index.html`, HTTP 200) mean a
  misconfigured gate *looks* like a working page. Mitigated: the lock smoke
  body-sniffs for engine markers, never trusts status codes.

**Revisit when:** beta-debug/develop ever carry content that is itself the
paid product; or tier gating moves to Patreon (see §5).

## 2. Key exfiltration

**Threat:** extraction of (a) the Godot script-encryption key, (b) the JWT
HS256 secret, (c) the CloudFront signing key.

**Controls**
- (a) The key is XOR-masked in the shipped WASM (`obfuscate-godot-export.js`),
  un-masked only in browser memory by the shim; a live deploy REFUSES to ship
  unobfuscated (`push-channel.js`). Source key lives in the game-side
  `docker/.env` (host) or Secrets Manager (cloud path), never in this repo.
- (b) The JWT secret lives in Secrets Manager; Lambdas fetch at cold start.
  It never transits this repo, CI, or Claude sessions (standing rule).
- (c) See §1 — Secrets Manager only, public half in CloudFront.

**Residual risk**
- (a) Runtime extraction from a live browser remains possible — inherent to
  shipping playable code. The obfuscator raises the bar against static
  scanners (KeyDot etc.), which is its design goal. Key rotation is
  opportunistic (on Godot version bumps), not per-release.
- (b) **Blast radius is the real finding:** one HS256 secret signs auth
  tokens AND gates packs AND mints beta cookies. Whoever holds it is every
  tier everywhere. Accepted for a solo-operated stack (one secret to guard,
  zero secret-sync bugs), but it makes rotation an all-at-once event.

**Revisit when:** any second operator gets AWS access (split secrets then);
or the Patreon migration rewrites auth anyway (natural rotation point).

## 3. Deploy-pipeline compromise

**Threat:** malicious or corrupted build reaches players; or pipeline
credentials are abused.

**Controls**
- The auto lane physically cannot touch live channels: `--promote` is
  required for `alpha`/`alpha-debug`/`beta` and only a human runs it.
- Manifest gates: `test_gate != "pass"` and `mixed_build` refuse; sha256 of
  base + every pack verified against the manifest before upload; pack/channel
  names validated against injection (`SAFE_PCK`, slug regex) before reaching
  shell commands.
- Cloud path (develop, pending): CodeBuild role writes **only**
  `godot/develop/*` + `channels.json`; source pulled via a revocable
  CodeConnection; exporter image contains tooling only.
- Host path: the watcher runs under the owner's local AWS profile on the
  owner's machine — same trust domain as the owner's own `aws` CLI.
- Post-deploy smoke on every lane (Phase-1 addition): a deploy that doesn't
  boot marks itself `DEPLOY_FAILED`.

**Residual risk**
- The webapp CI (site deploy) and the game pipeline share the S3 bucket via
  different roles; a compromised GitHub Action could still overwrite site
  content. Standard OIDC-scoped-role posture accepted.
- `channels.json` is GET-modify-PUT with no locking — a torn write needs two
  concurrent deploys, which the single-owner serialization rule prevents.
  Accepted; documented in the runbook.

**Revisit when:** the CodeBuild develop stack goes live (re-check its role
scope against the template then — it's the first non-human deployer).

## 4. Cache poisoning / stale-cache integrity

**Threat:** users served mismatched or attacker-influenced game assets.

**Controls**
- All game assets same-origin behind CloudFront+OAC; the SW only caches
  same-origin `response.ok` basic responses (no opaque entries), and strips
  transfer-encoding artifacts before caching (`toCacheable`).
- Version integrity: SW cache name keys on the committed `game-version.json`;
  `finalize-web-deploy.js` makes commit-matches-deployed an invariant for live
  promotes; `smoke_prod.py` fails the deploy when live `sw.js` disagrees.
- Cross-channel staleness: cache-first is limited to self-versioned (`?v=`)
  or immutable `.wasm`/`.pck` requests (2026-07-07 rule); everything else
  revalidates. Boot watchdog self-heals a wedged cache client-side.

**Residual risk**
- Signed-cookie expiry mid-session turns fresh beta fetches into the 200
  fallback page; the SW's `response.ok` guard keeps it out of cache and
  `betaGate` refreshes at 80% TTL. Worst case is a reload prompt.

**Revisit when:** a second CDN origin or third-party asset host is added
(the same-origin assumptions above are load-bearing).

## 5. Standing notes

- **Patreon migration:** `/game/beta-cookies` depends only on the JWT secret
  + users-table `tier` — both survive the planned Stripe/OAuth removal, but
  the migration is the natural moment to rotate the JWT secret (§2b) and
  re-check every AUDIT consumer.
- **Observability decision:** no new CloudWatch alarms for gating. Signals
  today: deploy file markers, the CI qa-runs dashboard (incl. `channel-smoke`
  results), and the cookie Lambda's AUDIT lines. The first alarm arrives with
  the CodeBuild stack (`DevelopBuildFailure`). Reconsider if beta gets real
  traffic.
- This review covers the game pipeline. The webapp auth stack has its own
  known-gaps backlog (email squatting, rate limiting on auth endpoints) —
  tracked separately, unchanged by this work.
