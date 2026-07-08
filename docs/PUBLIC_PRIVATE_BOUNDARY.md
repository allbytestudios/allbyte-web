# The public / private line

**This repo is PUBLIC (MIT).** Everything committed here is world-readable, forever
(git history included — a later deletion does **not** un-publish it). Treat every commit
as a press release. This doc is the boundary between what ships publicly and what never
does. **Read it before adding a file, a link, or a path to the repo.**

## Why this exists

The repo doubles as a set of open-source Godot tools *and* the private control plane for
a real business (auth, payments, marketing). Those two things share a working tree but
must not share a git history. The line drifted once (marketing strategy and the auth
backend were committed; the owner's real name almost was) — this doc is the fix.

## PUBLIC — belongs in the repo

- **Site source** — `src/`, `public/` (non-asset), `astro.config.mjs`, styles, layouts.
- **Reusable Godot tooling** — the value proposition for other devs:
  - `deploy/` — the reusable deploy IaC (CodeBuild exporter + image-CI OIDC role).
  - `scripts/obfuscate-godot-export.js`, `scripts/migrate_g3_to_g4_tscn.py`,
    `scripts/push-channel.js`, and the other pipeline scripts.
  - `docker/exporter/`, `.github/workflows/`.
- **Docs** — `README.md`, `DEPLOY.md`, `docs/BRING_YOUR_OWN_GAME.md`, this file.
- **Devlog content** — `src/content/devlogs/`. These *describe* architecture (including
  the private backend) at a deliberately chosen, high-level, secret-free altitude. That
  editorial choice is distinct from shipping the source — describing "we use PBKDF2 +
  JWT" is fine; committing the Lambda that does it is not.

## PRIVATE — NEVER committed (gitignored)

- **`infrastructure/`** — the entire directory is `.gitignore`d. It holds:
  - the auth + payments backend (`stripe-backend.yaml` — inline auth/OAuth/Stripe source,
    admin email, secret names: pure attack-surface, zero reuse value),
  - site/CDN infra (`cloudformation.yaml`), analytics (`play-analytics.yaml`),
    pack gating (`pack-gating.yaml`),
  - **marketing strategy** (`marketing/` — Postiz, posting playbooks, reddit ladders,
    trailer treatments),
  - the Qwen/GPU plan, and anything else operational.

  These live on the owner's machine and deploy via CLI from there. A blanket ignore is
  used deliberately: an "ignore all **except** X" rule is exactly how things leak, so the
  public deploy templates were **moved out** to `deploy/` to keep the ignore total.

- **Secrets — nowhere, ever.** Not in `infrastructure/`, not in `deploy/`, not anywhere.
  Real values live in AWS Secrets Manager / GitHub Secrets and are referenced by ARN or
  pulled at runtime. `.env*` (except `.env.example`) is ignored. If a secret is ever
  committed, that's an incident: **rotate it**, don't just delete it.

## Rules for anything you add to the public repo

1. **No secrets.** Keys, tokens, passwords, webhook secrets, private keys → Secrets
   Manager / GH Secrets only.
2. **No account-specifics hardcoded.** Account IDs (`408667082077`), ARNs, bucket names,
   CloudFront distribution IDs, hosted-zone IDs → make them CFN params / action inputs /
   config, never literals. This is also what makes `deploy/` forkable.
3. **No business backend source.** Auth, payments, user data, OAuth logic stays in
   `infrastructure/`.
4. **No marketing / strategy / business content.** Stays in `infrastructure/marketing/`.
5. **Never the owner's real name.** Use "the owner" / "AllByte". The private game repo's
   real path contains it — refer to it as "the private game repo", not by path. (A local
   pre-commit personal-name check backs this up; don't rely on it alone.)
6. **A path in a public doc must resolve in the public repo.** If you reference an
   `infrastructure/` path in `README.md`/`DEPLOY.md`, it will 404 for everyone who clones
   — describe it in prose instead, or point at the `deploy/` equivalent.

## Quick self-check before committing

- `git status` — is anything under `infrastructure/` staged? It shouldn't be.
- Did I add a hardcoded account ID / ARN / bucket / distribution ID?
- Does any new public doc link a path that isn't in the public tree?
- Would I be comfortable with this exact diff on the front page of the repo? Because it is.
