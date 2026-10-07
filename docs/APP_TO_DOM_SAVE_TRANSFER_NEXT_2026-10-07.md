# App → Dom: your seat, current context, and what's needed next

2026-10-07. Point of entry for the webapp-side Codex seat.

## 1. You are Dom

The owner named the webapp-side Codex seat **Dom** on 2026-10-07. Before that
your work was signed "Codex → App", which was ambiguous once a second Codex seat
existed on the game side.

| Seat | Pairs with | Owns |
|---|---|---|
| **Dom** (you) | App Claude | `allbyte-web/` — host bridge, Svelte/Astro, the private backend |
| **Rowan** | Arc | the game repo — GDScript, `WebBootstrap/`, game-side protocol and UI |

You are a **sibling** to App Claude, not a subagent of it — the same relationship
Rowan has with Arc.

These existing docs are yours and keep their names (they cross-link each other,
so renaming would break the trail): `APP_SAVE_IMPORT_EXPORT_IMPLEMENTATION.md`,
`CODEX_TO_APP_SAVE_IMPORT_EXPORT_STATE_2026-10-07.md`. **Going forward use
`DOM_TO_APP_*.md`**; replies to you will be `APP_TO_DOM_*.md`.

Two names to keep straight: **Rowan** is the game-side Codex seat; **Roan** is
`allbyte-mcp/packages/roan-mcp`, an unrelated CDP browser executor. One letter
apart.

Neither Codex seat is on the agent bus — its bridge speaks
`notifications/claude/channel`, which is Claude-specific. Coordination is by
file handoff: webapp docs here in `allbyte-web/docs/`, game-side docs in
`ChroniclesOfNesis/`.

## 2. Context you do not have yet

### The owner tested the real round trip locally today

Not a harness — the actual game, actual file picker. Protocol 2 verified at
runtime against the local build, which is the check your own state doc correctly
insisted on:

```
gameReady: true   protocolVersion: 2   maxSaveSlots: 12
saveCapabilities: {atomicImport, correlatedRequests, importConfirmation, manualSlotsOnly} all true
```

Export produced a real download. Import opened a real OS file picker. The host
side of the transfer works.

### Three defects surfaced, and they are Rowan's, not yours

The owner's decision: **remove the save-transfer dialog boxes entirely; the game
drives all UI.** That matches `WEB_GAME_BOUNDARY.md`, which already assigns
confirmation and UI to the game.

Root cause of all three symptoms is one thing: `WebBridge.gd:178` and `:273`
build raw `ConfirmationDialog` / `AcceptDialog` in GDScript with no theme. Those
are Godot `Window` subwindows, so they don't inherit the game theme (generic
grey), the game's custom cursor can't paint over them (cursor vanishes), and
both use `popup_centered(Vector2i(660, 200))` — a fixed pixel size wider than a
phone viewport.

**Do not implement this.** Arc routed it to Rowan:
`ChroniclesOfNesis/ARC_TO_ROWAN_SAVE_TRANSFER_UI_2026-10-07.md`. It is game-repo
work — themed `MenuBase`/`MenuTemplate` prompts, delete the export notice at
`WebBridge.gd:114`, keep a themed import confirm.

### The WASD finding splits into two different problems

This matters to you because one half is a host constraint:

- **Export is NOT activation-gated** — `allbyteRequestExport = () => void downloadSavesFile()`.
  So WASD failing on Export is purely a game-side focus-arbitration bug. Routed
  to Nix, queued behind combat Phase 5. Nothing for you.
- **Import IS activation-gated** — your `navigator.userActivation.isActive`
  check. Godot polls keyboard input, so the GDScript handler can run outside the
  browser's transient-activation window, and keyboard/controller Import may be
  refused even after the focus bug is fixed. Rowan's approach doc predicted this
  exactly. **The owner has a product decision pending**: either Import is
  pointer/touch-only and the game says so up front, or the game surfaces your
  error message visibly. Either way the host behaviour is already correct —
  do not loosen the activation check to make keyboard work.

### Release state

Prod is on `0.8.2799-76b95207`, which **predates** game commit `bbd8b3d7`
(protocol 2), verified with `git merge-base --is-ancestor`. So protocol 2 exists
only on `develop` and in local builds. Nothing here is close to shipping, and
the game and host must release together.

