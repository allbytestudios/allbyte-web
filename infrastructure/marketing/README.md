# Marketing infrastructure — Postiz self-hosted

AppC-managed container for marketing automation. Self-hosts
[Postiz](https://github.com/gitroomhq/postiz-app) (AGPL, open source)
to schedule + publish to social platforms via its MCP server (driven by
Claude / Claude Code) and direct platform APIs.

Isolated from Arc's `tactical-dev` game-dev container so:
- Arc rebuilds his stack without affecting marketing schedules
- Marketing credential blast radius stays inside this container
- Each Claude owns its own infra cleanly

## First-time setup

```bash
cd infrastructure/marketing

# 1. Set the JWT secret
cp .env.example .env
# Edit .env, set JWT_SECRET to a strong random string.
# Quick generator: openssl rand -hex 32 (or just any 32+ char random string)

# 2. Bring it up
docker compose up -d

# 3. Watch logs until ready
docker compose logs -f postiz
# Wait until you see "Listening on port 5000" or similar

# 4. Open the UI
# http://localhost:5000
```

First boot can take 2-3 minutes (Postiz runs Prisma migrations against
fresh Postgres on first start).

## Daily operations

```bash
# Status
docker compose ps

# Logs
docker compose logs -f postiz
docker compose logs --tail=50 postiz-postgres

# Restart just Postiz (keeps Postgres + Redis state)
docker compose restart postiz

# Stop everything (keeps state)
docker compose down

# Nuke everything including data (CAREFUL — loses all scheduled posts + accounts)
docker compose down -v
```

## Connecting social accounts — local testing first

**Recommended test sequence (in this order):**

1. **Discord webhook** — easiest, no OAuth. Create a private channel
   in your existing Discord server. Right-click channel → Edit Channel
   → Integrations → Webhooks → New Webhook → copy URL. Paste into
   Postiz UI under Add Channel → Discord. Real-time validation, zero
   audience risk.

2. **dev.to drafts** — get a dev.to API key from
   https://dev.to/settings/extensions, paste into Postiz. Configure
   posts to save as `published: false` for testing — they land in your
   drafts list, not your public profile.

3. **Bluesky test account** — create a dedicated `@allbyte-test.bsky.social`
   (or whatever) separate from your main account. App password via
   https://bsky.app/settings/app-passwords. Paste into Postiz Add
   Channel → Bluesky. Real AT Protocol validation with zero
   audience.

4. **Mastodon unlisted** — your existing account is fine; set the
   default visibility for Postiz-published posts to "Unlisted" via the
   Postiz post-format settings. Unlisted posts don't appear in
   federated/public timelines but you can see them on your own profile.

5. **Reddit private subreddit** — create `r/allbyte_test` (or
   whatever), set type to "Private" or "Restricted" during creation,
   only invite your own account. Then add Reddit to Postiz via OAuth.
   Real Reddit API validation, zero audience.

6. **YouTube unlisted** — when the autoplay-capture pipeline lands,
   recordings upload via the YouTube API as Unlisted. You see them in
   your YT Studio's Unlisted tab; public can't find them without the
   direct URL.

For each platform: post a test variant, confirm it lands correctly,
confirm scheduling works, confirm Postiz surfaces errors clearly when
something fails.

## OAuth callback URL — the public-URL gotcha

Some platforms (Reddit, X, LinkedIn, Threads) require an OAuth flow
where the platform redirects back to a URL hosted by Postiz. For
purely local Postiz on `localhost:5000`, those callbacks won't work
because Reddit can't talk to your localhost.

Three solutions in increasing order of polish:

1. **Tailscale Funnel** — you already have Tailscale (per the project
   memory). `tailscale funnel 5000` exposes Postiz at a stable
   `*.ts.net` URL. Update OAuth app config at each platform to point
   at that. Free, no DNS configuration.
2. **ngrok / Cloudflare Tunnel** — temporary public URLs. Annoying
   because they change between sessions (free tier) unless you pay.
3. **Real domain on a VPS** — when the marketing pipeline is mature
   enough that always-on matters, migrate to a $4-6/mo VPS (Hetzner /
   DigitalOcean) and give Postiz a real subdomain like
   `marketing.allbyte.studio`. Update OAuth callbacks. Pay-the-platforms
   tradeoff: another vendor, another $4-6/mo, vs the convenience.

For now (testing phase): use Tailscale Funnel.

Bluesky + Mastodon don't need this — they use app-password / token
flows that work from any host.

## MCP server access (Claude integration)

Postiz exposes an MCP server. Claude Code can connect to it via the
local URL once Postiz is running, then drive operations like "draft
variants of this devlog and schedule for tomorrow morning across
Bluesky + Mastodon."

The MCP server endpoint is at `http://localhost:3000/mcp` by default
(verify in Postiz docs / startup logs — exact path may vary by Postiz
version). In Claude Code, add it as an MCP server in your settings to
make it callable from any conversation.

## Costs

- **Hosting:** $0 on your dev machine
- **Storage:** ~500MB-2GB volume usage for postgres + uploads, depending on attachment volume
- **Claude API for variant generation:** ~$0.04-0.07 per devlog ≈ $0.20-1/mo at 2-4 devlogs

Total expected: under $1/mo until something changes scale.

## Migration path (when ready for always-on)

Postiz state lives in two named volumes: `postiz_postgres` and
`postiz_uploads`. To migrate to a VPS:

```bash
# On dev machine
docker run --rm -v allbyte-marketing_postiz_postgres:/source -v $(pwd):/backup alpine \
    tar czf /backup/postgres.tar.gz -C /source .
docker run --rm -v allbyte-marketing_postiz_uploads:/source -v $(pwd):/backup alpine \
    tar czf /backup/uploads.tar.gz -C /source .

# scp postgres.tar.gz + uploads.tar.gz to the VPS
# Then on the VPS, after running docker compose up -d once to create volumes:
docker run --rm -v allbyte-marketing_postiz_postgres:/dest -v /path/to/backups:/backup alpine \
    tar xzf /backup/postgres.tar.gz -C /dest
# Same for uploads
docker compose restart
```

Configuration moves via the .env file — same secrets, new MAIN_URL /
FRONTEND_URL pointing at the public domain.

## Reference

- Postiz docs: https://docs.postiz.com/
- Postiz GitHub: https://github.com/gitroomhq/postiz-app
- Project-level marketing plan: `~/.claude/plans/ai-marketing-pipeline.md`
- AppC's MCP integration notes: TBD once Postiz is running

## Troubleshooting

**Postiz won't start, complains about JWT_SECRET:**
You skipped step 1. Edit `.env` and set JWT_SECRET to anything 32+ characters.

**"Postgres connection refused" or migration errors on first boot:**
First boot needs ~30s for Postgres to initialize before Postiz can connect. The healthcheck dependency should handle this but if you see errors during initial bring-up, give it a minute and `docker compose restart postiz`.

**OAuth flow returns "invalid callback URL":**
You're trying to connect a platform (Reddit / X / LinkedIn) without a publicly reachable URL. See "OAuth callback URL — the public-URL gotcha" above. Use Tailscale Funnel as the easiest fix.

**Port 5000 conflicts with something else:**
Edit `.env`, set `POSTIZ_FRONTEND_PORT=5001` (or whatever), restart.
