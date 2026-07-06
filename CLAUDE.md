# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Web portal for AllByte Studios, an indie game studio building **The Chronicles of Nesis**, a fantasy tactical RPG in Godot 3.5. The site embodies a "High-Tech Artisan" dual identity: AI-assisted engineering + 100% handcrafted art, music, and typography.

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
python scripts/spritesheet-to-gif.py  # Convert sprite sheets to animated GIFs

# Test data sync (Arc → web console)
npm run sync:watch                    # Watch for test/ticket data changes from Godot project
npm run sync:once                     # One-shot sync of test data
npm run sync:dry                      # Dry-run sync (show what would change)
npm run sync:test                     # Self-test the sync watcher

# E2E tests (Playwright + pytest, dev server must be running)
npm run test:e2e                      # Run all E2E tests (headless)
npm run test:a11y                     # Run accessibility tests (WCAG 2.1 AA)
pytest tests/e2e/test_devlog.py       # Run a single test file
pytest tests/e2e/ --headed            # Run with visible browser
BASE_URL=https://allbyte.studio pytest tests/e2e/  # Test against production
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
- `/` — Bilateral landing page
- `/play` — Godot HTML5 game embed
- `/music` — Music player with track list
- `/artwork` — Sprite gallery (Allies/Enemies/Bosses)
- `/fonts` — ModernGoth typeface showcase
- `/subscribe` — Subscription tiers + Stripe Checkout
- `/legends_square/` — Legend-tier private post board (auth-gated)
- `/devlog/` — Devlog hub with three sub-blogs:
  - `/devlog/chronicles/` — Chronicles of Nesis game development
  - `/devlog/godot-and-claude/` — Godot + AI pair-programming
  - `/devlog/studio/` — Studio platform & infrastructure
- `/devlog/[...slug]/` — Individual devlog posts (dynamic route)
- `/self-hosting-with-claude/` — Long-form architecture/cost writeup linked from README
- `/test/` — Dev Console (engine-themed dashboard for tests, tickets, milestones)
  - `/test/tickets/` — Collapsible tree view of milestones → epics → tickets (Arc-fed today; switches to `bd_dashboard.json` once the beads bridge lands)
  - `/test/tests/` — Test management view
  - `/test/decisions/` — Owner Q&A queue (`owner_questions.json` → `OwnerQuestionsApp`)
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
- **`/test-data-events`** (`testDataEvents`) — SSE endpoint that broadcasts file-change events from a fixed allowlist (`tickets/owner_questions.json`, `tickets.json`, `dashboard.json`, `epics.json`, `owner_answers.ndjson`, `.answer_daemon_heartbeat.json`, plus `test_index.json`, `test_roadmap.json`). Debounced ~50ms; 15s heartbeat. Dashboard updates ~200ms after Arc writes; polling stays as fallback if the connection drops.
- **`godotReload`** — chokidar-watches `public/godot/` and broadcasts a single `godot/reload` SSE event per debounced batch when Arc's `redeploy_web.sh` finishes. Vite's built-in watcher is told to ignore `public/godot/**` so it doesn't tear down HMR before this fires.
- **`/tempo-api/*` proxy** — forwards to `localhost:3200/api/*` for the in-flight observability UI. Tempo has no CORS and is bound 127.0.0.1-only; in prod this proxy doesn't exist and fetches 404 by design.

### Middleware (`src/middleware.js`)
Sets COOP `same-origin` + COEP `require-corp` on every dev response so `/play/` can host a cross-origin-isolated iframe (Godot HTML5 needs `SharedArrayBuffer`). `/test/in-flight*` is exempted because it embeds Grafana, which doesn't send `Cross-Origin-Resource-Policy`. Note the asymmetry: `astro.config.mjs` server-level header is `COEP: credentialless`, but middleware tightens it per-response to `require-corp`. SSG strips middleware, so prod parity comes from CloudFront response-headers policy.

