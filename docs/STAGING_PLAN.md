# Staging Environment — Plan

**Status:** Plan, not yet implemented.
**Audience:** Drew, for decision.
**Last updated:** 2026-06-01.

## Goal

Catch deploy-breaking issues before users see them. Today's black-screen
bug (orphan shim on S3 corrupting the new WASM's key slot) made it
to production because the only "smoke test" between local export and
public URL was the version-stamp check — which passes even when every
PCK MD5 is failing in the background.

We want a verification layer that **exercises the engine** before the
deploy is visible to users.

## Constraints

- Solo dev. No team to coordinate with.
- Trunk-based / continuous deploy works fine — no need for release branches.
- Budget is small and accounted-for. Every dollar is monitored via the
  existing budget Lambda + auto-shutoff.
- Iteration speed matters more than process rigor.

## Three real options, ordered by how much they cost / how much they cover

### Option A — Post-deploy smoke on prod URL (shipped today, commit `pending`)

`scripts/smoke_prod.py` runs after `npm run push-assets` completes. Hits
the live URL via headless Chromium, waits for Godot to boot, scrapes
`window._consoleLogs` for the MD5 / encryption failure signatures.

- **Cost:** $0. Adds ~30–60s to every deploy. Uses the Playwright that
  e2e tests already require.
- **Catches:** any class of failure where the engine boots but loads
  resources wrong (today's bug, the 2026-05-31 bug, missing pack
  templates, scene-init crashes).
- **Misses:** anything CloudFront-specific that affects the smoke run
  too (e.g., wrong COOP/COEP headers — would fail in the same way for
  both the smoke and real users).
- **Real cost of failure:** the deploy is already live by the time
  smoke runs. Smoke flags the breakage; manual rollback if needed.

This is the right tier *for now*. It's a real safety net, even if
imperfect, and it costs nothing.

### Option B — Preview subdomain via separate CloudFront distribution

Spin up `preview.allbyte.studio` pointing at a separate S3 bucket and
CloudFront distribution. A new `npm run deploy:preview` pushes the
same dist + godot assets to the preview bucket; `npm run smoke:preview`
runs the Playwright check against `preview.allbyte.studio/play/`.
Only after smoke passes does `npm run push-assets` (renamed to
`deploy:prod`) push to the real bucket.

- **Cost:** another CloudFront distribution + S3 bucket. AWS pricing
  for low traffic is near-zero (~$0.50/month for a distribution that
  serves only you). ACM cert: free. Route 53 record: ~$0.50/month.
  Total ~$1/month, lost in budget noise.
- **Catches:** what Option A catches, plus anything CloudFront-config
  related (header policy regressions, cache-control changes, etc.).
- **Misses:** prod-specific issues that depend on actual user traffic
  patterns (cache contention, regional CDN edges, etc.) — those are
  rare and small at our scale.
- **Implementation effort:** ~1 day of work. New CFN stack for the
  preview infra (mostly a copy of the production one), tweak to
  `push-assets.js` for dual-environment, smoke script reused with a
  URL parameter.

This is the right tier when the game gets a real audience. Probably
overkill today.

### Option C — Local Playwright gate against staged files

Before `aws s3 sync`, spin up a tiny local HTTP server on
`public/godot/`, run the smoke against `http://localhost:PORT/`. Only
upload to S3 if it passes.

- **Cost:** $0. Adds ~30s to deploy. Pure tooling.
- **Catches:** broken local export (corrupt PCK, key mismatch in WASM,
  obfuscator state machine drift).
- **Misses:** anything specific to the S3/CloudFront layer — the
  thing that caused tonight's bug. Today's orphan shim is an S3-only
  artifact; local files were already consistent.

Worth doing in addition to A, not instead of it. Belt-and-suspenders.

## Recommendation

1. **Option A now** — landing alongside this doc. Already addresses
   today's class of incident.
2. **Option C soon** (next time the obfuscator pipeline is touched).
   Catches the "broken before upload" cases cheaply.
3. **Option B when one of these triggers it**:
   - First real audience press / demo where downtime would be
     embarrassing
   - Multiple deploys per day pattern emerges (currently it's
     several per session, but contained)
   - A CloudFront / S3 policy change needs to be tested before
     applying to prod
   - Cumulative incident cost > $1/month worth of staging infra

## Sketch of Option B if/when we build it

Skipping deep design until decision; quick outline:

- `infrastructure/preview.yaml` — CFN stack. New bucket
  `allbyte.studio-preview`, new distribution with the same Lambda@Edge
  / response headers config, ACM cert for `preview.allbyte.studio`,
  R53 alias. Mirrors `infrastructure/cloudformation.yaml` near-verbatim.
- `scripts/push-assets.js` extended to take `--env=preview|prod`.
  Defaults to `prod` for back-compat.
- `scripts/smoke_prod.py` parameterized via `SMOKE_URL` (already is).
- Promotion flow: deploy preview → smoke preview → if clean, deploy
  prod (no separate smoke needed; same bytes).
- Preview bucket has 7-day lifecycle on uploaded objects so it
  doesn't accumulate.
- Preview distribution served behind HTTP basic auth or signed
  cookies so it isn't accidentally indexed by search engines. Cheap
  via CloudFront Functions.

## Non-options

- **Vercel / Netlify preview** — doesn't fit S3+CloudFront. Would
  require migration.
- **PR-based previews** — overkill for solo workflow. Branches don't
  carry meaningful context for trunk-based flow.
- **Run game test inside Godot CI** — Arc's side handles this with
  the Tier 5 playthrough regression that `redeploy_web.sh` kicks
  off. Different concern (gameplay regressions) from this doc
  (deploy regressions).

## Open questions

- Should `smoke_prod.py` also verify the manifest, service worker,
  and PWA install criteria (icon URLs resolve, etc.)? Currently only
  exercises the iframe game. Probably yes for the next iteration —
  cheap to add.
- Should the smoke also check `/play/` headers (COOP/COEP) and bail
  if they regressed? Single-line addition; would have caught the
  COEP regression that bit us during the iOS-out-of-scope refactor.

Both worth doing whenever I'm next in `smoke_prod.py`.
