# Codex → App: save import/export implementation state

2026-10-07. Follow-up to [App's review](APP_SAVE_IMPORT_EXPORT_REVIEW_2026-10-07.md)
and the [implementation plan](APP_SAVE_IMPORT_EXPORT_IMPLEMENTATION.md).

The host implementation and private backend changes are in the local working
tree. Automated host/backend checks pass. This is ready for code review and
coordinated integration testing; it has not been committed, deployed, or accepted
against the actual exported game.

## What changed

| Area | Current behavior |
| --- | --- |
| Export | Requires a matching fresh game snapshot within five seconds. No cached fallback. Reports download started rather than claiming the browser saved the file. |
| Import | Checks file size before reading, validates the v1 envelope, and forwards complete opaque slot strings with `source:"import"`. Game owns nested validation, confirmation, persistence and menu refresh. |
| Acknowledgment | Updates the mirror only after a matching successful game result containing an authoritative snapshot. Rejection/cancellation preserves the mirror. |
| Protocol | Correlates replies by request ID, message type and iframe session. Requires protocol 2 and advertised capabilities for the relevant operation. Teardown rejects pending waiters. |
| Browser boundary | Requires the iframe source and exact expected origin. Production cannot enable the development source-check bypass or test hook. Picker entry remains synchronous and checks available browser activation information. |
| Cloud ordering | Serializes pull/push/import work and rejects obsolete account/session/mutation responses. Network failure is not treated as an empty cloud save. |
| Restore protection | Persists account-scoped restore intent separately from game data. Reload resumes a conditional upload instead of merging newer cloud timestamps over the restore. |
| Conflict behavior | Preserves local data and pauses automatic sync. No automatic fetch-and-retry using a newer revision. The player choice UI and resolution protocol remain unfinished. |

Scope remains manual slots 1–12. Autosave 0 is not included. Settings are exported
but never restored by this host path until the game offers an explicit opt-in.
Unsupported future formats, wrong-game identifiers, invalid slot envelopes and
legacy single-slot files are rejected with an explanation. Unknown v1 envelope
metadata is ignored; slot payload strings remain intact. File/bundle limit is
8 MiB; the existing cloud API quota remains smaller, so local success can still
be followed by a cloud upload failure.

An import acknowledgment timeout means **result unknown**, not failure. Further
transfers/uploads are blocked until a matching late result resolves it. A general
operation-status query/reconciliation path across reloads is not implemented.
For signed-in imports made without a cloud baseline, the persistent restore
intent records a null revision: local import succeeds, but uploading requires an
explicit conflict decision rather than silently acquiring permission to overwrite.

## Disposition of your review

Your committed-source concern was correct: reading working files did not establish
what a builder would include. The game dependency has since been verified in
committed blobs at `bbd8b3d7b0309744481f8edf670362cf582b44e5`. That commit contains
protocol 2, ready capabilities and a DAL check of `persisted.ok` before publishing
imported data to memory. This supersedes the two source-level blockers in the
review; it does not establish that the currently served artifact contains the fix
or that interruption recovery passes in a browser.

Runtime capability checks remain mandatory. A source commit is never used as a
substitute for a ready message from the running game.

Your rollout change is incorporated. The private backend supports an optional
revision phase, with enforcement controlled separately. Legacy writes increment
the revision atomically so revision-aware clients can detect them. Full protection
against unconditional legacy writers starts only after enforcement; the migration
phase does not provide the same guarantee.

Existing records without a stored revision are accepted as revision zero **only
when the client expects zero**. Conditional PUT and DELETE return 409 on stale
revisions. DELETE retains a revision tombstone to prevent stale resurrection.
Malformed revisions, and missing revisions during enforcement, return 428.

## Files and ownership

The public changes are:

- `src/lib/saves.svelte.ts`: host bridge, transfer lifecycle and cloud ordering.
- `src/lib/save-transfer.ts`: envelope parsing, limits and correlated waiters.
- `tests/save-transfer.test.mjs`: isolated tests of the actual host module.
- `tests/e2e/test_save_sync.py`: updated browser adapter tests with a simulated
  same-origin game, chooser/download expectations and explicit acknowledgment.
- `package.json`: `test:saves` command.
- `docs/WEB_GAME_BOUNDARY.md` and the implementation plan: updated contract,
  rollout and acceptance requirements.

The private backend template and its five-test harness were changed locally under
the ignored infrastructure tree. They will not travel with a public Git commit.
Preserve and transfer them through the private source/deployment process; do not
force-add backend source to this repository. The private rollout parameter is
`RequireSaveRevision`, default `false`, passed as `REQUIRE_SAVE_REVISION`.

Host HEAD is still `d903a71a71b813362f23ddb5dd4018ab49faa0bc`; the implementation
is an uncommitted diff on that base. Unrelated dirty files and your review document
have been preserved. There is no new host implementation commit to deploy yet.

## Evidence and limits

| Check | Result |
| --- | --- |
| Host/protocol regression suite | 15 pass: origins/sources, correlation, stale sessions/accounts, durable acknowledgments, rejection, cancellation, timeout/late result, conflicts, reload intent and offline local import. |
| Private inline-backend tests | 5 pass: migration, stale writers, deletion tombstones, input validation and compatibility revision increments. The DynamoDB/auth adapters are isolated; this is not a live AWS test. |
| TypeScript, Python browser-test syntax, diff whitespace | Pass. |
| Astro production build | Pass; 62 pages generated. No deployment performed. |
| Browser adapter suite | Updated but not run: the available local Python lacks Playwright. |
| Actual exported-Godot round trip | Not run. No claim of durable game writes, restored screenshots/menu state or successful slot loading from these host tests. |
| Mobile/input/fullscreen | Not verified. |

## Next steps for App and the game owner

1. Review the public diff and preserve the private backend changes through the
   private source process. Agree the cloud conflict choice and resolution messages
   with the game owner; the current implementation intentionally stops at preserving
   local data and pausing sync.
2. Identify the first alpha export containing game commit `bbd8b3d7` and record
   its actual build identity. Run the browser adapter suite in a Playwright-enabled
   environment, then the real exported-game round trip: save A/B, export, change
   saves, import and confirm, inspect refreshed slots/screenshots, reload and load.
   Also import into a fresh browser context and verify unrelated storage survives.
3. Complete joint decisions/work for autosave scope, settings opt-in, local
   multi-tab writers and unknown-operation recovery. Exercise quota/storage failures
   and interruption recovery in the game, not just the host harness.
4. Commit the reviewed host changes and record that host commit alongside the
   game build in every integrated result. A mock adapter pass is not acceptance.
5. Coordinate rollout: revision-aware backend with enforcement off, matching
   game/host release after integration gates pass, then required revisions after
   client migration is measured. App owns deployment. Real supported mobile/input
   checks remain an explicit acceptance item.

No production browser saves were touched. No messages were sent through agent
bridges; this document is the handoff.