### `src/lib/` — Reactive State and Shared Types
- `auth.svelte.ts` — Svelte 5 reactive auth store (`initAuth`, `login`, `signup`, `logout`, `oauthLogin`)
- `saves.svelte.ts` — save-sync state for `/play/` ↔ Godot postMessage protocol
- `testDataSource.ts`, `testEvents.ts`, `testIndex.ts`, `testingRoadmap.ts` — Dev Console data layer (dev proxy vs prod S3, SSE subscription)
- `ticketTypes.ts` — TypeScript types for Arc's tickets/epics/dashboard/agents JSON
- `tier.ts` — Subscription tier helpers shared between subscribe and gated pages

### Asset Sync
Game assets are pulled from the local Godot project (`TacticalTestDev`) via `scripts/sync-assets.js`.
Configuration in `scripts/asset-manifest.json`. Sprite sheets converted to GIFs via `scripts/spritesheet-to-gif.py`.
Generated data files: `src/data/game-version.json`, `src/data/asset-index.json`, `src/data/sprite-gifs.json`.
All generated files committed to git (CI has no Godot access). Sync gracefully skips if Godot project not found.

## Backend (Lambda + DynamoDB + API Gateway)

All backend infrastructure is defined in `infrastructure/stripe-backend.yaml` as inline Python 3.12 Lambda functions within a CloudFormation template. The API Gateway V2 (HTTP API) is at `https://api.allbyte.studio`.

### DynamoDB Tables
- **`allbyte-studio-users`**: userId (PK), email (GSI `email-index`), username, passwordHash (email/password users only), oauthProvider, oauthId (OAuth users), stripeCustomerId, createdAt
- **`allbyte-studio-subscriptions`**: customerId (PK), subscriptionId, status, priceId, email

### API Endpoints
| Route | Lambda | Purpose |
|-------|--------|---------|
| `POST /auth/signup` | SignupFunction | Email/password registration → JWT |
| `POST /auth/login` | LoginFunction | Email/password login → JWT |
| `GET /auth/me` | MeFunction | Validate Bearer token, return user profile + tier |
| `GET /auth/oauth/{provider}` | OAuthStartFunction | Redirect to Google/Discord authorization |
| `GET /auth/oauth/{provider}/callback` | OAuthCallbackFunction | Exchange code, create/link user, redirect with JWT |
| `POST /checkout` | CreateCheckoutFunction | Create Stripe Checkout session (subscriptions require auth) |
| `POST /webhook` | WebhookFunction | Stripe webhook handler |
| `GET /counts` | GetCountsFunction | Public subscriber tier counts |

### Authentication Flow
- **JWT tokens**: HS256 signed with `allbyte-studio/jwt-secret` (Secrets Manager), 7-day expiry
- **Password hashing**: PBKDF2-HMAC-SHA256 (600k iterations), stored as `base64(salt):base64(hash)`
- **Client-side**: Token stored in `localStorage` key `"allbyte_token"`, sent as `Authorization: Bearer` header
- **Auth store**: `src/lib/auth.svelte.ts` — reactive Svelte 5 state with `initAuth()`, `login()`, `signup()`, `logout()`, `oauthLogin()`

### OAuth Flow (Google + Discord)
1. Frontend calls `oauthLogin("google"|"discord")` → redirects to `GET /auth/oauth/{provider}`
2. OAuthStartFunction reads client_id from Secrets Manager, generates HMAC-signed `state` param, returns 302 to provider
3. Provider redirects to `GET /auth/oauth/{provider}/callback` with auth code
4. OAuthCallbackFunction verifies state, exchanges code for access token, fetches user profile
5. Finds user by email (email-index) → links OAuth if existing, or creates new user
6. Signs JWT, redirects to `{SITE_DOMAIN}/#token={jwt}`
7. `initAuth()` reads token from URL hash, stores in localStorage, clears hash

**OAuth Secrets** (Secrets Manager):
- `allbyte-studio/google-oauth` — `{"client_id": "...", "client_secret": "..."}`
- `allbyte-studio/discord-oauth` — `{"client_id": "...", "client_secret": "..."}`
- `allbyte-studio/stripe-webhook-secret` — Stripe webhook signing secret (`whsec_...`)

