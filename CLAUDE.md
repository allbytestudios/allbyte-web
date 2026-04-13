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
npm run dev                           # Start dev server (localhost:4321)
npm run build                         # Sync assets + production build → dist/
npm run preview                       # Preview production build locally
npm run sync                          # Pull assets from Godot project
npm run push-assets                   # Upload generated assets to S3
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
- `/test/` — Dev Console (engine-themed dashboard for tests, agents, tickets, milestones)
  - `/test/tickets/` — Collapsible tree view of milestones → epics → tickets
  - `/test/tests/`, `/test/agents/` — Test and agent management views
- `/admin/users` — Admin user management

### Content Collections
- **Devlogs** (`src/content/devlogs/`): Markdown posts with frontmatter schema
  - `category`: `"technical"` | `"creative"`
  - `devlog`: `"chronicles"` | `"godot-and-claude"` | `"studio"` — determines which sub-blog the post appears under
  - `tags`: string array (optional)
  - `heroImage`: string (optional)
  - See `src/content.config.ts` for full schema

### Asset Sync
Game assets are pulled from the local Godot project (`TacticalTestDev`) via `scripts/sync-assets.js`.
Configuration in `scripts/asset-manifest.json`. Sprite sheets converted to GIFs via `scripts/spritesheet-to-gif.py`.
Generated data files: `src/data/game-version.json`, `src/data/asset-index.json`, `src/data/sprite-gifs.json`.
All generated files committed to git (CI has no Godot access). Sync gracefully skips if Godot project not found.

## Backend (Lambda + DynamoDB + API Gateway)

All backend infrastructure is defined in `infrastructure/stripe-backend.yaml` as inline Python 3.12 Lambda functions within a CloudFormation template. The API Gateway V2 (HTTP API) is at `https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com`.

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
- Google: `https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com/auth/oauth/google/callback`
- Discord: `https://wj3xkrm1r1.execute-api.us-east-1.amazonaws.com/auth/oauth/discord/callback`

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

Arc is Drew's primary interface for the game side. Tickets follow: `PLANNING → TECH REVIEW → READY → IN PROGRESS → TESTING → DONE`. Each lead can spawn workers within a slot budget.

### Data Files Arc Publishes
The webapp consumes these from `ChroniclesOfNesis/tickets/`:
| File | Purpose | Schema version |
|------|---------|---------------|
| `tickets.json` | All tickets with phase, leads, success criteria, test specs | v2 |
| `epics.json` | Epic groupings (Milestone → Epic → Ticket) with `estimatedHours`, `acceptanceCriteria` | v1 |
| `dashboard.json` | Live expert/worker status, recent activity, test suite stats | — |
| `agents.json` | Expert definitions, prompt files, worker history | v1 |

Additionally, `test_fixtures/manifest.json` will list save-state fixtures for the fixture picker.

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
