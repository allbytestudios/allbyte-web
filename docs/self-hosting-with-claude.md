# Self-Hosting with Claude: Astro Static Site on AWS

A step-by-step guide for deploying a static Astro site to AWS with CI/CD, written as a reference for the AllByte Studios web portal. This entire infrastructure was built with Claude as the AI pair-programmer.

## Architecture Overview

```
GitHub (push to main)
    |
    v
GitHub Actions (OIDC auth, no stored secrets)
    |
    v
npm ci && npm run build
    |
    v
aws s3 sync dist/ -> S3 Bucket
    |
    v
CloudFront CDN (HTTPS, caching, custom headers)
    |
    v
allbyte.studio (your domain)
```

## Cost Estimate (Low Traffic)

| Service | Monthly Cost |
|---------|-------------|
| S3 (static hosting) | ~$0.02 |
| CloudFront CDN | ~$0.00-0.50 (1TB free first year) |
| ACM Certificate (HTTPS) | Free |
| Route 53 (DNS, optional) | $0.50/zone |
| GitHub Actions (CI/CD) | Free (2,000 min/mo) |
| Cost protection (Budget + Lambda + SNS) | Free |
| **Total** | **~$0.50-1.00/mo** |

## Prerequisites

- AWS account with admin access
- GitHub repository
- Domain name (we use `allbyte.studio`)
- Node.js 20+
- AWS CLI (`winget install Amazon.AWSCLI`)
- GitHub CLI (`winget install GitHub.cli`)

## Tech Stack

- **Astro 6** - Static site generator
- **Svelte 5** - Interactive UI components
- **Tailwind CSS v4** - Styling (via `@tailwindcss/vite`)
- **AWS S3** - Static file hosting
- **AWS CloudFront** - CDN with HTTPS
- **AWS ACM** - Free SSL/TLS certificate
- **GitHub Actions** - CI/CD pipeline
- **OIDC Federation** - Secure AWS auth (no long-lived keys)

## Step 1: Project Setup

```bash
# Initialize project
npm init -y
npm install astro @astrojs/svelte svelte @tailwindcss/vite tailwindcss

# Update package.json scripts
# "dev": "astro dev"
# "build": "astro build"
# "preview": "astro preview"
```

### astro.config.mjs
```javascript
import { defineConfig } from "astro/config";
import svelte from "@astrojs/svelte";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  integrations: [svelte()],
  vite: {
    plugins: [tailwindcss()],
  },
});
```

## Step 2: AWS Infrastructure (CloudFormation)

The entire AWS infrastructure is defined in a single CloudFormation template: `infrastructure/cloudformation.yaml`

### What it creates:
1. **S3 Bucket** - Private bucket for static files (no public access)
2. **CloudFront Distribution** - CDN with HTTPS, caching, error handling
3. **Origin Access Control (OAC)** - Secure S3 access from CloudFront only
4. **ACM Certificate** - Free SSL cert for your domain + www subdomain
5. **Response Headers Policy** - Adds `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers (required for SharedArrayBuffer / Godot WASM)
6. **GitHub OIDC Provider** - Allows GitHub Actions to assume an IAM role without storing AWS keys
7. **IAM Deploy Role** - Scoped permissions for S3 sync and CloudFront invalidation only

### Deploy the stack

```bash
# Must be us-east-1 (ACM certs for CloudFront require it)
aws cloudformation deploy \
  --template-file infrastructure/cloudformation.yaml \
  --stack-name allbyte-studio-site \
  --capabilities CAPABILITY_NAMED_IAM \
  --region us-east-1
```

The stack will pause at the ACM certificate step waiting for DNS validation.

## Step 3: DNS Validation

After starting the CloudFormation deploy:

1. Get the validation CNAME records:
```bash
aws acm list-certificates --region us-east-1 \
  --query 'CertificateSummaryList[?DomainName==`allbyte.studio`].CertificateArn' \
  --output text

# Use the ARN from above
aws acm describe-certificate \
  --certificate-arn <ARN> \
  --region us-east-1 \
  --query 'Certificate.DomainValidationOptions[*].[DomainName,ResourceRecord.Name,ResourceRecord.Value]' \
  --output table
```

2. Add the CNAME records at your domain registrar (Namecheap, Cloudflare, etc.)
3. Wait for validation (usually 5-30 minutes)
4. CloudFormation will continue automatically once validated

## Step 4: Point Domain to CloudFront

After the stack completes, get the CloudFront domain:

```bash
aws cloudformation describe-stacks \
  --stack-name allbyte-studio-site \
  --region us-east-1 \
  --query 'Stacks[0].Outputs'
