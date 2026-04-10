---
title: "Save Sync Without a Backend (Then With One)"
description: "How browser saves persist for everyone, plus an opt-in server backup for Hero and Legend subscribers — and the architectural choices behind keeping the in-game save the only save action."
pubDate: 2026-04-10T22:45:00Z
category: "technical"
devlog: "studio"
tags: ["godot", "saves", "architecture", "stripe", "subscription"]
draft: true
---

The Chronicles of Nesis is a tactical RPG with a save system that goes back to the very first prototype — six manual save slots, each storing party state, equipment, quest progress, treasure flags, and scene location. On desktop builds, those slots live in a SQLite database in the user's app data directory. On the web build, they live in browser `localStorage`.

`localStorage` is fine until the player switches devices. Or clears their browser data. Or wants to share a save. Or has anything happen to that browser, ever. I needed a way to let players back up and restore their saves manually, and I wanted to offer automatic cloud sync as an actual reason to subscribe to Hero or Legend tier on top of "you're supporting development" — which is a real reason but a soft one.

The constraint I gave myself: the in-game "Save" action must remain the only save the user ever has to think about. No "save to cloud" button. No "export to file" prompt every session. The game saves; everything else is invisible until the player wants to reach for it.

This is the design I landed on.

## Layers of truth

```
┌─────────────────────────────────────────────────┐
│  Layer 0: in-memory _all_saves[slotId]          │  ← what the game uses while running
├─────────────────────────────────────────────────┤
│  Layer 1: localStorage (con_nesis_save_N)       │  ← THE SAVE. Source of truth on the device.
├─────────────────────────────────────────────────┤
│  Layer 2: postMessage to parent web app         │  ← bridge to the host page (everyone)
│              │                                  │
│              ├── Manual file export / import    │  ← user-driven escape hatch (everyone)
│              │                                  │
│              └── Server upload                  │  ← cloud backup (Hero/Legend only)
├─────────────────────────────────────────────────┤
│  Layer 3: DynamoDB on the server                │  ← persistent cloud copy (Hero/Legend)
└─────────────────────────────────────────────────┘
```

The save is **considered successful when Layer 1 succeeds.** Layer 2 and Layer 3 are bonuses. If postMessage fails, log a warning and queue it for retry — do NOT roll back the localStorage write, and do NOT report a save failure to the player.

Layer 2 (the postMessage bridge to the parent web app) is shared by everyone, but what the parent does with it depends on tier. For all users, the parent keeps an in-memory cache of the latest saves so the "Save state" file download has something to write. For Hero and Legend subscribers, the same bridge also triggers a debounced upload to Layer 3 (cloud storage).

This separation is the most important architectural commitment in the whole feature. It's the thing that makes everything else simple. If the save flow had to wait for cloud confirmation before declaring success, every layer would have to handle every failure mode of every layer below it. By making each layer independently authoritative for its own scope, I get a system where Layer 1 is bulletproof, Layer 2 has graceful degradation, and Layer 3 is opt-in.

## Layer 1: localStorage as the foundation

Godot 3.6 doesn't have direct browser storage APIs, but it has `JavaScript.eval()` which runs arbitrary JS in the host. The HTML5 export's DAL writes saves with something like:

```gdscript
func _ls_save(key: String, value: String) -> bool:
    var escaped = value.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "\\n")
    var js = "localStorage.setItem('" + key + "', '" + escaped + "'); true;"
    return JavaScript.eval(js) == true
```

Six save slots, ~25-30 KB each, stored as JSON strings under keys `con_nesis_save_1` through `con_nesis_save_6`. (Recently bumped to 12 slots.) Total footprint ~360 KB, well under the 5 MB Safari quota. Storage size isn't the bottleneck for this game.

The thing that almost is a bottleneck: localStorage writes can silently fail. Incognito mode pretends to write but loses the data when the tab closes. Quota-exceeded throws on Chrome but fails silently on some Android browsers. Third-party storage blocking in iframes is a whole thing.

The mitigation is verify-after-write:

```gdscript
func _ls_save_verified(key: String, value: String) -> bool:
    _ls_save(key, value)
    return _ls_load(key) == value
```

If the read-back doesn't match, treat it as a save failure and surface it to the player. This catches incognito, quota exceeded, third-party blocking, and any future weirdness — all with one read.

The other thing the save flow does is **stay tight**. The save critical section only:

1. Reads from `_all_saves[slotId]`
2. Calls `JSON.print` to serialize
3. Calls `_ls_save_verified`
4. Notifies the parent (best-effort)
5. Returns a bool

