# Repaired wrapper prepared for the next import test

Copied exactly the 15 inputs from `ROWAN_WEBBRIDGE_EXPORT_MANIFEST_2026-10-10.json` into `public/godot/public`, stripping `public/` and placing the three shared shell files from the export root into that destination. Verified each source before copying, every destination afterward, and all 15 actual HTTP responses against manifest SHA-256 hashes.

- Game source commit: `1d08cf8a7a2ad6b02301a2027a566de01ea9fbec`.
- Game version: `0.8.2813` (reused); export marker: `2026-10-10T15:58:13Z`.
- Host HEAD: `637176304d2ca00e0245e58340ab25c5b4604a18`, with existing local modifications; no new host commit or deployment was made.
- Loaded host stamp: `63717630·2026-10-09 18:01Z` from the existing running server.
- Server URL: `http://127.0.0.1:4325/play/`.

## Actual wrapper verification

A fresh disposable Chromium profile loaded the real Astro wrapper with reserved copilot ID `99101012`, without a debug token or import. The normal host initialization sent `allbyte:request-saves`; the host trace recorded the corresponding `allbyte:all-saves` response and `request_matched`.

Both game globals are functions. Startup reports `registered:true`, stage `registered`. Two fresh collector records for the same game session `1791680224.964-3311675863` have matching wrapper origin/path, host/game schema 1, advancing timestamps, and publisher HTTP 204 with no error. No JavaScript page errors were captured. These are direct collector reads; an additional CON-MCP observer call was not performed here.

Evidence: `.tmp/wrapper-ready-evidence.json`; verification script: `.tmp/verify-wrapper-ready.py`. Evidence contains protocol/diagnostic metadata, not save contents.

## Owner test remains pending

Reload `http://127.0.0.1:4325/play/?copilot=902009` in Windows Chrome. Preserve the origin/profile and saves. The existing dev proxy sends game assets with no-store; reused version numbers alone cannot establish freshness, so verify the new session's registration/startup and correlated host response before importing.

Read fresh `save_transfer_state.902009.json` from the existing collector and pin the new `game.sessionId`. Require registered startup, matching host origin/path, fresh timestamps, publisher status 204, and correlated receiver evidence before the chooser test.

First cancel the normal menu's file chooser and check input recovery. Then select a populated backup and verify responsive confirmation; Cancel must preserve saves. Only then deliberately confirm an import and verify durable acknowledgment, persistence after reload, and loading the resulting slot. Do not automatically repeat an unknown prior import.

This preparation verifies asset serving, registration, reception, and publication in the actual wrapper under a disposable profile. It does not accept Windows native chooser/input behavior or owner import persistence. No owner browser was driven, no owner storage was cleared, and no import was performed. No hosted promotion or service restart was made.
