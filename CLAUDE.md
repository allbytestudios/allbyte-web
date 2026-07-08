# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Web portal for AllByte Studios, an indie game studio building **The Chronicles of Nesis**, a fantasy tactical RPG in Godot (the shipping web build is Godot 4 — say Godot 4 in web copy/devlogs). The site embodies a "High-Tech Artisan" dual identity: AI-assisted engineering + 100% handcrafted art, music, and typography.

## Tech Stack
- **Framework:** Astro 6 (static SSG) + Svelte 5 (interactive islands)
- **Styling:** Tailwind CSS v4 (via `@tailwindcss/vite` plugin, not a config file)
- **Custom Font:** ModernGoth (`public/fonts/ModernGoth.otf`) — registered as `AllByteCustom` font-family
- **Package Manager:** npm
- **Deployment:** Static build → AWS S3 + CloudFront (auto-deploys on push to `main`)

## Commands
```bash
# Daily
npm run dev                           # Astro dev server, binds 0.0.0.0:4321 (reachable on LAN)
npm run build                         # Sync assets + production build → dist/
npm run preview                       # Preview production build locally

# Asset / data sync
npm run sync                          # Pull assets from Godot project
npm run push-assets                   # Upload generated assets to S3
npm run push-packs                    # Upload game packs to S3
npm run usage                         # Refresh Claude usage data → src/data/claude-usage*.json
npm run sync:scenarios                # Mirror Quinn's scenario spine + save fixtures (commit results)
npm run sync:marketing                # Pull published Postiz posts → src/data/marketing-posts.json
python scripts/spritesheet-to-gif.py  # Convert sprite sheets to animated GIFs

# Test data sync (Arc → web console)
npm run sync:watch                    # Watch for test/ticket data changes from Godot project
npm run sync:once                     # One-shot sync of test data
npm run sync:dry                      # Dry-run sync (show what would change)
npm run sync:test                     # Self-test the sync watcher

# Game-build deploy (see DEPLOY.md for the full runbook)
# develop: Arc pushes the game repo's `develop` branch → CodeBuild builds + deploys (no local step)
npm run promote -- --channel alpha    # Deliberate LIVE promote (push + finalize) — live channels only
node scripts/push-channel.js --manifest <p> [--promote|--dry-run]  # Break-glass manual deployer
npm run changelog                     # Regenerate src/data/changelog.json from deploy manifest

# E2E tests (Playwright + pytest, dev server must be running)
npm run test:e2e                      # Run all E2E tests (headless)
npm run test:a11y                     # Accessibility tests (WCAG 2.1 AA) — occasional, not a per-change gate
pytest tests/e2e/test_devlog.py       # Run a single test file
pytest tests/e2e/ --headed            # Run with visible browser
BASE_URL=https://allbyte.studio pytest tests/e2e/  # Test against production

# Other QA harnesses
npm run smoke:prod                    # Prod smoke test (headers, boot, sw.js version match)
npm run qa:controllers                # Gamepad-API mock sweep over controller profiles
npm run qa:browsers                   # Chromium/Firefox/WebKit boot+new-game+movement gameplay QA
```

## Architecture

### Page Layout & Navigation
All pages use `BaseLayout.astro`, which provides:
- Astro `ClientRouter` for smooth client-side page transitions
- A persistent `MusicPlayer.svelte` (`client:load` + `transition:persist="music-player"`) that survives navigation
- Global styles from `src/styles/global.css`

Astro config uses `trailingSlash: "always"` — all routes end with `/`.

### Bilateral Landing Page
The `/` landing page is a vertical split-screen (`BilateralLayout.svelte`):
- **Left: "The Engine"** — Technical/dark terminal theme, monospace font, cyan accent (`--engine-accent: #a7f3d0`)
- **Right: "The Heart"** — Artistic/bespoke theme, ModernGoth font, warm parchment tones (`--heart-bg: #cec08a`)

Panels expand/contract on hover (60/40 split) via CSS grid transitions. Stacks vertically on mobile (<768px).