It does not call any autoload menu's `update()` method. It does not trigger BBCode renders. It does not touch any cross-singleton chain. The reason: the worst real failure mode for this game on web is a WASM hang during the save flow, where the localStorage write may or may not have committed before the hang. If a menu re-render in the middle of the save can hang the engine, the player has no way to know whether their save succeeded.

This is the kind of rule that's cheap to establish at the start and a nightmare to retrofit.

## Layer 2: the postMessage bridge

The Astro web app hosts the game in an iframe. To tell the web app "a save just happened so you can sync it to the cloud," the game posts a message:

```js
{
  type: 'allbyte:save-changed',
  slotId: 1,
  data: '{"version":1,"timestamp":1712760000,...}'
}
```

The web app listens with a window message handler and stashes the data in its own in-memory cache. If the user has Hero or Legend tier, a debounced server upload fires 5 seconds after the last save (so a flurry of rapid saves only triggers one network call).

The protocol is small:

- **Game → Parent**:
  - `allbyte:ready` (with `protocolVersion` and `maxSaveSlots`)
  - `allbyte:save-changed` (per save)
  - `allbyte:all-saves` (snapshot in response to a request)
- **Parent → Game**:
  - `allbyte:request-saves` (ask for the current snapshot)
  - `allbyte:load-saves` (inject saves into the game's localStorage)
- Plus an `allbyte:load-complete` ack with `acceptedSlots` and `rejectedSlots`, so the parent knows whether a load actually succeeded or whether some slots were rejected (e.g., for version mismatch).

The reason all messages go through `postMessage` instead of having the parent read the iframe's `localStorage` directly: in development, the iframe is at `localhost:8060` (a CORS server) and the parent is at `localhost:4321` (the Astro dev server). Different origins, separate `localStorage`. In production they're same-origin, but I wanted one consistent code path that works in both.

There's an ordering rule: **the parent must NOT send `request-saves` or `load-saves` messages until it has received the `ready` event.** If the parent tries to inject saves before the game has finished loading, the game's in-memory state isn't authoritative yet and the load gets stomped.

To enforce this on the web side, I have a small queue:

```typescript
function postToGameWhenReady(message: any) {
  if (saves.gameReady) {
    postToGame(message);
  } else {
    preReadyQueue.push(message);
  }
}
```

When the `ready` event fires, the queue drains. This means a user can click "Load State" before the game has finished booting and the upload still works — it just waits until the game is ready to receive it.

## Layer 3: the cloud backup

Hero and Legend subscribers get an opt-in server-side save backup. The implementation is one Lambda and one DynamoDB attribute:

- `PUT /saves` — body is `{ saves: <json-string-blob> }`. The Lambda verifies the JWT, looks up the user, checks tier (must be `hero` or `legend`), validates that the blob is valid JSON and under 250 KB, then writes it to the user record as `saveData` with a timestamp `saveDataUpdatedAt`.
- `GET /saves` — returns the stored blob and timestamp, or 404.
- `DELETE /saves` — clears the blob (rare, but useful for "reset cloud sync").

The blob is the entire save snapshot as a JSON string — all 12 slots plus options and keymapping. ~360 KB max. DynamoDB items can be up to 400 KB, so this fits.

I considered storing per-slot rows for finer-grained merges, but the blob approach is simpler and the 5-second debounce means we're not doing high-frequency writes anyway. If the game saves twice in 5 seconds, one PUT goes out at the end. If the game doesn't save for an hour, no PUT goes out at all.

Conflict resolution between the server and local copy is per-slot last-write-wins. Each save's JSON has an embedded `timestamp` field. On login, the web app fetches the server saves, compares timestamps slot-by-slot, and merges:

```typescript
for (const [slotKey, serverSlotJson] of Object.entries(serverSnapshot.saves)) {
  const localSlotJson = merged[slotKey];
  if (!localSlotJson) {
    merged[slotKey] = serverSlotJson;
    continue;
  }
  const localTs = JSON.parse(localSlotJson)?.timestamp || 0;
  const serverTs = JSON.parse(serverSlotJson)?.timestamp || 0;
  if (serverTs > localTs) {
    merged[slotKey] = serverSlotJson;
  }
}
```

If the merged result differs from what's locally in the game, the parent sends an `allbyte:load-saves` message and the game updates its in-memory state and refreshes the load menu.

The edge case I'm not handling well yet: simultaneous play in two tabs. If a player has the game open in tab A on their laptop and tab B on their phone, each tab will sync independently and they could clobber each other. The fix is to detect concurrent sessions and warn — I'll add it when somebody hits it.

