# AllByte Studios — web portal

The website and platform for **AllByte Studios**, a solo indie studio building
**[The Chronicles of Nesis](https://allbyte.studio/chronicles_of_nesis/)**, a
tactical turn‑based RPG in Godot 4 that you can **play in your browser** — no
download, no install.

**Live:** [allbyte.studio](https://allbyte.studio) · **Play it now:** [allbyte.studio/play](https://allbyte.studio/play/)

The site embodies a "High‑Tech Artisan" split identity: **AI‑assisted
engineering** (code, infrastructure, QA, automation) paired with **100 %
handcrafted** art, music, and typography. That contrast runs through the whole
product — including the landing page, which is literally split down the middle.

> **Game developers:** this repo doubles as a small set of open-source Godot
> tools — [see the index](#-open-source-tools-for-godot-developers). The flagship is the
> [browser game build & deploy pipeline](#-the-web-game-pipeline-for-game-devs).
> It takes a Godot game from source to a cross‑origin‑isolated, key‑obfuscated,
> browser‑playable build on a CDN — fully hands‑off. Jump to that section.

---

## Table of contents

- [Feature tour](#feature-tour) — every page, linked
- [🧰 Open-source tools](#-open-source-tools-for-godot-developers) — reusable Godot dev tooling
- [Tech stack](#tech-stack)
- [Architecture](#architecture)
- [🎮 The web game pipeline (for game devs)](#-the-web-game-pipeline-for-game-devs)
- [Backend & API](#backend--api)
- [Development](#development)
- [Deployment & CI/CD](#deployment--cicd)
- [Repository layout](#repository-layout)
- [License](#license)

---

## 🧰 Open-source tools for Godot developers

This repo is also where AllByte open-sources the reusable tooling built while
shipping a Godot game to the browser — grab any piece on its own (all
[MIT](#license)):

| Tool | What it does |
|------|--------------|
| **[Web game build & deploy pipeline](#-the-web-game-pipeline-for-game-devs)** | Godot source → a cross-origin-isolated, key-obfuscated, browser-playable build on a CDN, hands-off: runtime-published channels, edge-gating for paid content, and deploys that boot-test themselves. Porting guide: [`docs/BRING_YOUR_OWN_GAME.md`](./docs/BRING_YOUR_OWN_GAME.md); runbook: [`DEPLOY.md`](./DEPLOY.md). |
| **[Godot web-export key obfuscator](./scripts/obfuscate-godot-export.js)** | Godot ships the PCK script-encryption key as 32 bytes inside `index.wasm`, where static scanners can lift it. This XORs those bytes with a per-release mask and injects a fetch-time shim that un-masks them in memory — the WASM on disk yields nothing. Idempotent; drops into any Godot 4 web export. |
| **[Godot 3 → 4 `.tscn` / `.tres` migrator](./scripts/migrate_g3_to_g4_tscn.py)** | Mechanizes the *silent-failure* class of G3→G4 breakage — the renames that parse cleanly in Godot 4 but quietly do nothing (`Sprite`→`Sprite2D`, `custom_*`→`theme_override_*`, `shader_param`→`shader_parameter`, StyleBoxTexture margins, missing font-size overrides, …). `--check` dry-runs, `--apply` rewrites. The story: [Godot 3.6 → 4.6: A Migration Built on Silent Failures](https://allbyte.studio/devlog/godot-3-to-4-retrospective/). |

The pipeline's own supporting scripts (deploy, analytics, smoke tests) live under [the pipeline section](#-the-web-game-pipeline-for-game-devs) and in [`DEPLOY.md`](./DEPLOY.md).

---

## Feature tour

### Public site
| Page | What it is |
|------|-----------|
| [`/`](https://allbyte.studio/) | **Bilateral landing** — a vertical split‑screen: "The Engine" (dark, technical, monospace) vs "The Heart" (warm, artisan, ModernGoth serif). Panels expand on hover; stacks on mobile. |
| [`/play`](https://allbyte.studio/play/) | **Play in browser** — the Godot 4 WebAssembly build, running in a cross‑origin‑isolated iframe. Tier‑aware build picker (Alpha / Beta / debug). |
| [`/chronicles_of_nesis`](https://allbyte.studio/chronicles_of_nesis/) | The game's story/pitch page. |
| [`/walkthrough`](https://allbyte.studio/walkthrough/) | A scene‑by‑scene visual map of the game (video + stills of every scene, magazine‑scroll layout). |
| [`/artwork`](https://allbyte.studio/artwork/) | Sprite gallery — Allies / Enemies / Bosses, animated GIFs generated from sprite sheets. |
| [`/music`](https://allbyte.studio/music/) | Original soundtrack with a persistent cross‑page music player. |
| [`/fonts`](https://allbyte.studio/fonts/) | Showcase of **ModernGoth**, the studio's hand‑built typeface. |

### Devlog
A three‑stream devlog; every post gets an auto‑generated table of contents.
| Page | Stream |
|------|--------|
| [`/devlog`](https://allbyte.studio/devlog/) | Hub / all posts |
| [`/devlog/chronicles`](https://allbyte.studio/devlog/chronicles/) | Chronicles of Nesis game development |
| [`/devlog/godot-and-claude`](https://allbyte.studio/devlog/godot-and-claude/) | Godot + AI pair‑programming |
| [`/devlog/studio`](https://allbyte.studio/devlog/studio/) | Studio platform & infrastructure |
| [`/self-hosting-with-claude`](https://allbyte.studio/self-hosting-with-claude/) | Long‑form architecture + cost writeup of this whole stack |
| [`/changelog`](https://allbyte.studio/changelog/) | Deploy history / release notes |

### Membership & community
| Page | What it is |
|------|-----------|
| [`/subscribe`](https://allbyte.studio/subscribe/) | Membership tiers — Initiate / Hero / Legend + one‑time support (Stripe Checkout today; Patreon migration planned). |
| [`/legends_square`](https://allbyte.studio/legends_square/) | Legend‑tier private post board (auth‑gated). |

### Dev Console (`/test/*`) — subscriber/admin‑gated
An engine‑themed dashboard that surfaces the game‑side agent's live project data.
| Page | View |
|------|------|
| [`/test`](https://allbyte.studio/test/) | Console overview — epics, test stats, milestones |
| `/test/tickets` | Milestone → Epic → Ticket tree |
| `/test/tests` | Test management |
| `/test/decisions` | Owner Q&A / decision queue |
| `/test/milestones/view`, `/test/view` | Detail views |
| `/test/play-funnel` | Play‑analytics funnel (bot‑filtered) |
| `/test/marketing-queue` | Marketing post pipeline |

### Admin & legal
| Page | |
|------|--|
| `/admin/users` | User management (admin only) |
| [`/privacy`](https://allbyte.studio/privacy/), [`/terms`](https://allbyte.studio/terms/) | Legal |

---

## Tech stack

- **[Astro 6](https://astro.build)** static SSG + **[Svelte 5](https://svelte.dev)** (runes) interactive islands
- **Tailwind CSS v4** (via the Vite plugin — no config file)
- Custom **ModernGoth** typeface (`AllByteCustom` font‑family)
- **AWS S3 + CloudFront** hosting; **Lambda + DynamoDB + API Gateway** backend
- **CloudFormation** for all infrastructure; **GitHub Actions + OIDC** for CI/CD (no stored cloud keys)
- The game: **Godot 4**, exported to **WebAssembly**

---

## Architecture

- **Layout** — every page uses `BaseLayout.astro`: Astro `ClientRouter` for
  smooth transitions, a persistent `MusicPlayer` island that survives
  navigation (`transition:persist`), and the dual‑theme global CSS.
- **Dual theme** — CSS variables define an **Engine** theme (dark/technical) and
  a **Heart** theme (warm/artisan); components take a `theme` prop to match context.
- **Music player** — a cross‑page singleton driven by custom events, state in
  `sessionStorage`, exposed on `window` for cross‑component sync.
- **Content collections** — devlog posts are Markdown with a typed frontmatter
  schema (`category`, `devlog` stream, `tags`, `heroImage`, `draft`).
- **Cross‑origin isolation** — `/play` sets COOP/COEP so the Godot iframe can use
  `SharedArrayBuffer` (required by the WASM build). Enforced by CloudFront in
  prod and dev middleware locally.

Full narrative + cost breakdown: **[Self‑Hosting with Claude](https://allbyte.studio/self-hosting-with-claude/)**.

---

## 🎮 The web game pipeline (for game devs)

This is the part most likely to be useful to another Godot developer: **how a
tactical RPG gets from source to a browser‑playable build on a CDN, automatically.**
If you've ever wanted to ship a Godot game people can just *click and play*, this
is a working reference. See **[`DEPLOY.md`](./DEPLOY.md)** for the operational runbook.

### The idea

A Godot 4 game exported to **WebAssembly** runs in any modern browser — no
install, no store, no 30 % platform cut. The catches, and how they're handled here:

1. **`SharedArrayBuffer` needs cross‑origin isolation.** The engine needs
   threads, which need `SharedArrayBuffer`, which the browser only grants when
   the page sends `Cross-Origin-Opener-Policy: same-origin` +
   `Cross-Origin-Embedder-Policy: require-corp`. Those headers come from
   CloudFront (a response‑headers policy) and are mirrored by dev middleware.

2. **Your code is sitting on a public CDN.** A Godot web export ships its
   compiled scripts in a `.pck` pack. You can encrypt the pack, but the engine
   needs the key at runtime — so the key ends up *inside `index.wasm`*. Static
   scanners can pull it straight out. This repo's obfuscator
   ([`scripts/obfuscate-godot-export.js`](./scripts/obfuscate-godot-export.js))
   XORs those 32 key bytes with a random per‑release mask and injects a tiny
   shim (`pck-key-shim.js`) that un‑masks them in memory at fetch time. Static
   analysis of the WASM on disk gets nothing useful. *(This raises the bar
   against casual extraction; a determined runtime attacker can still dump the
   key from a live browser — that's inherent to shipping playable code.)*

3. **You want more than one build.** The pipeline models **channels** — a
   content axis (Demo, free vs Beta+, members) × a debug axis (players vs
   Legend/dev builds), plus a bleeding‑edge `develop` channel. Each channel is a
   path under `/godot/`; which builds are live is published at **runtime** via
   `/godot/channels.json`, so nothing needs a rebuild to flip a build on.

   | channel | label | who | how it's gated |
   |---------|-------|-----|----------------|
   | `alpha` | **Demo** | everyone, free | not gated |
   | `alpha-debug` | Demo (Debug) | Legend+ | client‑side only (debug chrome, low stakes) |
   | `beta` | Beta | Initiate+ | **CloudFront signed cookies** — enforced at the edge, per asset fetch |
   | `beta-debug` | Beta (Debug) | Legend+ | dev lane, deliberately open |
   | `develop` | Develop (Debug) | Legend+ | dev lane, deliberately open |

4. **Paid content needs a server‑side gate — a client tier check is UI, not
   security.** Two real gates here: gated zone `.pck`s live in a **private
   bucket** and are fetched via short‑lived presigned URLs from a
   tier‑checking Lambda (`GET /pck-url`); the Beta base build sits behind a
   CloudFront behavior with **trusted key groups** — a small endpoint verifies
   your membership tier and issues signed cookies, and the CDN itself refuses
   anonymous requests. The webapp only decides what to *offer*; the edge
   decides what to *serve*.

5. **Every deploy proves itself.** Each channel deploy ends with a smoke that
   actually boots the deployed bytes in a headless browser and asserts the
   engine reaches a scene with no decryption/MD5 errors — plus, in CI, a
   post‑deploy matrix (Chromium/WebKit × Linux/macOS) that starts a NEW GAME
   and moves the player, and a per‑channel smoke driven by the live
   `channels.json`. A deploy that doesn't boot marks itself failed.

### The cloud build ("push source, get a deployed game")

The headline: **a push to the game's `develop` branch builds and deploys the
browser game with no human in the loop, and without the developer's machine
being involved at all.**

```
git push (develop)
      │  GitHub webhook
      ▼
AWS CodeBuild  ── pulls PRIVATE game source via a scoped GitHub connection
      │           runs inside a pinned image: Godot 4 headless + web templates
      ▼
  cloud_export.sh   import → export bootstrap + asset packs → engine‑native gate
      │
      ▼
  push-channel.js   verify SHA‑256 → obfuscate key → gzip WASM → sync to S3
      │             → publish channels.json → invalidate CloudFront
      ▼
  https://…/godot/develop/   ← live, browser‑playable
```

Design choices a game dev might care about:

- **Build from source, not artifacts.** Only source crosses the wire (git is a
  fine transport for source, a bad one for 90 MB of regenerated binaries). The
  heavy artifacts are born on the build box, right next to the CDN bucket.
- **No credentials on anyone's laptop.** CodeBuild uses an **IAM role**; the
  Godot encryption key lives in **AWS Secrets Manager** and is injected as a
  masked env var. The role is scoped so it can write **only** the `develop`
  path — a bad build physically cannot touch the live game.
- **The build image is open, the key and source are not.** The exporter image
  (Godot + templates + the deploy scripts) is built by a GitHub Action via
  **OIDC** (no stored keys) and pushed to ECR. It contains tooling only — never
  the game source, never the key.
- **A quality gate blocks bad deploys.** An engine‑native headless test suite
  runs before publish; a failed gate refuses the deploy rather than shipping a
  broken build.
- **Fast local lane, too.** A host‑side watcher
  ([`scripts/deploy-watcher.js`](./scripts/deploy-watcher.js)) can deploy a
  locally‑built channel the same way, for iteration.

Infrastructure for the above:
- [`deploy/godot-export-codebuild.yaml`](./deploy/godot-export-codebuild.yaml) — CodeBuild project, least‑privilege IAM, webhook, Secrets wiring, log metric + alarm
- [`deploy/exporter-image-ci.yaml`](./deploy/exporter-image-ci.yaml) — the OIDC role that lets CI push the exporter image
- [`docker/exporter/Dockerfile`](./docker/exporter/Dockerfile) — the Godot exporter image
- [`.github/workflows/exporter-image.yml`](./.github/workflows/exporter-image.yml) — build + push the image via OIDC
- [`scripts/push-channel.js`](./scripts/push-channel.js) — the one channel‑driven deployer
- [`scripts/gate-beta-behavior.js`](./scripts/gate-beta-behavior.js) — scripted CloudFront edge‑gate for the Beta channel

Want to reuse this stack for **your own Godot web game**? Start with
**[`docs/BRING_YOUR_OWN_GAME.md`](./docs/BRING_YOUR_OWN_GAME.md)** — every
AllByte‑specific coupling point, and what you'd swap. The security posture of
the whole pipeline (threat model, controls, residual risk) is written up in
**[`docs/security-review-game-pipeline.md`](./docs/security-review-game-pipeline.md)**.

---

## Backend & API

All backend infra is a single CloudFormation template
(kept private — not in this repo) of inline Python Lambdas behind an HTTP
API at `https://api.allbyte.studio`.

- **Auth** — email/password (PBKDF2‑HMAC‑SHA256, 600k iterations) + **OAuth**
  (Google, Discord). JWT (HS256, 7‑day) in `localStorage`, sent as `Bearer`.
- **Membership** — Stripe Checkout for tiers + one‑time support; a webhook keeps
  subscription status in DynamoDB. *(Patreon migration planned.)*
- **DynamoDB** — `allbyte-studio-users` (email GSI) and
  `allbyte-studio-subscriptions`.
- **Analytics** — a play‑funnel beacon pipeline (a private standalone stack,
  no IP stored) plus CloudFront‑log site traffic, both with datacenter/bot filtering.

| Route | Purpose |
|-------|---------|
| `POST /auth/signup` · `POST /auth/login` · `GET /auth/me` | Email/password auth + profile |
| `GET /auth/oauth/{provider}` · `.../callback` | Google / Discord OAuth |
| `POST /checkout` · `POST /webhook` | Stripe checkout + webhook |
| `GET /counts` | Public subscriber tier counts |

---

## Development

```bash
npm install
npm run dev            # Astro dev server on 0.0.0.0:4321 (reachable on LAN)
npm run build          # sync assets + production build → dist/
npm run preview        # preview the production build

npm run sync           # pull game assets from the local Godot project
npm run push-assets    # obfuscate + upload the game build to S3
npm run test:e2e       # Playwright + pytest E2E (dev server must be running)
npm run test:a11y      # WCAG 2.1 AA checks
```

Deploy‑pipeline commands (see [`DEPLOY.md`](./DEPLOY.md)):

```bash
npm run deploy-watcher       # host‑side watcher for the local fast lane
node scripts/push-channel.js --manifest <path> [--promote] [--dry-run]
```

---

## Deployment & CI/CD

- **Site** — every push to `main` triggers the `Deploy to AWS` GitHub Action:
  build → S3 sync → CloudFront invalidation, authenticated via **OIDC** (no
  stored secrets). Integration checks assert HTTP 200 + the required
  COOP/COEP/HSTS headers.
- **Game (`develop`)** — a push to the game repo's `develop` branch triggers the
  CodeBuild pipeline above.
- **Exporter image** — changes to the Dockerfile or the baked deploy scripts
  rebuild the exporter image via OIDC and keep the deployed copies in sync.

---

## Repository layout

```
src/
  pages/        Astro routes (see Feature tour)
  components/   Svelte islands + Astro components
  layouts/      BaseLayout, Bilateral, Footer
  lib/          reactive stores (auth, saves), data layer, gameVersions, tiers
  content/      devlog Markdown collections
  data/         generated game/version/asset metadata (committed)
scripts/        asset sync, obfuscation, deploy pipeline, Godot 3→4 migrator
deploy/         reusable game-deploy IaC (CodeBuild exporter + image-CI role)
docker/exporter Godot exporter image
                (private site/business infra lives in an untracked infrastructure/)
.github/        deploy + exporter-image + QA workflows
DEPLOY.md       game-build deploy runbook
```

---

## License

Source code is [MIT](./LICENSE). The creative and proprietary works in this repo
— art, sprites, music, fonts (including ModernGoth), the compiled game build, and
written devlog/site content — are © AllByte Studios, all rights reserved. See
[`NOTICE`](./NOTICE) for the exact scope carve‑out.