### Music Player System
The music player is a cross-page singleton managed through custom events:
1. `MusicPlayer.svelte` loads in `BaseLayout` and persists via `transition:persist`
2. Pages dispatch `music-player:load` (with track array) and `music-player:play` (to change track)
3. Playback state saved to `sessionStorage` key `"music-player"`
4. Exposes `window.__musicPlayerPlaying` and `window.__musicPlayerIndex` for cross-component sync

### Dual Theme System
CSS variables in `src/styles/global.css` define two themes:
- **Engine** (dark/technical): `--engine-bg`, `--engine-text`, `--engine-accent`
- **Heart** (warm/artistic): `--heart-bg`, `--heart-accent`, `--heart-card-bg`

The `Footer.astro` component accepts a `theme` prop (`"engine"` | `"heart"`) to match page context.

### Routes
- `/` — Bilateral landing page ("Play now" navigates to `/play/` — no embedded player on the landing page)
- `/play` — Godot HTML5 game embed: download gate (~75 MB ack, `downloadGate.ts`), tier-gated channel picker (`gameVersions.ts`), boot watchdog with stale-cache self-heal, mobile tap-to-fullscreen, anonymous play-depth beacons (`playAnalytics.ts`), `?channel=` + scenario deep-links
- `/music` — Music player with track list
- `/artwork` — Sprite gallery (Allies/Enemies/Bosses)
- `/fonts` — ModernGoth typeface showcase
- `/walkthrough/` — Scene-graph walkthrough (magazine-scroll scene map)
- `/changelog/` — Public "what's new" feed rendered from `src/data/changelog.json`
- `/subscribe` — Membership tiers hosted on Patreon (pledge on Patreon; log in with Patreon to unlock — tier syncs on login)
- `/legends_square/` — Legend-tier private post board (auth-gated)
- `/devlog/` — Devlog hub with three sub-blogs:
  - `/devlog/chronicles/` — Chronicles of Nesis game development
  - `/devlog/godot-and-claude/` — Godot + AI pair-programming
  - `/devlog/studio/` — Studio platform & infrastructure
- `/devlog/[...slug]/` — Individual devlog posts (dynamic route)
- `/self-hosting-with-claude/` — Long-form architecture/cost writeup linked from README
- `/privacy/`, `/terms/`, `/unsubscribed/` — Legal + email-unsubscribe pages
- `/test/` — Dev Console (engine-themed dashboard; subscriber/admin-facing)
  - `/test/tickets/` — Milestones → epics tree, fed by the beads (`bd`) export (`beadsSource.ts`)
  - `/test/tests/` — Test management view
  - `/test/decisions/` — Owner Q&A queue (`owner_questions.json` → `OwnerQuestionsApp`)
  - `/test/scenarios/` — Quinn's scenario launcher (click-to-jump into a saved scenario on the develop build)
  - `/test/play-funnel/` — Admin-gated play-depth funnel (pairs with `play-analytics` stack)
  - `/test/marketing-queue/` — Marketing post queue/chart (Postiz + hand-logged channels)
  - `/test/milestones/view/`, `/test/view/` — Detail views
- `/admin/users` — Admin user management

### Content Collections
- **Devlogs** (`src/content/devlogs/`): Markdown posts with frontmatter schema
  - `category`: `"engineering"` | `"workflow"` | `"strategy"` | `"narrative"` | `"craft"`
  - `devlog`: `"chronicles"` | `"godot-and-claude"` | `"studio"` — determines which sub-blog the post appears under
  - `tags`: string array (optional)
  - `heroImage`: string (optional)
  - `draft`: boolean (optional, defaults to `false`)
  - See `src/content.config.ts` for full schema