```

Add DNS records at your registrar:
- `allbyte.studio` -> CNAME (or ALIAS) to `<distribution-id>.cloudfront.net`
- `www.allbyte.studio` -> CNAME to `<distribution-id>.cloudfront.net`

## Step 5: GitHub Actions CI/CD

### Add GitHub Secrets

Go to your repo **Settings -> Secrets and variables -> Actions** and add:

| Secret | Value (from stack outputs) |
|--------|--------------------------|
| `AWS_DEPLOY_ROLE_ARN` | `DeployRoleArn` output |
| `AWS_S3_BUCKET` | `BucketName` output |
| `AWS_CLOUDFRONT_DISTRIBUTION_ID` | `DistributionId` output |

### Workflow: `.github/workflows/deploy.yml`

The workflow:
1. Checks out code
2. Sets up Node.js 20 with npm caching
3. Runs `npm ci` and `npm run build`
4. Authenticates to AWS via OIDC (no stored credentials)
5. Syncs `dist/` to S3 with smart cache headers:
   - Static assets (JS, CSS, images): `max-age=31536000, immutable`
   - HTML/JSON: `max-age=0, must-revalidate` (always fresh)
6. Invalidates CloudFront cache

Every push to `main` triggers a deploy automatically.

## Step 6: Verify

```bash
# Check stack outputs
aws cloudformation describe-stacks \
  --stack-name allbyte-studio-site \
  --region us-east-1 \
  --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
  --output table

# Test the site
curl -I https://allbyte.studio

# Verify SharedArrayBuffer headers (needed for Godot)
curl -sI https://allbyte.studio | grep -i "cross-origin"
# Should show:
# cross-origin-opener-policy: same-origin
# cross-origin-embedder-policy: require-corp
```

## OIDC vs Access Keys

This setup uses **OIDC federation** instead of IAM access keys:

| | OIDC | Access Keys |
|---|---|---|
| Stored secrets | None | AWS_ACCESS_KEY_ID + SECRET |
| Token lifetime | ~1 hour (per job) | Until manually rotated |
| Rotation needed | No | Yes (security risk if leaked) |
| Scope | Locked to repo + branch | Wherever keys are used |

OIDC is the recommended approach. The IAM role's trust policy restricts access to only `AllByteStudios/allbyte-web` on the `main` branch.

## Cost Protection (Auto-Shutoff)

The CloudFormation template includes a kill switch to prevent surprise bills:

- **AWS Budget** monitors monthly spend ($25 threshold)
- **At 80%** ($20): email warning via SNS
- **At 100%** ($25): SNS triggers a Lambda that disables the CloudFront distribution
- Site goes down instead of charging you. Re-enable manually in CloudFront console.

All free tier: Lambda, SNS, and Budgets cost nothing at this scale.

CloudFront also includes **AWS Shield Standard** (free) for basic DDoS protection at layers 3/4.

## Troubleshooting

### CloudFormation fails on ResponseHeadersPolicy
Policy names can't contain dots. Use dashes or underscores (e.g., `allbyte-studio-headers` not `allbyte.studio-headers`).

### Stack stuck in ROLLBACK_COMPLETE
Delete it first, then redeploy:
```bash
aws cloudformation delete-stack --stack-name allbyte-studio-site --region us-east-1
# Wait ~30 seconds
aws cloudformation deploy ...
```

### ACM certificate stuck pending
DNS validation records must match exactly. Check for trailing dots and ensure the records are CNAME type, not TXT.

### Audio not playing on hover
Browsers require a user click before allowing audio playback (autoplay policy). The site unlocks audio on the first click anywhere on the page.

### CSS variables not applying (Tailwind v4)
With Astro + Tailwind v4, use `<style is:global>` in your layout to ensure CSS variables reach Svelte components. Scoped styles won't propagate custom properties.

## File Structure

```
allbyte-web/
├── .github/workflows/
│   └── deploy.yml              # CI/CD pipeline
├── infrastructure/
│   └── cloudformation.yaml     # All AWS resources
├── public/                     # Static assets (copied as-is)
├── src/
│   ├── components/             # Svelte interactive components
│   ├── content/devlogs/        # Markdown blog posts
│   ├── layouts/                # Astro page layouts
│   ├── pages/                  # Route pages
│   └── styles/                 # Global CSS + theme variables
├── astro.config.mjs
├── CLAUDE.md                   # Claude Code project context
└── package.json
```

## Design Decisions & Patterns

### Astro + Svelte: Why Both?
Astro handles static page generation (SEO, fast initial load, content collections for devlogs). Svelte handles the interactive bits — hover effects, audio playback, login modal, image swaps. Astro's `client:load` directive hydrates Svelte components only when needed.

### Tailwind CSS v4 Integration
Tailwind v4 dropped the `@astrojs/tailwind` integration. Instead, use the Vite plugin directly:
```javascript
// astro.config.mjs
import tailwindcss from "@tailwindcss/vite";
export default defineConfig({
  vite: { plugins: [tailwindcss()] },
});
```
Import in your layout with `<style is:global>` so CSS custom properties propagate to Svelte components.

### CSS Variable Gotcha
Svelte component styles are scoped. If you define `:root` variables in a scoped `<style>` block in Astro, Svelte components can't see them. Two fixes:
1. Use `<style is:global>` in your layout (what we do)
2. Hardcode values directly in Svelte component styles as a fallback

### Static Asset Handling
Files in `public/` are copied as-is to `dist/` at build time. This is where game assets (gifs, audio, fonts, images) go. They're served from the S3 bucket root via CloudFront.

### GIF Loop Fix
Many GIF editors export without the NETSCAPE loop extension, so they play once and stop. Fix without re-encoding (preserves quality):
```python
import struct
with open('input.gif', 'rb') as f:
    data = f.read()
