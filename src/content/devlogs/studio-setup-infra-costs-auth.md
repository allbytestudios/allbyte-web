---
title: "My Setup: Infrastructure, Costs, and Auth"
description: "How allbyte.studio runs on AWS for under $5/month — the infrastructure, CI/CD pipeline, cost protection, security boundaries, and custom auth system."
pubDate: 2026-04-08T00:02:00Z
category: "technical"
devlog: "studio"
tags: ["aws", "infrastructure", "auth", "stripe", "self-hosting"]
---

How I deployed a static site to AWS for under $5/month (minus Claude expense) — using Claude as the AI pair-programmer. You can reference my setup on [GitHub](https://github.com/allbytestudios/allbyte-web), or read [why I'm doing this instead of using Patreon](/devlog/patreon-vs-self-hosting/).

## The Setup

This site runs on a fully automated pipeline: I push code to GitHub, and it's live on **allbyte.studio** within 30 seconds. No servers to manage, no containers to orchestrate. Just static files on a CDN.

The entire infrastructure — AWS resources, CI/CD pipeline, DNS, certificates — was built in a single conversation with Claude Code.

### My Tools

- **Claude Pro** — AI pair-programmer via Claude Code (Anthropic's CLI). Writes the code, sets up infrastructure, debugs deploy issues. I don't count the subscription as a hosting cost since I'm already paying for it for game development.
- **AWS account** — S3, CloudFront, Route 53, ACM, CloudFormation, Lambda, DynamoDB, API Gateway. Everything runs here.
- **Google Cloud Console** — OAuth 2.0 credentials for Google Sign-In. Free.
- **Discord Developer Portal** — OAuth2 app for Discord Sign-In. Free.
- **Stripe** — Payment processing for subscriptions and donations. No monthly fee, 2.9% + 30¢ per transaction.
- **My PC** — Windows 11, Node.js, npm, AWS CLI, GitHub CLI. All development and deploys happen from one machine.

## Infrastructure

### Stack

- **Astro 6** — Static site generator with content collections for devlogs
- **Svelte 5** — Interactive UI (hover effects, audio, login modal)
- **Tailwind CSS v4** — Styling via Vite plugin
- **AWS S3 + CloudFront** — Hosting and CDN
- **GitHub Actions + OIDC** — CI/CD with no stored secrets
- **CloudFormation** — Infrastructure as code

### AWS Resources

```
GitHub (push to main)
       │
       ▼
GitHub Actions (OIDC auth)
       │
       ▼
  npm ci && npm run build
       │
       ▼
  aws s3 sync → S3 Bucket
       │
       ▼
  CloudFront CDN (HTTPS)
       │
       ▼
  allbyte.studio
```

I registered **allbyte.studio** through Route 53. This allows DNS validation for the SSL cert to happen automatically — Claude added the CNAME records via the AWS CLI in seconds. Since Route 53 is already inside AWS, I can use native ALIAS records instead of CNAMEs, and everything — domain, DNS, certificate, CDN — lives under one account with one bill.

Everything lives in two CloudFormation templates. The frontend (`infrastructure/cloudformation.yaml`) provisions:

1. **S3 Bucket** — Private, no public access. CloudFront reads via Origin Access Control.
2. **CloudFront Distribution** — HTTPS, HTTP/2+3, caching, error page routing.
3. **ACM Certificate** — Free SSL for the domain + www. DNS-validated automatically.
4. **Response Headers Policy** — Injects `Cross-Origin-Opener-Policy` and `Cross-Origin-Embedder-Policy` headers globally. Required for Godot's SharedArrayBuffer.
5. **GitHub OIDC Provider + IAM Role** — GitHub Actions authenticates via federation. No AWS access keys stored anywhere.

The backend (`infrastructure/stripe-backend.yaml`) provisions Lambda functions, DynamoDB tables, and API Gateway — covered in the Authentication section below.

### CI/CD & Deploy

Traditional CI/CD stores AWS access keys as GitHub secrets. Claude recommended OIDC federation instead, and it's better in every way:

| | OIDC | Access Keys |
|---|---|---|
| Stored secrets | None | Key ID + Secret |
| Token lifetime | ~1 hour | Until rotated |
| Rotation needed | No | Yes |
| Scope | Locked to repo + branch | Wherever keys are used |

The IAM role's trust policy restricts access to only my specific repository on the `main` branch. Even if someone forks the repo, they can't assume the role.

Every push to `main` triggers a GitHub Actions workflow:

1. Checks out the code
2. Installs dependencies (`npm ci`) with caching
3. Builds the static site (`npm run build`)
4. Authenticates to AWS via OIDC — no secrets needed
5. Syncs the `dist/` folder to S3
6. Invalidates the CloudFront cache

Total deploy time: ~30 seconds from push to live.

### Cache Strategy

Static assets (JS, CSS, images, fonts) get `max-age=31536000, immutable` — cached forever. Astro hashes filenames, so new deploys automatically get new URLs.

HTML files get `max-age=0, must-revalidate` — always revalidated so users see the latest content immediately after a deploy.

## Costs & Protection

For a low-traffic site, the monthly bill looks like this:

| Service | Monthly Cost |
|---|---|
| S3 (static hosting) | ~$0.02 |
| CloudFront CDN | ~$0.00–0.50 |
| ACM Certificate (HTTPS) | Free |
| Route 53 (DNS) | $0.50/zone |
| Lambda (auth + backend) | Free tier |
| DynamoDB (user/subscription data) | Free tier |
| API Gateway | Free tier (first 12 months) |
| Google OAuth | Free |
| Discord OAuth | Free |
| Stripe | 2.9% + 30¢/txn |
| GitHub Actions (CI/CD) | Free |
| Secrets Manager (5 secrets) | ~$2.00 |
| Cost protection (Budget + Lambda) | Free |
| **Total (before transactions)** | **<$5/mo** |

CloudFront includes 1TB free transfer for the first year. After that, it's $0.085/GB — still negligible for a low-traffic site.

The scariest part of self-hosting on AWS isn't the setup — it's the fear of a surprise bill. If someone decides to DDoS the site or a bot hammers the CDN, CloudFront charges by the request. So I built an automatic kill switch.

A monthly AWS Budget watches my spend. At **80% ($20)**, I get an email warning. At **100% ($25)**, a Lambda function automatically disables the CloudFront distribution — the site goes down instead of racking up charges.

CloudFront includes **AWS Shield Standard** for free, which handles common layer 3/4 DDoS attacks. To re-enable after a shutoff: flip the distribution back to Enabled in the CloudFront console.

## Claude & Security

Claude Code is the AI pair-programmer behind all of this — it wrote the CloudFormation templates, the Lambda functions, the OAuth flow, the CI/CD pipeline, and this document. But working with AI on infrastructure requires a clear security boundary.

The core rule: **secrets never flow through Claude.** No reading `.env` files, no fetching values from Secrets Manager, no pasting credentials into chat. When a task requires creating or updating secrets, Claude provides the exact command and I run it myself.

### .claudeignore

Claude Code supports a `.claudeignore` file (like `.gitignore`) that prevents it from reading specified files. Ours blocks anything that could contain secrets:

```
.aws/
.git/
.env
.env.*
credentials.json
*.pem
*.key
*.p12
*.pfx
*.jks
*.keystore
*secret*key*
*service*account*.json
id_rsa
id_ed25519
*.pub
```

### Secrets Management

All secrets live in **AWS Secrets Manager** under the `allbyte-studio/` prefix:

- `allbyte-studio/jwt-secret` — HS256 signing key for JWT tokens
- `allbyte-studio/stripe-secret-key` — Stripe API secret
- `allbyte-studio/google-oauth` — Google OAuth client credentials
- `allbyte-studio/discord-oauth` — Discord OAuth client credentials
- `allbyte-studio/stripe-webhook-secret` — Stripe webhook signing secret

Lambda functions fetch these at runtime via the IAM role. Secrets are cached in Lambda memory between warm invocations to reduce latency and API calls.

**Key rotation protocol:** If an AWS access key was ever exposed in an AI session, deactivate it immediately, create a new one, and reassign it. I've done this once already — better safe than sorry.

For CI/CD, I avoid access keys entirely. GitHub Actions authenticates via **OIDC federation** — short-lived tokens scoped to my specific repo and branch. Nothing to rotate, nothing to store.

## Authentication

### The Auth Stack

The entire authentication backend lives in a single CloudFormation template (`infrastructure/stripe-backend.yaml`) as inline Python 3.12 Lambda functions. No frameworks, no Cognito, no third-party auth services. Eight Lambda functions behind an API Gateway V2 HTTP API:

- **Signup** — Email/password registration with PBKDF2-HMAC-SHA256 hashing (600k iterations)
- **Login** — Email/password authentication, returns JWT
- **Me** — Token verification, returns user profile with subscription tier
- **OAuth Start** — Redirects to Google/Discord authorization
- **OAuth Callback** — Exchanges auth code, creates/links user, returns JWT
- **Checkout** — Creates Stripe Checkout sessions for subscriptions and donations
- **Webhook** — Processes Stripe events with signature verification
- **Counts** — Public endpoint returning subscriber tier counts

User data lives in DynamoDB (`allbyte-studio-users`) with a Global Secondary Index on email for lookups. JWT tokens are HS256-signed with a 7-day expiry, stored in `localStorage` on the client.

### OAuth (Google & Discord)

OAuth lets users sign in with accounts they already have.

The challenge: the frontend is a static site on S3. There's no server to handle OAuth callbacks, and the browser can't securely exchange auth codes — that requires a client secret. The solution: route the entire flow through API Gateway.

1. User clicks "Google" or "Discord" in the login modal
2. Browser redirects to the API (`GET /auth/oauth/{provider}`)
3. Lambda reads the client ID from Secrets Manager, generates a stateless CSRF `state` parameter (HMAC-signed timestamp), and returns a 302 redirect to the provider
4. User authorizes on Google/Discord
5. Provider redirects to the callback (`GET /auth/oauth/{provider}/callback`)
6. Lambda exchanges the code for an access token, fetches the user's profile (email, display name)
7. Finds the user by email in DynamoDB — if they exist, links the OAuth provider to the existing account. If not, creates a new user.
8. Signs a JWT and redirects to `allbyte.studio/#token={jwt}`
9. Frontend reads the token from the URL hash, stores it in `localStorage`, and clears the hash

Account linking works by email: if someone signs up with email/password and later clicks "Sign in with Google" using the same email, they get the same account.

### Stripe Integration

Authenticated users can subscribe to one of three tiers (Initiate, Hero, Legend) or make one-time donations. The checkout flow creates a Stripe Checkout session tied to the user's Stripe customer ID. A webhook Lambda processes subscription events and updates the DynamoDB subscriptions table.

## Lessons Learned

- **CloudFormation naming** — Resource names can't contain dots. `allbyte.studio-headers` fails; `allbyte-studio-headers` works. Cost me a rollback.
- **Astro 6 requires Node.js 22+** — First CI deploy failed because the workflow used Node 20. Check your framework's minimum version.
- **IAM permissions for S3 copy-in-place** — Updating cache headers on already-uploaded files requires `s3:GetObject` in addition to `PutObject`. The copy operation reads then writes.
- **Tailwind v4 + Astro + Svelte CSS variables** — CSS custom properties defined in a scoped Astro `<style>` block don't reach Svelte components. Use `<style is:global>` or hardcode values.
- **ACM certs must be in us-east-1** — CloudFront only uses certificates from `us-east-1`, regardless of where your other resources are. Deploy the whole stack there.
- **CloudFront doesn't serve index.html for subdirectories** — S3's `DefaultRootObject` only works for the root path `/`. The fix is a CloudFront Function that rewrites URIs — appending `index.html` to paths ending in `/` or paths without a file extension.
- **JSON strings in AWS CLI on Windows** — Bash on Windows (Git Bash) mangles JSON inside `--secret-string` arguments. I solved this by using a simple pipe-delimited format and parsing it in the Lambda.
- **CloudFormation stack naming matters** — I deployed to `allbyte-studio-backend` when the existing stack was `allbyte-studio-stripe`. Always check `aws cloudformation list-stacks` before deploying to a new stack name.
- **Stateless CSRF for OAuth** — Instead of storing OAuth state in a database or session, I sign a timestamp with HMAC-SHA256 using the existing JWT secret. The callback verifies the signature and checks that the timestamp is within 10 minutes. Zero additional infrastructure for CSRF protection.
