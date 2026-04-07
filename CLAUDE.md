# AllByte Studios Web Portal

## Project Overview
Web portal for AllByte Studios, an indie game studio building a fantasy tactical RPG in Godot 3.5. The site embodies a "High-Tech Artisan" dual identity: AI-assisted engineering + 100% handcrafted art, music, and typography.

## Tech Stack
- **Framework:** Astro 6 (static SSG) + Svelte 5 (interactive islands)
- **Styling:** Tailwind CSS v4 (via `@tailwindcss/vite` plugin)
- **Custom Font:** ModernGoth (`public/fonts/ModernGoth.otf`) — registered as `AllByteCustom` font-family
- **Package Manager:** npm
- **Deployment:** Static build → AWS S3 + CloudFront

## Commands
```bash
npm run dev       # Start dev server (localhost:4321)
npm run build     # Production build → dist/
npm run preview   # Preview production build locally
```

## Architecture

### Bilateral Layout
The landing page is a vertical split-screen:
- **Left: "The Engine"** — Technical/dark terminal theme, monospace font, blueprint grid
- **Right: "The Heart"** — Artistic/bespoke theme, ModernGoth custom font, warm parchment tones

Panels expand/contract on hover (60/40 split) via CSS grid transitions. Stacks vertically on mobile (<768px).

### Key Components
| Component | Purpose |
|-----------|---------|
| `BilateralLayout.svelte` | Split-screen container with hover logic |
| `EnginePanel.svelte` | Left panel — tech content + SystemStatus |
| `HeartPanel.svelte` | Right panel — creative content + StripeButton |
| `SystemStatus.svelte` | Service status widget (placeholder, future API) |
| `StripeButton.svelte` | "Join the Studio" subscription button (Stripe TODO) |
| `GodotEmbed.svelte` | Godot 3.5 WASM game container at `/play` |

### Content Collections
- **Devlogs** (`src/content/devlogs/`): Markdown posts with frontmatter schema
  - `category`: `"technical"` or `"creative"`
  - See `src/content.config.ts` for full schema

### Routes
- `/` — Bilateral landing page
- `/play` — Godot HTML5 game embed

## Deployment Notes
- Godot `/play` page requires SharedArrayBuffer headers on CloudFront:
  - `Cross-Origin-Opener-Policy: same-origin`
  - `Cross-Origin-Embedder-Policy: require-corp`
- Place Godot HTML5 export files in `public/godot/`

## Conventions
- Art, music, and fonts are **never AI-generated** — they are handcrafted by AllByte
- AI (Claude) is used for code, infrastructure, and automation
- "AllByte" = the solo developer/owner; "AllByte Studios" = the studio name
- Engine side = monospace/terminal aesthetic; Heart side = serif/organic aesthetic