flags = data[10]
gct_size = 3 * (2 ** ((flags & 0x07) + 1)) if flags & 0x80 else 0
insert_pos = 6 + 7 + gct_size
loop_ext = b'\x21\xff\x0b' + b'NETSCAPE2.0' + b'\x03\x01' + struct.pack('<H', 0) + b'\x00'
with open('output.gif', 'wb') as f:
    f.write(data[:insert_pos] + loop_ext + data[insert_pos:])
```

### Pixel Art Scaling
Use `image-rendering: pixelated` on any pixel-art images scaled beyond their native resolution. Without it, browsers apply bilinear filtering which makes pixel art blurry.

### Browser Audio Autoplay Policy
Browsers block audio playback until a user gesture (click/tap). Hover alone doesn't count. Pattern:
1. Listen for first `click` event on the page
2. Initialize Audio objects and unlock them on that click
3. Subsequent hover-triggered `play()` calls work after that

```javascript
let audioReady = false;
function initAudio() {
  if (audioReady) return;
  audioReady = true;
  anthemAudio = new Audio("/music.mp3");
  anthemAudio.play().then(() => anthemAudio.pause()).catch(() => {});
}
window.addEventListener("click", initAudio, { once: true });
```

### Colorblind-Safe Palette
Avoid pure red/green for status indicators or accents. Use a cyan-mint/amber/orange triad:
- Green alternative: `#a7f3d0` (cyan-mint) — distinguishable for deuteranopia/protanopia
- Warning: `#fbbf24` (amber) — on the yellow axis, safe for all types
- Error: `#f97316` (orange-red) — distinct from cyan-mint for all color vision types

### Cache Strategy (S3 Deploy)
Two-pass sync for optimal caching:
1. **Immutable assets** (JS, CSS, images, fonts): `Cache-Control: public, max-age=31536000, immutable` — cached forever, Astro hashes filenames so new deploys get new URLs
2. **HTML/JSON** (pages, data): `Cache-Control: public, max-age=0, must-revalidate` — always revalidated, so users always see the latest content

### CloudFront Error Pages
SPA-style routing: 403 and 404 errors return `/index.html` with a 200 status. This allows client-side routing for Astro pages without server-side rendering.

### SharedArrayBuffer Headers
Godot 3.5 HTML5 exports require `SharedArrayBuffer`, which browsers only enable with these response headers:
```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```
These are set via a CloudFront Response Headers Policy, not S3 metadata, so they apply to all responses globally.

## Responsive Design

### Mobile Breakpoint
The site uses a single breakpoint at `768px`:
- **Desktop**: Side-by-side grid (Game Dev | Game Assets) with shared row alignment
- **Mobile**: Stacked panels — all Game Dev cards grouped together, then all Game Assets cards

Important: Don't interleave cards from both sides on mobile. Users expect grouped sections they can scroll through, not alternating contexts.

### Hover vs Touch
Hover effects (gif playback, audio, cursor/sword animations) are desktop-only experiences. On mobile, cards are static with the default state visible. Audio requires a tap to unlock.

---

## Roadmap (Future Sections)

Sections to be added as features are implemented:

- **Stripe Integration** — Subscription payments for "Join the Studio"
- **Authentication Backend** — OAuth (Google/Discord) + username/password with session management
- **Godot WASM Embed** — Embedding the Godot 3.5 HTML5 export at `/play`
- **Content Collections** — Devlog authoring workflow with Astro content collections
- **Monitoring & Alerts** — CloudWatch metrics, error tracking

---

## Tools Used

All infrastructure, CI/CD, and web code was scaffolded and iterated using **Claude Code** (Anthropic's CLI). The process was conversational — describing the desired outcome and refining iteratively. Art, music, and fonts are 100% human-crafted.

---

*AllByte Studios - "AI accelerates the code and infrastructure; every asset is crafted by hand."*