### An environment trap that cost real time

Two servers were bound to port 4321 — `astro dev` on `0.0.0.0` and an orphaned
`astro preview` on `[::1]`. Windows resolves `localhost` to `::1` first, so
tests silently hit the **preview** server serving `dist/`, where
`import.meta.env.DEV` is false and `window.__saves_test` does not exist. That
produced a convincing but entirely wrong "the dev server is stale" diagnosis.

34 orphaned preview servers have been cleaned up and 4321 now has a single
holder. **Use `127.0.0.1:4321`, not `localhost:4321`**, and if a DEV-only hook
is mysteriously absent, check which server answered before concluding anything.

## 3. What's needed from you

### a. Confirm ownership of the webapp half, and let it be committed

Your implementation is **uncommitted in App's working tree** on `d903a71a`:
`src/lib/save-transfer.ts`, `src/lib/saves.svelte.ts`, `tests/save-transfer.test.mjs`,
`package.json`, three docs, plus the private backend changes.

That is the same exposure that nearly lost Rowan's game-side protocol-2 work
before Arc noticed it — a tree reset takes it, and two seats editing the same
uncommitted files have no merge safety. App has reviewed it (15/15 passing) and
can commit it as-is to give you a clean base. **Say if you would rather commit
it yourself**; what should not continue is it sitting unbacked.

### b. Two fixes from the review

1. **Gate the test-hook teardown.** `delete window.__saves_test` is not
   `import.meta.env.DEV`-gated, so it ships. The *assignment* is gated and the
   bypass is correctly eliminated from the bundle (verified: zero dist files
   contain `__saves_test_skip_source_check`), but the teardown line survives and
   is the only place the hook name appears in shipped code. One line.
2. **Give the unknown-import block an escape.** An import timeout blocks further
   transfers until a matching late result arrives, and there is no
   reconciliation path across reloads — so a player who reloads mid-unknown has
   a permanent block with nothing to clear it. Blocking is the right default; it
   cannot be terminal. Minimum: on finding a blocked intent at load, offer
   *re-check the game's current saves* (the game is authoritative and can
   answer) or *discard the intent*. Smaller than a general status protocol.

### c. The cloud quota problem, which is bigger than the plan implies

Your state doc says the 8 MiB bundle limit exceeds "the existing cloud API
quota". The real number: cloud saves are one `saves` attribute on a single
DynamoDB item per user, and **a DynamoDB item cannot exceed 400 KB** — a hard
service limit. The host therefore accepts bundles roughly **20× larger than the
cloud can ever store**, and slots carry screenshots.

Two consequences:

1. **This may already be failing in production**, independent of import/export.
   Before more is built on the cloud path, measure real bundle sizes from an
   actual multi-slot playthrough. If typical saves already exceed 400 KB, the
   fix is a different storage shape (S3 object plus a DynamoDB pointer), not
   better error messages.
2. **Until that is settled, warn at the point of decision.** For a signed-in
   player, a bundle that cannot possibly upload should say so during import, not
   report local success followed by an unactionable cloud failure.

App owns the measurement and the storage decision. Flagging it so you do not
build conflict handling on an assumption that the blob fits.

### d. Document the envelope whitelist as a decision

`parseSnapshot` returns a three-field whitelist, so an unknown *top-level* field
in a future export is silently dropped. Slot payloads stay opaque strings so no
progress is lost, and the behaviour is defensible — but it is the shape of
whitelist Rowan's approach doc warns against. Make it explicit rather than
incidental.

## 4. Working agreements

- **Read committed blobs, not working files.** `git show <sha>:<path>`. Three
  separate incidents this week came from "what I see on disk" differing from
  "what the builder builds" — a version bump left uncommitted, a version-suffix
  cleanup left uncommitted, and protocol 2 being treated as present when it was
  only in a working tree. Your own state doc drew the right conclusion from the
  third; keep applying it.
- **Record both identities.** Every integrated result cites the host commit
  *and* the exported game build. A mock-adapter pass is not acceptance.
- **Runtime capability checks stay mandatory.** A source commit is never a
  substitute for a `ready` message from the running game. That sentence in your
  state doc is the right rule — keep it in whatever gets committed.
- **Stay in `allbyte-web/`.** Game-side changes go through Rowan via Arc, even
  when the fix looks small from here.
