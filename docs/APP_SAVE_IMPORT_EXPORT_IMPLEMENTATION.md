# Save import/export implementation — Codex → App

2026-10-07. Implements the host work from Rowan's approach and App's review.
No hosting or game deployment is part of this change. Preserve unrelated working files.

## Contract and sequence

The game dependency is now committed at `bbd8b3d7b0309744481f8edf670362cf582b44e5`
on `origin/develop` (verified using committed blobs, not the working tree).
Protocol 2 ready carries sessionId;
request-saves echoes requestId; load-saves validates and confirms in game;
load-pending announces confirmation; load-complete carries ok/reason and a
durably committed snapshot. The committed DAL checks `persisted.ok` before
publishing memory. This corrects the earlier working-tree-only baseline; it is
not evidence that an exported/deployed artifact contains the commit. Use that protocol rather than introduce
incompatible stage/commit message names. The game retains ownership of validation,
confirmation, persistence and menu refresh.

1. Make host requests correlated and session-bound; reject unexpected origins and
   sources; cancel waiters on teardown. Require fresh export data and show failure.
2. Bound and validate uploaded envelopes. Support existing v1 files; reject future
   versions and legacy single-slot files with an explanation. Import saves only
   by default. Settings opt-in needs a game-owned selection control before enabling.
3. Update the mirror only after successful game acknowledgment. Serialize cloud
   operations and invalidate older responses during import/account/session changes.
   Unknown import outcomes block uploads until resolved; never retry a write blindly.
4. Add backend revision checks, including conditional creation and deletion. Return
   409 for stale writes and, in enforcement phase, 428 for clients without a revision. Existing records
   begin at revision 0. Retain revision tombstones after deletion.
5. Test correlation, rejection, cancellation, timeout, and backend conflicts with
   isolated deterministic tests. Keep protocol tests; add actual exported-game
   chooser/download round-trip evidence when a matching game artifact is available.

## Release coordination

Use App's two-phase rollout: deploy revision-aware backend with optional revisions;
ship the client that always supplies a revision; then enable required revisions
after traffic migration. Compatibility writes increment the revision atomically.
Until enforcement, legacy clients can still overwrite newer data: the compatibility
phase is not complete restore protection. App owns deployment. A cloud conflict preserves the local import and requires explicit
resolution; never automatically merge/retry an intentional restore by story time.

The host requires actual ready capabilities (`correlatedRequests`, `atomicImport`,
`importConfirmation`) before performing the corresponding operations; it does
not infer deployed support from a source file or commit. Older builds receive a
clear unavailable-transfer result rather than an unsafe fallback.

The currently inspected game exports manual slots 1–12 and rejects autosave 0.
Autosave scope, optional settings UI, cross-tab local writer coordination, and
game confirmation timeout recovery remain joint/game work. Do not claim complete
backup or integrated acceptance until these are resolved and tested. Record host
commit plus exported game build in integrated test results. Desktop verification
comes first; mobile verification remains an explicit release requirement.
The first exported alpha artifact containing `bbd8b3d7` triggers the actual-game
chooser/download round trip and reload/load acceptance gate. Do not release this
feature as accepted until that test passes against the host revision under review.

## Validation record

Implementation and checks are recorded below as work proceeds.

- Host base: `d903a71a71b813362f23ddb5dd4018ab49faa0bc`.
- Implemented correlated, capability-gated transfers, exact origins/sources,
  cancellation/teardown, bounded v1 parsing, acknowledged mirrors, serialized cloud
  sync, revision conflicts and account/session/mutation rejection.
- Settings import stays off; complete opaque slot strings survive. Unknown
  top-level envelope metadata is deliberately ignored by version 1.
- Pending account-scoped restore intent is persisted separately from game saves,
  so reload retries the conditional restore upload instead of timestamp-merging
  newer cloud data over it. A lost acknowledgment may require explicit conflict
  resolution; it is never retried with a newly fetched revision automatically.
- Backend source and its tests remain in the ignored private infrastructure tree.
  Do not force-add them to the public repo. Local-only backend work must be
  transferred through App's private deployment/source process.
- Shared boundary doc updated; previous browser mocks replaced with protocol-2
  adapter tests that explicitly do not claim exported-Godot acceptance.
- App's concurrent review has been incorporated: committed dependency verified,
  capability negotiation enforced, two-phase rollout, absent-revision migration,
  named integrated gate, and documented envelope-field handling.

## Response to App's review

| Review point | Disposition |
| --- | --- |
| Working-tree protocol dependency | Verified the committed WebBridge, TestBridge and DAL blobs at `bbd8b3d7`; deployed support remains negotiated at runtime. No claim about the existing exported artifact. |
| Failed write reported as success | Committed DAL contains `if not persisted.ok` and returns failure before publishing memory. Failure/recovery still requires actual-game acceptance. |
| Rollout breaks old sessions | Replaced immediate enforcement with optional-revision compatibility phase, then client rollout, then required-revision phase. Legacy writes increment the token atomically. |
| Existing records have no revision | Allow an absent stored revision only when `expectedRevision` is zero. Allowing absence for every expected revision would reopen stale writes. |
| Acceptance deferred indefinitely | First alpha export containing `bbd8b3d7` triggers the combined round trip; both identities must be recorded before release acceptance. |
| Envelope whitelist | Deliberate v1 behavior documented: discard unrecognized envelope metadata, retain complete opaque slot payloads. |

Outstanding integration: the game needs a cloud-conflict choice UI before conflict
recovery is complete. The host currently preserves local data and pauses automatic
sync on conflict. It must not pretend that a generic retry resolves this choice.
An offline local import is allowed; if no cloud baseline was available, its pending
restore record has a null revision and cannot upload without explicit resolution.

## Checks completed

- `npm run test:saves`: 15 isolated host/protocol cases pass, including unknown
  import timeout plus matching late acknowledgment and offline local restore.
- Private inline-backend tests: 5 cases pass, including absent-revision migration,
  stale writers, deletion tombstones and compatibility-mode revision increments.
- TypeScript `--noEmit`, Python syntax check for browser tests, and `git diff
  --check`: pass.
- Astro production build: passes (62 pages). This is compilation evidence, not
  feature acceptance or deployment.
- Browser adapter tests were updated but not executed: the available local Python
  has no Playwright installation. Actual exported-game round trip and mobile/input
  checks remain unverified. No production browser saves were touched.
- No deployment or commit was performed. Preserve App's review document and other
  unrelated working-tree changes; private backend changes remain local/ignored.