**OAuth redirect URIs** (must match provider app config):
- Google: `https://api.allbyte.studio/auth/oauth/google/callback`
- Discord: `https://api.allbyte.studio/auth/oauth/discord/callback`

### Stripe Integration
- Subscription tiers: Initiate ($3), Hero ($7), Legend ($15) + donation amounts ($5/$10/$25)
- Stripe prices configured as CloudFormation parameters with defaults
- Checkout creates/links Stripe customer to user record
- Webhook updates subscription status in SubscriptionsTable
- Stripe secret key in Secrets Manager: `allbyte-studio/stripe-secret-key`

### CORS
API Gateway allows origins: `https://allbyte.studio`, `http://localhost:4321`. Methods: POST, GET, OPTIONS. Headers: Content-Type, Authorization.

## CI/CD
GitHub Actions (`.github/workflows/deploy.yml`): push to `main` triggers build + S3 sync + CloudFront invalidation. Uses OIDC for AWS auth (no stored secrets). Integration tests verify HTTP 200 and required headers (COEP/COOP/HSTS).

## Infrastructure
- **Frontend**: `infrastructure/cloudformation.yaml` — S3 bucket, CloudFront with OAC, ACM cert, budget alerts with auto-shutoff Lambda
- **Backend**: `infrastructure/stripe-backend.yaml` — Lambda functions, DynamoDB tables, API Gateway, IAM roles
- **GPU inference (planned, not deployed)**: `infrastructure/qwen-spot/README.md` — Qwen2.5-Coder-32B on EC2 Spot (g6.12xlarge, vLLM, multi-stream concurrent batching) sized for 2–3 concurrent leads. Recommended architecture: Arc stays on Claude Max, Nix/Port/Vera leads route to Qwen via `OPENAI_API_BASE`. Mirrors `allbyte-studio-cost-shutoff` pattern under `allbyte-studio-qwen-*`. Full plan: `~/.claude/plans/no-i-don-t-have-vivid-metcalfe.md`. Arc handoff: `C:/Users/drew/Desktop/GameDev/APP_CLAUDE_QWEN_AB_PROPOSAL.md`.

### Deploying Backend Changes
```bash
aws cloudformation deploy \
  --template-file infrastructure/stripe-backend.yaml \
  --stack-name allbyte-studio-stripe \
  --capabilities CAPABILITY_NAMED_IAM
```

## Deployment Notes
- Godot `/play` page requires SharedArrayBuffer headers (configured in CloudFront):
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- Place Godot HTML5 export files in `public/godot/`
- HTML files served with `max-age=0, must-revalidate`; versioned assets cached 1 year

### Godot key obfuscation (`scripts/obfuscate-godot-export.js`)
The Godot 4 web export ships its script-encryption key as 32 contiguous bytes
inside `index.wasm`. The obfuscator XORs that slot with a random per-release
mask and injects `<script src="pck-key-shim.js"></script>` ahead of the engine
loader; the shim intercepts the WASM fetch and XORs the bytes back so the
engine sees plaintext in linear memory. Static scanners (KeyDot etc.) get
nothing useful from the WASM on disk.

`npm run push-assets` runs the obfuscator before uploading `public/godot/` and
hard-aborts the deploy on any inconsistency. The obfuscator is idempotent:
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

## E2E Tests
Playwright-based E2E tests in `tests/e2e/` using pytest. The dev server must be running (`npm run dev`) before running tests. The `conftest.py` provides:
- `page` fixture: fresh Playwright Chromium page per test (1280×960 viewport)
- `mock_api` fixture: intercepts Lambda API calls with mock responses (auth, checkout, counts)
- Auto-screenshots on failure saved to `tests/e2e/test_results/`