### Dev-Only Vite Middlewares (`astro.config.mjs`)
Five custom plugins run in `npm run dev` only — none ship to prod, where the equivalent paths come from S3/CloudFront. Misdiagnosing a dev-only behavior as a bug is easy if you don't know these exist:
- **`chroniclesProxy`** — serves `/test-data/*` and `/godot/*` straight from `CHRONICLES_DIR` (default `C:/Users/drew/Desktop/GameDev/ChroniclesOfNesis`). Path-traversal guarded with both normalized-path and resolved-symlink checks. In prod, the dashboard reads `/test-snapshot/*` from S3 (populated by `npm run push-assets`) and `/godot/*` from `public/godot/`.
- **`POST /api/decisions`** (`decisionWriteback`) — appends owner decisions to `tickets/agent_chat.ndjson` and marks the matching pending decision resolved. 16 KB body cap; `decisionId` must match `^[A-Za-z0-9_-]{1,64}$`.
- **`POST /api/answers`** (`ownerAnswerWriteback`) — append-only stream at `tickets/owner_answers.ndjson` for `choice`/`verification`/`freeText` answer types. All answer types stay in this single stream; Arc tails it and applies to source-of-truth files.
- **`/test-data-events`** (`testDataEvents`) — SSE endpoint that broadcasts file-change events from a fixed allowlist (`.beads/issues.jsonl`, `tickets/owner_questions.json`, `tickets/owner_answers.ndjson`, `tickets/.answer_daemon_heartbeat.json`, `test_index.json`, `test_roadmap.json`). Debounced ~50ms; 15s heartbeat. Dashboard updates ~200ms after Arc writes; polling stays as fallback if the connection drops.
- **`godotReload`** — chokidar-watches `public/godot/` and broadcasts a single `godot/reload` SSE event per debounced batch when Arc's `redeploy_web.sh` finishes. Vite's built-in watcher is told to ignore `public/godot/**` so it doesn't tear down HMR before this fires.
- **`/tempo-api/*` proxy** — forwards to `localhost:3200/api/*` for the in-flight observability UI. Tempo has no CORS and is bound 127.0.0.1-only; in prod this proxy doesn't exist and fetches 404 by design.

### Middleware (`src/middleware.js`)
Sets COOP `same-origin` + COEP `require-corp` on every dev response so `/play/` can host a cross-origin-isolated iframe (Godot HTML5 needs `SharedArrayBuffer`). `/test/in-flight*` is exempted because it embeds Grafana, which doesn't send `Cross-Origin-Resource-Policy`. Note the asymmetry: `astro.config.mjs` server-level header is `COEP: credentialless`, but middleware tightens it per-response to `require-corp`. SSG strips middleware, so prod parity comes from CloudFront response-headers policy.

