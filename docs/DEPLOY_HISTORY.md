# Deploy History

A true, time-ordered record of what shipped to production and when — spanning
**both** repos: the webapp (`allbyte-web`) and the game (`ChroniclesOfNesis`).
Every commit is tagged by **type** so the history reads as a changelog, not a
git dump.

## How this is built (source of truth)

- **Deploy events** = runs of the **"Deploy to AWS"** GitHub Actions workflow
  on `main`. Each run is one production deploy: it carries a timestamp and the
  exact commit (`headSha`) it shipped. This is the authoritative "when did the
  system actually deploy" axis — not commit time, not push time.
- **Webapp changes** per deploy = the commits in the range
  `(previous deployed SHA .. this deployed SHA]`, typed from their
  conventional-commit prefix.
- **Game build shipped** per deploy = the `version` field of
  `src/data/game-version.json` *at that deployed SHA*. This is the game build
  the webapp was serving at that moment.
- **Game changes** per build = sourced from Arc's deploy manifest
  (`tickets/deploy_manifest.ndjson`, see
  `APP_CLAUDE_DEPLOY_HISTORY_STANDARD.md`). Until that manifest lands, the game
  half shows the shipped version only; the per-commit game provenance is marked
  _pending_.

Regenerate with `node scripts/deploy-history.js` (planned — pending format
sign-off). This file is the rendered output, not hand-maintained going forward.

## Type legend

| Type | Meaning |
|------|---------|
| `feat` | New capability |
| `fix` | Bug fix |
| `test` | Automated tests / regression guards |
| `qa` | QA harness, device matrix, cross-browser coverage |
| `play` | `/play` page ↔ game-embed integration (webapp) |
| `marketing` | Marketing / content / copy |
| `refactor` | Internal restructure, no behavior change |
| `tools` | Tooling / scripts / build plumbing |
| `release` | Version bump / game-build promotion / deploy mechanics |
| `docs` | Documentation |

---

## Deploys (newest first)

### 2026-06-28 22:08 ET · webapp `a3801d9` · game `v0.7.2069`
**webapp**
- `test` — cache-bust regression test (versioned-fetch prevents stale-binary serve) — `a3801d9`
- `qa` — cross-OS/browser gameplay QA matrix (v1 scaffolding for Quinn) — `1a55c9c`

**game `v0.7.2069`** — _commit provenance pending Arc manifest_

### 2026-06-28 13:09 ET · webapp `8895c5d` · game `v0.7.2068 → v0.7.2069`
**webapp**
- `release` — push game build v0.7.2069 (versioned-fetch cache-bust) + push guard — `8895c5d`

**game `v0.7.2069`** — first build carrying the versioned-fetch cache-bust. _Per-commit provenance pending Arc manifest._

### 2026-06-27 22:50 ET · webapp `ebba190` · game `v0.7.2068`
**webapp**
- `fix` — self-heal the mismatched-pair WASM crash (Arc 2026-06-28) — `ebba190`

**game `v0.7.2068`** — _commit provenance pending Arc manifest_

### 2026-06-27 22:10 ET · webapp `0233fc6` · game `v0.7.2068`
**webapp**
- `fix` — stop the PWA from hijacking the Patreon OAuth redirect — `0233fc6`

**game `v0.7.2068`** — _commit provenance pending Arc manifest_

### 2026-06-27 15:10 ET · webapp `39d3824` · game `v0.7.2068`
**webapp**
- `fix` — PWA installs the public (non-debug) build + hard self-heal for stale caches — `39d3824`

**game `v0.7.2068`** — _commit provenance pending Arc manifest_

### 2026-06-27 15:00 ET · webapp `cf6d909` · game `v0.7.2068`
**webapp**
- `fix` — auto-recover PWAs stuck on a stale cached build — `cf6d909`

**game `v0.7.2068`** — _commit provenance pending Arc manifest_

---

_Window shown: last 6 production deploys (2026-06-27 → 2026-06-29). Deploy
timestamps are the "Deploy to AWS" workflow run times, displayed in ET (owner
timezone); UTC is the stored source value._