## Conventions
- Art, music, and fonts are **never AI-generated** — they are handcrafted by AllByte
- AI (Claude) is used for code, infrastructure, and automation
- "AllByte" = the solo developer/owner; "AllByte Studios" = the studio name
- Engine side = monospace/terminal aesthetic; Heart side = serif/organic aesthetic
- All site copy and devlog posts use **first-person singular** ("I/my/me"), never "we/our/us" — AllByte is a solo developer

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
The webapp consumes these from `ChroniclesOfNesis/tickets/` (and a couple from the repo root). The dev SSE allowlist in `astro.config.mjs` is the source of truth for which files trigger live updates:
| File | Purpose | Schema version |
|------|---------|---------------|
| `tickets/tickets.json` | All tickets with phase, leads, success criteria, test specs | v2 |
| `tickets/epics.json` | Epic groupings (Milestone → Epic → Ticket) with `estimatedHours`, `acceptanceCriteria` | v1 |
| `tickets/dashboard.json` | Live expert/worker status, recent activity, test suite stats | — |
| `tickets/owner_questions.json` | Questions awaiting owner input (drives `/test/decisions/`) | — |
| `tickets/owner_answers.ndjson` | Append-only owner-answer stream (Arc tails this and applies to source-of-truth files) | — |
| `tickets/.answer_daemon_heartbeat.json` | Liveness signal for Arc's answer daemon | — |
| `test_index.json`, `test_roadmap.json` | Test catalog and roadmap | — |

A `verified:false` answer does **not** reopen the original ticket — Arc cuts a new ticket that references it.

`test_fixtures/manifest.json` lists save-state fixtures for the fixture picker.

### Migration in progress: beads (`bd`) → `bd_dashboard.json`
Arc is moving ticket tracking off the bespoke `tickets.json`/`epics.json`/`agents.json`/`agent_chat.ndjson`/`agent_activity.json` sprawl and onto [gastownhall/beads](https://github.com/gastownhall/beads) (`bd` CLI). Per-agent visibility (the old `/test/agents/` + `/test/agent-chat/` surfaces) was labelled a failed experiment on 2026-05-16 and removed; the dev console now surfaces epic-level state only. Once Arc's bridge ships, `bd_dashboard.json` will collapse `tickets.json` + `epics.json` + `dashboard.json` into one read; `/test/tickets/` and ConsoleOverview's epic section will rewire to it. Spec: `Desktop\GameDev\CON_CLAUDE_BEADS_DASHBOARD_BRIDGE_SPEC.md`. AppC reply: `APP_CLAUDE_BEADS_DASHBOARD_BRIDGE_REPLY.md` in the same dir.

### Cross-Claude Communication
Coordination files live in `C:\Users\drew\Desktop\GameDev\` (host-side mount of `/workspace/GameDev/`):
- `SAVE_SYNC_INTEGRATION.md` — postMessage protocol contract for save sync
- `WEB_DEPLOY_QUESTIONS.md` — Q&A about deploying the web export
- `CON_CLAUDE_FIXTURE_RESPONSE.md` — fixture format and TestBridge hooks
- `CLAUDE_COORDINATION.md` — coordination protocol and change boundaries

When you need to ping Arc, leave a markdown file in that directory and (optionally) send a tmux message via `docker exec --user dev tactical-dev tmux send-keys -t 0 "[App Claude] ..."` followed by Enter to interrupt their session.

### Dev Console Data Integration
The Dev Console (`/test/`) renders Arc's ticket data:
- **Local dev:** Near real-time polling (seconds). Vite proxy serves JSON directly from Chronicles repo.
- **Prod:** Light real-time (~60s-5min). JSON synced to S3 via `npm run push-assets`.
- **Fixture picker:** Reads `test_fixtures/manifest.json`, sends `{type: "load_fixture", path: "..."}` via postMessage to Godot iframe.
- **Estimation rollups:** Epic `estimatedHours` rolled up by epic and milestone for effort-vs-priority view.
- **Ticket detail:** Show current phase, lead signoffs, success criteria with paired test specs. No per-ticket phase history — aggregate analytics for bottleneck analysis only.