### `src/lib/` — Reactive State and Shared Types
- `auth.svelte.ts` — Svelte 5 reactive auth store (`initAuth`, `login`, `signup`, `logout`, `oauthLogin`)
- `saves.svelte.ts` — save-sync state for `/play/` ↔ Godot postMessage protocol
- `gameVersions.ts` — the five tier-gated game channels (alpha / alpha-debug / beta / beta-debug / develop); id→path/tier source of truth. Debug gate is client-side (low stakes); paid Beta content must be server-gated (see `pack-gating.yaml`), never by this module alone
- `downloadGate.ts` — pre-launch ~75 MB download acknowledgment; the game iframe `src` is withheld until acked, so it's a true gate. Re-prompts on version bump
- `playAnalytics.ts` — anonymous, no-PII play-depth beacons from `/play/` (sendBeacon, prod-host only; no-op if the write URL is unset)
- `beadsSource.ts`, `beadsTypes.ts` — fetch/parse Arc's beads export (`.beads/issues.jsonl`), merged with the static `historical_epics.json` snapshot for pre-migration epics
- `scenarios.ts` — scenario-launcher catalogue (from `src/data/scenarios.json`, synced from Quinn's spine)
- `walkthrough.ts`, `walkthroughScenes.ts` — walkthrough scene-map data
- `marketingQueue.ts`, `marketingFixtures.ts` — marketing-queue console data
- `testDataSource.ts`, `testEvents.ts`, `testIndex.ts`, `testingRoadmap.ts`, `milestones.ts` — Dev Console data layer (dev proxy vs prod S3, SSE subscription)
- `ticketTypes.ts` — TypeScript types for Arc's legacy tickets/epics/dashboard JSON
- `tier.ts` — Subscription tier helpers shared between subscribe and gated pages

### Asset Sync
Game assets are pulled from the local Godot project (`TacticalTestDev`) via `scripts/sync-assets.js`.
Configuration in `scripts/asset-manifest.json`. Sprite sheets converted to GIFs via `scripts/spritesheet-to-gif.py`.
Generated data files: `src/data/game-version.json`, `src/data/asset-index.json`, `src/data/sprite-gifs.json`.
All generated files committed to git (CI has no Godot access). Sync gracefully skips if Godot project not found.

## Backend (Lambda + DynamoDB + API Gateway)

All backend infrastructure is inline Python 3.12 Lambda functions in one CloudFormation template, `infrastructure/stripe-backend.yaml` (legacy filename; stack `allbyte-studio-stripe`). **That template is private — not in the public repo** (it carries all the Lambda source; deploys via CLI from the local copy). API Gateway V2 (HTTP API) at `https://api.allbyte.studio`.

**Auth is Patreon-only.** The 2026-06 migration removed Stripe, email/password, and Google/Discord auth. Patreon OAuth is the sole login; non-patrons are free tier; each patron's membership tier is derived from their Patreon pledge. Don't reintroduce Stripe/email/Google/Discord.

### DynamoDB Tables
- **`allbyte-studio-users`**: userId (PK), email (GSI `email-index`), username, `patreonId`, `tier`, oauthProvider (`patreon`), notificationPreferences, createdAt
- **`allbyte-studio-posts`**: Legend's Square post board
- **`allbyte-studio-subscriptions`**: retained from the Stripe era (no new writes)

### API Endpoints (grouped; ~25 routes total)
| Route | Purpose |
|-------|---------|
| `GET /auth/oauth/{provider}` + `/callback` | **Patreon** OAuth start + callback (only `patreon` wired) |
| `GET /auth/me` | Validate Bearer JWT, return profile + tier |
| `POST /webhook/patreon` | Patreon webhook — sync tier on pledge create/update/delete |
| `GET /counts` | Public subscriber tier counts |
| `GET /auth/unsubscribe` · `PUT /auth/notification-prefs` | Email prefs |
| `GET/PUT/DELETE /saves` | Cloud save sync (Hero/Legend) |
| `GET /pck-url` · `GET /game/beta-cookies` | Server-side content gates (packs / beta) |
| `GET/POST /legend/posts` · `PUT /legend/posts/{postId}/reply` | Legend's Square |
| `GET /admin/users` · `PUT /admin/users/{userId}/tier` · `GET /admin/stats/*` · `GET /analytics/*` | Admin + analytics (admin-gated) |

### Authentication Flow
- **JWT tokens**: HS256 signed with `allbyte-studio/jwt-secret` (Secrets Manager), 7-day expiry
- **Client-side**: token in `localStorage` key `"allbyte_token"`, sent as `Authorization: Bearer`
- **Auth store**: `src/lib/auth.svelte.ts` — `initAuth()`, `oauthLogin("patreon")`, `logout()`
- No passwords (Patreon-only login)

### Patreon OAuth + membership
1. `oauthLogin("patreon")` -> `GET /auth/oauth/patreon` -> 302 to patreon.com (client_id from `allbyte-studio/patreon-oauth`, HMAC-signed `state`)
2. Callback exchanges the code, fetches `identity?include=memberships`, maps the entitled tier (`PATREON_TIER_IDS`, campaign `16252801`: Initiate `28882017` / Hero `28882292` / Legend `28882311`; amount-cents fallback), persists `patreonId` + `tier`, signs a JWT, redirects to `{SITE_DOMAIN}/#token={jwt}`; `initAuth()` reads the hash
3. **Webhook** `POST /webhook/patreon` verifies `X-Patreon-Signature` (HMAC-MD5, `allbyte-studio/patreon-webhook-secret`), updates tier on `members:pledge:create|update|delete`

**Redirect URI** (must match the Patreon app): `https://api.allbyte.studio/auth/oauth/patreon/callback`

**Orphaned legacy secrets** (safe to delete): `allbyte-studio/google-oauth`, `discord-oauth`, `stripe-secret-key`, `stripe-webhook-secret`.

### CORS
API Gateway allows origins: `https://allbyte.studio`, `http://localhost:4321`. Methods: GET, POST, PUT, DELETE, OPTIONS. Headers: Content-Type, Authorization.

## CI/CD
GitHub Actions:
- **`deploy.yml`** — push to `main` triggers build + S3 sync + CloudFront invalidation. Uses OIDC for AWS auth (no stored secrets). Integration tests verify HTTP 200 and required headers (COEP/COOP/HSTS).
- **`qa.yml` (Deploy QA)** — runs after a successful deploy (or manually): boots `/play/` on prod across an OS × browser-engine matrix (gates on Chromium + WebKit × 2 OS; Firefox advisory) plus the controller harness, uploads results to `test-snapshot/qa-runs/<run-id>/` for the `/test/` console's matrix panel. Matrix failures don't block the aggregator.
- **`exporter-image.yml`** — builds the Godot cloud-exporter image to ECR (for the planned CodeBuild path).

## Infrastructure

> **Public/private boundary:** everything under `infrastructure/` is **gitignored — not in the public repo** (site/business infra + marketing strategy; kept locally only). The paths below are local. The *reusable* deploy IaC that ships publicly lives in `deploy/`. Before adding anything to the public repo, see [`docs/PUBLIC_PRIVATE_BOUNDARY.md`](./docs/PUBLIC_PRIVATE_BOUNDARY.md).

- **Frontend**: `infrastructure/cloudformation.yaml` — S3 bucket, CloudFront with OAC, ACM cert, budget alerts with auto-shutoff Lambda. NOTE: the CloudFront/budget parts have drifted from the template and are managed via CLI.
- **Backend**: `infrastructure/stripe-backend.yaml` — Lambda functions, DynamoDB tables, API Gateway, IAM roles
- **Pack gating**: `infrastructure/pack-gating.yaml` — HTTP API handing out short-lived presigned S3 GETs for zone `.pck` files in the private packs bucket (matches PackLoader.gd's `GET /pack?pack=<Name>` + Bearer JWT contract; anonymous short-lived tokens via `/pack-token`). This is the server-side gate paid Beta content requires.
- **Play analytics**: `infrastructure/play-analytics.yaml` — standalone anonymous play-depth funnel stack (write beacon endpoint + admin-gated read), consumed by `playAnalytics.ts` and `/test/play-funnel/`
- **Cloud exporter (LIVE for develop)**: `deploy/godot-export-codebuild.yaml` + `deploy/exporter-image-ci.yaml` — git-push→CodeBuild hermetic game export + deploy; develop only, alpha/beta wiring pending (see DEPLOY.md)
- **Marketing stack**: `infrastructure/marketing/` — self-hosted Postiz (docker-compose) + posting playbook + `publish-and-verify.ps1`. If posts stick in QUEUE: `docker restart allbyte-marketing-postiz`.
- **GPU inference (planned, not deployed)**: `infrastructure/qwen-spot/README.md` — Qwen2.5-Coder-32B on EC2 Spot (g6.12xlarge, vLLM, multi-stream concurrent batching) sized for 2–3 concurrent leads. Recommended architecture: Arc stays on Claude Max, Nix/Port/Vera leads route to Qwen via `OPENAI_API_BASE`. Mirrors `allbyte-studio-cost-shutoff` pattern under `allbyte-studio-qwen-*`. Full plan: `~/.claude/plans/no-i-don-t-have-vivid-metcalfe.md`. Arc handoff: `C:/Users/drew/Desktop/GameDev/APP_CLAUDE_QWEN_AB_PROPOSAL.md`.

### Deploying Backend Changes
```bash
aws cloudformation deploy \
  --template-file infrastructure/stripe-backend.yaml \
  --stack-name allbyte-studio-stripe \
  --capabilities CAPABILITY_NAMED_IAM \
  --s3-bucket allbyte-studio-cfn-deploy --s3-prefix stripe-backend   # template >50KB, needs staging
```

## Deployment Notes
- Godot `/play` page requires SharedArrayBuffer headers (configured in CloudFront):
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
  - COOP/COEP apply to `/play` + `/godot` paths only (CloudFront policy `allbyte-studio-coi`, CLI-managed — the CFN template has drifted)
- Place Godot HTML5 export files in `public/godot/`
- HTML files served with `max-age=0, must-revalidate`; versioned assets cached 1 year

### Game-build deploy pipeline (channels) — full runbook in `DEPLOY.md`
Game builds (Arc's Godot web exports) deploy separately from site content, via five
build channels under `/godot/` whose availability is published at runtime in
`/godot/channels.json` (no source commit flips a build live). `develop`/`beta-debug`
are dev channels (deploy freely); `alpha`/`alpha-debug`/`beta` are live and physically
require `--promote`.

- **`scripts/push-channel.js`** — the one deployer. Verifies the build manifest
  (`test_gate`, `mixed_build`, per-pack sha256), obfuscates, gzip-uploads the WASM,
  syncs to `godot/<channel>/`, merges `channels.json`, invalidates CloudFront. Live
  channels also stamp `sw.js` and run the prod smoke.
- **`develop` = git-push → CodeBuild (LIVE, hands-off).** A push to the game repo's
  `develop` branch webhooks CodeBuild `allbyte-godot-develop`, which builds the export
  from source (key-baked template, Tier-2 gate) and runs `push-channel.js` — no laptop,
  IAM-scoped to `godot/develop/*`. `scripts/deploy-watcher.js` + the `Startup` VBS were
  the interim host daemon; **retired 2026-07-04, dormant — do not run.**
- **`npm run promote`** — the deliberate live ship: `push-channel --promote` then
  `finalize-web-deploy.js` (stamps `src/data/game-version.json` to the *deployed*
  version, regenerates `changelog.json`, commits + pushes so CI re-stamps `sw.js`).
- **Stale-cache invariant:** the service worker keys its cache on the committed
  `game-version.json`. If that file is stamped older than the deployed game assets,
  returning users hang on boot ("SW version drift"). `finalize-web-deploy.js` exists
  to make this impossible on live promotes; `smoke:prod` checks the match.
- **Live channels (alpha/beta) not yet on the cloud path:** promotes remain the manual
  `npm run promote`. Extending CodeBuild to `buildspec.alpha/beta` + `--promote` is the
  next step. Infra: `deploy/godot-export-codebuild.yaml` + `deploy/exporter-image-ci.yaml`.

### Godot key obfuscation (`scripts/obfuscate-godot-export.js`)
The Godot 4 web export ships its script-encryption key as 32 contiguous bytes
inside `index.wasm`. The obfuscator XORs that slot with a random per-release
mask and injects `<script src="pck-key-shim.js"></script>` ahead of the engine
loader; the shim intercepts the WASM fetch and XORs the bytes back so the
engine sees plaintext in linear memory. Static scanners (KeyDot etc.) get
nothing useful from the WASM on disk.

Both `npm run push-assets` and `push-channel.js` run the obfuscator before
uploading and hard-abort the deploy on any inconsistency. The obfuscator is
idempotent:
- shim absent, key found in WASM → fresh obfuscation
- shim present, SHA matches WASM, HTML still patched → no-op
- shim present, SHA matches WASM, HTML overwritten by re-export → re-patch HTML
- shim present, SHA mismatches WASM → refuse (re-exported after obfuscation;
  shim's mask no longer fits the new WASM)
- shim present, no SHA marker (legacy) → refuse
- key not findable in WASM (dev template without key compiled in) → skip cleanly

The shim file embeds a `// WASM_SHA256: <hex>` marker for that verification.
The 2026-05-31 black-screen bug was caused by a re-export overwriting the
patched HTML while keeping the obfuscated WASM and shim file. The SHA marker
+ push-pipeline integration is what prevents it from recurring.

Set `SKIP_GODOT_OBFUSCATION=1` to bypass the obfuscation step in `push-assets`
(debugging only — ships whatever's on disk verbatim).

## Tests
Playwright-based E2E tests in `tests/e2e/` using pytest. The dev server must be running (`npm run dev`) before running tests. The `conftest.py` provides:
- `page` fixture: fresh Playwright Chromium page per test (1280×960 viewport)
- `mock_api` fixture: intercepts Lambda API calls with mock responses (auth, checkout, counts)
- Auto-screenshots on failure saved to `tests/e2e/test_results/`

`tests/e2e/game_driver.py` (Quinn's) drives the actual game via TestBridge window
hooks — no keyboard simulation. Other suites build on it:
- `tests/cross-browser-qa/` — per-engine (Chromium/Firefox/WebKit) `/play/` embed smoke + public-build BOOT / NEW GAME / MOVEMENT gameplay checks (`npm run qa:browsers`; also runs in CI via `qa.yml`)
- `tests/controller-qa/` — Gamepad-API mock harness sweeping controller profiles without hardware (`npm run qa:controllers`)
- `tests/autoplay-capture/` — marketing capture pipeline (AutoPlay-driven recording → clip → caption)
- `scripts/smoke_prod.py` — prod smoke (`npm run smoke:prod`); also invoked by live-channel deploys

## Conventions
- Art, music, and fonts are **never AI-generated** — they are handcrafted by AllByte
- AI (Claude) is used for code, infrastructure, and automation
- "AllByte" = the solo developer/owner; "AllByte Studios" = the studio name
- Engine side = monospace/terminal aesthetic; Heart side = serif/organic aesthetic
- All site copy and devlog posts use **first-person singular** ("I/my/me"), never "we/our/us" — AllByte is a solo developer
- Never write the owner's real name anywhere in this repo (commits, code, docs, data) — use "the owner" / "AllByte" or omit
- In user-facing prose the game is always "The Chronicles of Nesis" (or "Chronicles of Nesis"), never bare "Chronicles"
- New devlog posts ship with `draft: true`; un-draft only when the owner explicitly says publish

## Multi-Claude Coordination
Two Claude instances work together on this project:
- **App Claude** (you) — works in `allbyte-web/`, handles the Astro web app, backend Lambdas, infrastructure, and CI/CD
- **Arc** — orchestrator agent in the docker container (`/workspace/GameDev/ChroniclesOfNesis/`), manages tickets and coordinates three lead agents:
  - **Nix** — game system lead (GDScript, events, scenes, autoloads)
  - **Vera** — test implementation lead (Playwright, test shapes A/B/C/D, quality gates)
  - **Port** — web export lead (WASM, translation rules, pack pipeline)

Arc is the owner's primary interface for the game side. Tickets follow: `PLANNING → TECH REVIEW → READY → IN PROGRESS → TESTING → DONE`. Each lead can spawn workers within a slot budget.

### Quinn — QA / marketing / balance peer seat
**Quinn is an active peer seat, not Arc's subagent and not historical** — her own session; the owner talks to her directly. She coordinates via `QA_CLAUDE_*.md` (she writes) ↔ `CON_CLAUDE_*.md` (Arc replies), in the same `Desktop/GameDev/` coord dir.

App consumes two things from Quinn:
- **Marketing masters** — 16:9 native-res captures (croppable framing noted) in `Quinn/published/`. The clip → caption → publish pipeline is App's.
- **`Quinn/published/quinn_spine.json`** — the scenario-launcher content source (gameplay-order rows: `label`, `packs`, `fixtureId`, optional `persona`). Quinn owns the spine *and* the referenced save fixtures; App renders + loads.

**Fixture boundary:** scenario saves the launcher loads must live in `ChroniclesOfNesis/WebTests/fixtures/saves/` (Arc commits them there from Quinn's library). A save that's only in `Quinn/reports/` is invisible to the launcher — always reference the promoted library `fixtureId`, never a reports path. App mirrors the handful of launcher-referenced saves into its own origin (CORS: the launcher fetches them same-origin, then hands the bytes to the game iframe via `_testImportSave`).

### Data Files Arc Publishes
The webapp consumes these from the Chronicles repo. The dev SSE allowlist in `astro.config.mjs` (`WATCHED_RELS` in `testDataEvents`) is the source of truth for which files trigger live updates:
| File | Purpose |
|------|---------|
| `.beads/issues.jsonl` | The beads (`bd`) ticket/epic export — sole source for `/test/tickets/` and epic state |
| `tickets/owner_questions.json` | Questions awaiting owner input (drives `/test/decisions/`) |
| `tickets/owner_answers.ndjson` | Append-only owner-answer stream (Arc tails this and applies to source-of-truth files) |
| `tickets/.answer_daemon_heartbeat.json` | Liveness signal for Arc's answer daemon |
| `test_index.json`, `test_roadmap.json` | Test catalog and roadmap |
| `tickets/deploy_manifest.ndjson` | Per-version game commits — joined with `game-version.json` history by `deploy-history.js` to build `/changelog/` (not SSE-watched) |

A `verified:false` answer does **not** reopen the original ticket — Arc cuts a new ticket that references it.

`test_fixtures/manifest.json` lists save-state fixtures for the fixture picker.

### Ticket tracking: beads (`bd`)
Ticket tracking lives in [gastownhall/beads](https://github.com/gastownhall/beads) (`bd` CLI) on Arc's side; the console reads its `.beads/issues.jsonl` export via `src/lib/beadsSource.ts` (dev: chroniclesProxy; prod: `test-snapshot/` on S3 via the sync watcher). Pre-Alpha epics predate the migration and come from the bundled `src/data/historical_epics.json` snapshot, merged in at read time — droppable once Arc backfills them into bd. The legacy `tickets.json`/`epics.json`/`dashboard.json` sprawl and the per-agent surfaces (`/test/agents/`, `/test/agent-chat/` — a failed experiment) are gone; the console surfaces epic-level state only.

### Cross-Claude Communication
Coordination files live in `C:\Users\drew\Desktop\GameDev\` (host-side mount of `/workspace/GameDev/`):
- `SAVE_SYNC_INTEGRATION.md` — postMessage protocol contract for save sync
- `WEB_DEPLOY_QUESTIONS.md` — Q&A about deploying the web export
- `CON_CLAUDE_FIXTURE_RESPONSE.md` — fixture format and TestBridge hooks
- `CLAUDE_COORDINATION.md` — coordination protocol and change boundaries

When you need to ping Arc, leave a markdown file in that directory and (optionally) send a tmux message via `docker exec --user dev tactical-dev tmux send-keys -t 0 "[App Claude] ..."` followed by Enter to interrupt their session.

### Dev Console Data Integration
The Dev Console (`/test/`) renders Arc's ticket data:
- **Local dev:** Near real-time (SSE + polling fallback). Vite proxy serves JSON directly from Chronicles repo. The local console is the real work tool.
- **Prod:** Light real-time (~60s-5min). JSON synced to `test-snapshot/` on S3 by `npm run sync:watch` (the sync-test-data-watcher). Prod freshness is not load-bearing.
- **Fixture picker:** Reads `test_fixtures/manifest.json`, sends `{type: "load_fixture", path: "..."}` via postMessage to Godot iframe.
- **Estimation rollups:** Epic `estimatedHours` rolled up by epic and milestone for effort-vs-priority view.
- **Ticket detail:** Show current phase, lead signoffs, success criteria with paired test specs. No per-ticket phase history — aggregate analytics for bottleneck analysis only.
