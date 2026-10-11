# Manual saves only

Owner decision, 2026-10-08: deprecate cloud saves for now and prioritize working
manual save/export/import. Cloud conflicts must not lock users out of restoring
a backup. If cloud saves return, a conflict should be explained with an explicit
user choice rather than a dead-end error.

Implemented in the app working tree:

- Removed cloud fetch/upload, merge, debounce and revision/conflict handling from
  the save bridge. The exported sync entry points remain inert for compatibility.
- Signed-in and signed-out sessions both request their initial local snapshot.
- Account messages advertise `cloudSaves: false`.
- Manual import does not read/write cloud restore markers or consult cloud state.
  Old markers and previously stored server saves are not deleted by this change.
- Existing game overwrite confirmation, file validation, session/source checks,
  and durable game acknowledgment remain. Concurrent or unresolved game writes
  still require completion; these are independent of the removed cloud lockout.
- Privacy copy describes the currently available local/manual save behavior.

Do not simply reactivate the old cloud path later. Require explicit conflict
choices and review any retained restore markers before any cloud writes. A manual
import must remain usable even if the cloud is offline or has a competing copy.

Host verification: 22 tests passed, including signed-in consecutive imports with
a retained unresolved cloud marker, no cloud network requests, disabled account
capability, and preservation of acknowledgment gating. TypeScript check passed.
The former cloud-sync tests were replaced with the deprecation regression.
All five browser adapter checks and the 62-page production build also passed.

No backend data deletion, game edit or deployment is included.
