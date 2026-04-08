---
title: "Adding Google & Discord OAuth to a Serverless Static Site"
description: "How we built OAuth login on top of our existing Lambda + DynamoDB auth backend — no frameworks, no Cognito, just CloudFormation and Python."
pubDate: 2026-04-08
category: "technical"
tags: ["oauth", "aws", "lambda", "cloudformation", "auth", "google", "discord"]
---

# Adding Google & Discord OAuth to a Serverless Static Site

The AllByte Studios portal already had email/password authentication — Lambda functions behind API Gateway, user records in DynamoDB, JWT tokens signed with a secret from AWS Secrets Manager. But nobody wants to create yet another account with yet another password. We needed OAuth.

## The Existing Auth Stack

Before OAuth, our backend (defined entirely in `infrastructure/stripe-backend.yaml` as inline Lambda code) looked like this:

- **DynamoDB `allbyte-studio-users`** table: userId (partition key), email (GSI), username, passwordHash, stripeCustomerId
- **DynamoDB `allbyte-studio-subscriptions`** table: customerId (partition key), subscriptionId, status, priceId
- **Lambda functions**: signup, login, me (token verification), checkout (Stripe), webhook, counts
- **JWT tokens**: HS256 signed, 7-day expiry, stored in `localStorage` on the client
- **Password hashing**: PBKDF2-HMAC-SHA256 with 600k iterations

All of this runs on API Gateway V2 (HTTP API) with CORS configured for our domain and localhost dev server.

## The Challenge: OAuth on a Static Site

Our frontend is a static Astro site on S3 + CloudFront. There's no server to handle OAuth callbacks. The browser can't securely exchange auth codes either — that requires a client secret that can't be exposed in frontend code.

The solution: **route the entire OAuth flow through our API Gateway**.

## The OAuth Flow

We added two new Lambda functions:

### 1. OAuthStartFunction (`GET /auth/oauth/{provider}`)

When a user clicks "Google" or "Discord" in the login modal, the frontend simply redirects the browser to our API:

```
window.location.href = "https://our-api.execute-api.us-east-1.amazonaws.com/auth/oauth/google"
```

The Lambda:
1. Reads the provider's `client_id` from Secrets Manager
2. Generates a **stateless CSRF `state` parameter** — an HMAC-SHA256 signature over a timestamp using our JWT secret. No database, no session store needed.
3. Returns a **302 redirect** to the provider's authorization URL

### 2. OAuthCallbackFunction (`GET /auth/oauth/{provider}/callback`)

After the user authorizes, Google/Discord redirects back to this endpoint with an auth code. The Lambda:

1. **Verifies the `state` parameter** — checks the HMAC signature and that the timestamp is within 10 minutes
2. **Exchanges the auth code** for an access token via the provider's token endpoint
3. **Fetches the user's profile** (email, display name) from the provider's userinfo endpoint
4. **Finds or creates the user** in DynamoDB:
   - Queries the `email-index` GSI
   - If found: links the OAuth provider to the existing account (adds `oauthProvider` and `oauthId` fields)
   - If not found: creates a new user record (no `passwordHash` — they'll always sign in via OAuth)
5. **Signs a JWT** with the same format as our email/password login
6. **Redirects to the frontend** with the token in the URL fragment: `https://allbyte.studio/#token=xxx`

The frontend's `initAuth()` function checks `window.location.hash` on load, extracts the token, stores it in `localStorage`, and clears the hash with `history.replaceState`. From that point on, the user is authenticated exactly like any email/password user.

## Account Linking

A key design decision: we link accounts by email. If someone signs up with email/password and later clicks "Sign in with Google" using the same email, they get linked to the same account — same userId, same Stripe customer, same subscription tier. The OAuth fields get added to their existing record.

This works because:
- Google always provides a verified email
- We check Discord's `verified` field and reject unverified emails
- DynamoDB is schemaless, so adding `oauthProvider`/`oauthId` to existing records requires no migration

Users who signed up via OAuth have no `passwordHash`, so the email/password login naturally rejects them with "Invalid email or password." They must use their OAuth provider to sign in.

## Security Decisions

**Stateless CSRF protection**: Instead of storing state in a database or session, we sign the current timestamp with our JWT secret. The callback verifies the signature and checks freshness (10-minute window). This means zero additional infrastructure.

**Token in URL fragment, not query string**: The `#token=xxx` fragment is never sent to the server in HTTP requests or `Referer` headers. The frontend clears it immediately after reading.

**Secrets management**: OAuth client IDs and secrets are stored in AWS Secrets Manager under `allbyte-studio/google-oauth` and `allbyte-studio/discord-oauth` as JSON objects. The Lambda IAM role already had Secrets Manager access for the JWT secret and Stripe key, so no policy changes were needed.

**No new dependencies**: The Lambda functions use only Python standard library (`urllib.request`, `json`, `hmac`, `hashlib`) and `boto3`. No third-party OAuth libraries, no additional Lambda layers.

## Setting Up the OAuth Providers

### Google Cloud Console
1. Go to **APIs & Services → Credentials**
2. Create an **OAuth 2.0 Client ID** (Web application type)
3. Add the authorized redirect URI: `https://{api-gateway-id}.execute-api.us-east-1.amazonaws.com/auth/oauth/google/callback`
4. Store the credentials in Secrets Manager as `{"client_id": "...", "client_secret": "..."}`

### Discord Developer Portal
1. Create a new **Application** → go to **OAuth2** settings
2. Add the redirect URI: `https://{api-gateway-id}.execute-api.us-east-1.amazonaws.com/auth/oauth/discord/callback`
3. Store the credentials in Secrets Manager the same way

### AWS Secrets Manager
```bash
aws secretsmanager create-secret --name allbyte-studio/google-oauth \
  --secret-string '{"client_id":"...","client_secret":"..."}'
aws secretsmanager create-secret --name allbyte-studio/discord-oauth \
  --secret-string '{"client_id":"...","client_secret":"..."}'
```

**Important**: On Windows/Git Bash, single-quoted JSON with inner double quotes can get mangled. Use escaped double quotes if needed:
```bash
aws secretsmanager put-secret-value --secret-id "allbyte-studio/google-oauth" \
  --secret-string "{\"client_id\":\"...\",\"client_secret\":\"...\"}"
```

## The Subscribe Flow with OAuth

One subtlety: if a user clicks "Subscribe" while logged out, we show the login modal with `pendingAction = "subscribe"`. For email/password, the post-login callback redirects to `/subscribe/`. But OAuth navigates the browser away entirely, losing that state.

Solution: before redirecting to OAuth, we save the pending action to `sessionStorage`. When `initAuth()` picks up the token from the URL hash and successfully validates it, it checks `sessionStorage` for the pending action and redirects to `/subscribe/`.

## Infrastructure as Code

Everything is in a single CloudFormation template (`infrastructure/stripe-backend.yaml`). The two new Lambdas follow the same inline-code pattern as the existing auth functions. Deploying is one command:

```bash
aws cloudformation deploy \
  --template-file infrastructure/stripe-backend.yaml \
  --stack-name allbyte-studio-stripe \
  --capabilities CAPABILITY_NAMED_IAM
```

No build step, no packaging, no layers. The tradeoff is a 4096-character limit per inline function, but our OAuth Lambdas fit comfortably.

## What's Next

- Testing the full flow end-to-end with real Google and Discord accounts
- Error handling UX — showing `auth_error` from the URL hash in the login modal
- Potentially adding more providers (GitHub, Twitch) using the same `{provider}` pattern
