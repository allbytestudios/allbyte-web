# Empty export after input recovery

Owner confirmed controls recover after cancelling the native chooser and after rejecting an empty backup. Selecting a newly exported file repeatedly reports no saved slots.

Live host trace for session `1791730261.914-3800251110` shows two selected files of 147 bytes, each validated with `slotCount:0`. A intervening export receives and matches a fresh `allbyte:all-saves` response. No import remains pending; the game is unpaused. The actual backup path has been requested but not yet inspected.

Source `DAL.getAllSavesForExport()` includes only durable, populated manual slots 1–12 with nonempty `partyData`. It excludes reserved autosave 0 and quicksave 13. The host previously downloaded the snapshot even when `saves` was empty; import correctly rejects that empty bundle. Export success therefore did not establish a useful saved-slot backup.

Local host fix: count slots in the fresh snapshot before generating a download, record bounded `export_snapshot.slotCount` metadata, and reject an empty export with an instruction to save to a numbered slot and an explanation that autosave/quicksave are excluded. The new regression verifies no empty download and a successful subsequent occupied export. No reserved-slot policy or game source was changed.

If the owner already sees occupied numbered slots, compare their durable storage and export filtering; do not conclude autosave-only state without that evidence. The selected file structure and normal manual-save/export/import round trip remain to verify. No save contents were inspected or changed.
