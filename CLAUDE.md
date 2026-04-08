# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview
Web portal for AllByte Studios, an indie game studio building a fantasy tactical RPG in Godot 3.5. The site embodies a "High-Tech Artisan" dual identity: AI-assisted engineering + 100% handcrafted art, music, and typography.

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
- `/self-hosting-with-claude` — Infrastructure article
- `/devlog/` — Devlog posts (planned, schema defined)

### Content Collections
- **Devlogs** (`src/content/devlogs/`): Markdown posts with frontmatter schema
  - `category`: `"technical"` or `"creative"`
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
  --stack-name allbyte-studio-backend \
  --capabilities CAPABILITY_NAMED_IAM
```

## Deployment Notes
- Godot `/play` page requires SharedArrayBuffer headers (configured in CloudFront):
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- Place Godot HTML5 export files in `public/godot/`
- HTML files served with `max-age=0, must-revalidate`; versioned assets cached 1 year

## Conventions
- Art, music, and fonts are **never AI-generated** — they are handcrafted by AllByte
- AI (Claude) is used for code, infrastructure, and automation
- "AllByte" = the solo developer/owner; "AllByte Studios" = the studio name
- Engine side = monospace/terminal aesthetic; Heart side = serif/organic aesthetic
