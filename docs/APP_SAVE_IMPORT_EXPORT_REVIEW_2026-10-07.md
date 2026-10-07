# App review → Codex: save import/export implementation

Review of `docs/APP_SAVE_IMPORT_EXPORT_IMPLEMENTATION.md` and the host code
already written against it (`src/lib/save-transfer.ts`). By App Claude,
2026-10-07, at the owner's request.

**The approach is largely right.** The message design, the result-unknown
semantics, the origin/source hardening and the backend revision work are all
sound, and `save-transfer.ts` is in several respects better than the plan that
produced it. Two things need to change before more is built on top: the plan's
foundational premise is false for any build, and the game-side code it depends
on has a defect that would report success on a failed write.

---

## 1. BLOCKER — "the game already implements protocol 2" is not true of any build

The implementation doc opens with:

> *"The current game source already implements protocol 2: ready carries
> sessionId; request-saves echoes requestId; ..."*

Checked against what a build would actually contain:

```
SAVE_PROTOCOL_VERSION on origin/develop : NOT PRESENT
protocolVersion  on origin/develop      : NOT PRESENT
...in the container working tree        : present
```

Protocol 2 exists **only as uncommitted work in a working tree**. It is not on
`origin/develop`, so no deployed artifact and no cloud build speaks it. A host
written against that premise would ship expecting `sessionId`, `requestId` and
`load-pending` from a game that sends none of them — and the WIP is also at
risk from any tree reset, which is how it came to notice in the first place.

This is the **third** occurrence of the same trap in two days: a version-suffix
cleanup left uncommitted (caught in a prod pre-flight), a version bump left
uncommitted before that, and now a whole protocol. The rule that keeps catching
it:

> **Read the committed blob at the sha the builder will build, never the file
> on disk.** `git show <sha>:<path>`, not `cat <path>`.

**What to change.** State that protocol 2 is *proposed and uncommitted*, name
the commit expected to carry it, and make the host's protocol-2 path
conditional on the capability actually arriving in `ready` — never on an
assumption about the game source. The host should already be doing this: it
reads `protocolVersion` and `saveCapabilities` at runtime, so it can negotiate
rather than assume. Write that down as the contract, and the ordering problem
disappears.

## 2. CRITICAL — the dependency reports success on a failed write

The game-side import the host is meant to trust does this:

```gdscript
var persisted := _commit_import_writes(staged.writes)
# Publish to readers only after the journal's durable commit point.
for slot_id in staged.slots:
    _all_saves[slot_id] = staged.slots[slot_id]
return {"ok": true, "reason": "", "acceptedSlots": staged.slots.keys(), "rejectedSlots": []}
```

**`persisted` is assigned and never read.** The function publishes to
`_all_saves` and returns `ok: true` whether or not the commit succeeded. At the
same time `TestBridge` advertises `"saveCapabilities": {..., "atomicImport":
true, ...}`.

So on a storage failure — quota exhaustion being the obvious one, since
screenshots make save bundles large — the host is told the import was atomic
and fine, updates its mirror, and resumes cloud sync against data that was
never durably written.

This is the exact defect the originating approach document says to fix:

> *"Propagate `_ls_save` failures through `_persist_save` and the import
> result. Do not publish candidate `_all_saves` or show success before durable
> storage succeeds."*

**This is game-side and not App's to fix**, but the host must not be built as
if `ok: true` means durable until it does. Two concrete asks for whoever owns
that code: check `persisted` and propagate failure into the result, and do not
advertise `atomicImport: true` until the commit is genuinely all-or-nothing.
Advertising a capability that is not implemented is worse than not advertising
it, because the host stops defending itself.

## 3. Reverse the release order

> *"Deploy the revision-aware backend before the client. Old clients
> intentionally receive a precondition error rather than silently overwriting
> newer data."*

The protective instinct is right, but as written this breaks cloud sync for
every in-flight session until each one reloads — and returning players can hold
an older client for a while through the service worker cache. A self-inflicted
outage is not made safe by being deliberate.

**Use a two-phase rollout instead**, which buys the same protection with no
broken window:

1. Backend treats `revision` as **optional**: present → enforce the condition;
   absent → behave as today.
2. Ship the client that always sends a revision.
3. Once traffic has moved, flip the backend to **required** and start returning
   428 to anything still arriving without one.

## 4. Revision migration detail

Existing records in the saves table have no `revision` attribute at all, so
"existing records begin at revision 0" has to be expressed as a condition that
tolerates its absence:

```
attribute_not_exists(revision) OR revision = :expected
```

Written as a bare `revision = :expected`, the first conditional write against
any pre-existing record fails permanently — which is every current player.

For context on why this work is needed at all: the saves API today is
`get_item` + `update_item` over `{userId, saves, updatedAt}` with **no**
`ConditionExpression`, no revision attribute and no `If-Match` — last-write-wins
on a single blob per user. The conflict risk the plan describes is not a
possibility to guard against, it is the current default. (Backend lives in the
private infrastructure stack, not in this repo.)

## 5. Close the acceptance loophole

> *"add actual exported-game chooser/download round-trip evidence when a
> matching game artifact is available"*

Because protocol 2 is uncommitted, **no matching artifact exists**, so the only
test that actually proves this feature works is deferred by construction. That
is a gate, not a conditional — give it a named trigger ("first alpha build
containing commit X") so it cannot quietly never happen.

The rest of the verification plan is right, including the rule that a mock-host
pass or a game-only `:8060` pass is not acceptance, and that every integrated
result records **both** the host commit and the exported game build.

## 6. What is good and should not change

From the plan: origin and source rejection; requiring fresh export data and
showing failure rather than substituting a cached mirror; saves-only import by
default; settings restoration behind a game-owned selection control; revision
tombstones retained after deletion; 409 for stale writes and 428 for missing
revisions.

From `src/lib/save-transfer.ts`, which is solid work:

- **Size is checked before `JSON.parse`** (`:28`) — the correct order, and the
  one most often gotten wrong.
- **Correlation on `requestId` + `type` + `session`** (`:49`) — late replies
  from a previous iframe session are dropped rather than applied.
- **Distinct timeout semantics** (`:42`) — *"Import result unknown. Do not retry
  until the game result is reconciled"* versus a plain snapshot retry. The
  result-unknown contract is honoured instead of collapsing into a generic
  failure.
- **Optional `game` field** (`:32`) — the right compatibility call, because
  current v1 exports do not carry one.
- Slot payloads stay opaque strings, so the host validates the envelope and the
  game validates the schema. That is the correct boundary and matches
  `docs/WEB_GAME_BOUNDARY.md`.
- `cancel()` clears timers and rejects every waiter — teardown is handled.

Two small notes, neither blocking:

- `parseSnapshot` returns a three-field whitelist (`:24`), so an unknown
  *top-level* field in a future export is silently dropped. Slot data survives
  intact so no progress is lost, but this is the shape of whitelist the
  approach document warns against — make it a documented decision rather than
  an incidental one.
- `parseBackup` checks the size of `text`, then `parseSnapshot` re-serialises
  and checks again (`:23`). Harmless, slightly wasteful on large bundles.

## 7. Verified facts, so they need not be re-derived

Checked against `src/lib/saves.svelte.ts` at `d903a71`:

| Fact | Where |
|---|---|
| Export falls back to the cached mirror after 1.5s, silently | `:348` |
| postMessage uses a wildcard target | `:270` |
| Import defaults to `source: "local"` | `:301` |
| Host listens for `allbyte:save-changed`; no game-side emitter exists | `:220` |
| Source check only applies when an `iframeRef` exists; **no `e.origin` check at all** | `:179` |
| Source-check bypass is a plain window global with no dev-build gate | `:178` |
| Cloud upload applies to any signed-in account; the Hero/Legend comments are stale and should be deleted | — |

The direct-call entry point for import is deliberate and must be preserved:
`postMessage` cannot carry user activation, so the file picker silently no-ops
on most browsers when triggered that way (`:70`, `:182-186`). Same-origin holds
in prod, in dev through the `chroniclesProxy`, and for the bare build at
`/godot/public/`; there is no supported split-port arrangement.
