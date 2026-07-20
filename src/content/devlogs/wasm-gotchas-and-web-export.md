---
title: "Shipping Godot in the Browser: WASM Gotchas and Web-Export Learnings"
description: "A reference of the hard-won gotchas from shipping The Chronicles of Nesis as a Godot 4 WASM build: cross-origin isolation headers, silent single-thread hangs, the audio autoplay policy, renderer limits, the pack pipeline, and how to debug a runtime with no debugger."
pubDate: 2026-06-23T16:00:00Z
category: "engineering"
devlog: "godot-and-claude"
audience: "gamedev"
tags: ["godot", "wasm", "web-export", "browser", "debugging", "performance"]
draft: false
---

The Chronicles of Nesis is a 300MB tactical RPG. It runs in a browser tab at allbyte.studio as a Godot 4 WebAssembly export. Getting it there surfaced a long list of failures that the official export docs don't cover — and most of them are *silent*. The tab freezes with no error, a sprite renders with no texture, a function never runs with no warning. This post is the reference I wish I'd had: the concrete headers, flags, symptoms, root causes, and fixes, grouped by theme.

The single fact that explains most of this list: **the web export runs the entire engine on one browser thread.** Every synchronous call — `load()`, `.instance()`, an autoload `_ready()`, even some property accesses — blocks the JS event loop. When a block exceeds the browser's "I'm alive" heartbeat, the tab is marked unresponsive, and the only "error" you get is a frozen page. Almost everything below is a consequence of that.

This is scoped to browser/WASM/web-export issues, not the Godot 3→4 engine migration (separate post). The examples are Godot 4 (`OS.get_name() == "Web"`, `JavaScriptBridge`, `@onready`); many of these gotchas were first discovered on the 3.5 web export and carried straight across the engine jump, because they're properties of the browser, not the engine version.

## Cross-origin isolation: the headers without which nothing loads

The web export uses `SharedArrayBuffer` for engine internals. Browsers only allow `SharedArrayBuffer` in a **cross-origin isolated** context, which requires **every** response from the server to carry:

```
Cross-Origin-Opener-Policy: same-origin
Cross-Origin-Embedder-Policy: require-corp
```

Without these, the engine fails to initialize and you get a blank canvas — no error, just nothing. `COOP: same-origin` isolates the browsing-context group so other-origin tabs can't get a reference to your window. `COEP: require-corp` requires every embedded resource to opt in to cross-origin loading via CORS. Together they form the isolated context that `SharedArrayBuffer` is gated on (the gate exists because high-precision shared timing enables Spectre-style attacks).

The host has to set these. The support matrix that actually matters:

| Platform | Verdict | Notes |
|---|---|---|
| Netlify / Cloudflare Pages | Works | `_headers` file in build root |
| Vercel | Works | `headers` array in `vercel.json` |
| Self-hosted nginx / Caddy | Works | header directive per location |
| GitHub Pages | **Will not work** | Cannot set custom response headers. No workaround. |
| itch.io | Conditional | Some accounts can request COOP/COEP via the dashboard; check first |

For local dev, `python -m http.server` gives you a blank page because it omits the headers. Subclass the handler:

```python
class CORSHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cross-Origin-Opener-Policy", "same-origin")
        self.send_header("Cross-Origin-Embedder-Policy", "require-corp")
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        super().end_headers()
```

Two more host-side things that cost real startup time if you get them wrong:

- **`.wasm` MIME type must be `application/wasm`.** Served as `application/octet-stream` (the default for unknown extensions), the browser can't stream-compile and uses a slower path — roughly +1s startup.
- **Compress the `.wasm`.** It drops to ~25% of original size with gzip/brotli. A 20MB binary becomes a 5MB transfer.

One asymmetry worth flagging if you embed the game in an iframe alongside other tools: `require-corp` is the strict mode. If a page needs to embed something that doesn't send `Cross-Origin-Resource-Policy` (an analytics iframe, a Grafana panel), that page can't be cross-origin isolated and the embed will break under `require-corp`. The two needs are mutually exclusive per-page — you isolate the game page and exempt the others.

## The bootstrap pattern: why a 300MB project can't export directly

Every `class_name` script in a Godot project loads at engine init. On native that's a couple of seconds. On WASM each one requires the JS event loop to dispatch into the module, parse the script, register the class, and return — and with ~90+ scripts the cumulative blocking time exceeds the tab-responsive threshold. The engine never reaches your `_ready()`. The tab just hangs.

There is no middle ground here: either the engine reaches your `_ready()` or it doesn't. If you have fewer than ~30 `class_name` scripts and under 50MB of assets, try a direct export first. Past that, you need a three-tier split:

- **Tier 1 — Bootstrap (~15–40MB, loads immediately):** all `class_name` scripts (they *must* be at engine init — they can't be dynamically loaded), all autoloads, the title screen, core UI assets, and the test bridge.
- **Tier 2 — Core gameplay (~300KB, downloaded on demand):** a `.pck` with gameplay essentials not needed at the title.
- **Tier 3 — Zone packs (~3–5MB each, per area):** one `.pck` per zone, self-contained.

The pack download path does **not** use Godot's `HTTPRequest` — it's broken on web in non-trivial ways (no chunked responses, polling-based progress that freezes the loop, no StreamPeer access). Use JS `fetch()` + Emscripten `FS.writeFile()` instead, then merge with `ProjectSettings.load_resource_pack()`:

```
Title renders → "New Game" clicked
   ↓ JS fetch() downloads Core.pck + LariaVillage.pck
   ↓ FS.writeFile() writes the bytes into Emscripten's in-memory FS
   ↓ ProjectSettings.load_resource_pack(path) merges them into res://
   ↓ ResourceLoader can now find pack resources
```

When you add a new `class_name` to a bootstrap script, the editor rewrites `project.godot`'s `_global_script_classes`. Expect that diff after every reimport — it's a side effect, not a bug.

## Silent hangs: the translation rules

These are write-time patterns that prevent the single-thread hangs. They're codified as machine-checkable audit rules (`WC-01` through `WC-12`) so a tool can flag a violation before export. Each is a real failure mode, not a hypothetical.

### WC-01 — Guard `Input.set_mouse_mode()` for non-VISIBLE/HIDDEN modes

The web export only supports `MOUSE_MODE_VISIBLE` and `MOUSE_MODE_HIDDEN`. `CONFINED` and `CAPTURED` hard-crash the WASM module — the browser's sandbox gives the user, not the game, control over pointer lock.

```gdscript
if OS.get_name() != "Web":
    Input.set_mouse_mode(Input.MOUSE_MODE_CONFINED)
```

### WC-02 — Guard `preload()` of non-bootstrap resources

`preload()` resolves at script-compile time, *before* any pack downloads have happened. If the resource lives in a zone pack, the compiled script references a resource that doesn't exist yet and the runtime hangs trying to resolve it. This is one of the most common silent-hang causes when porting.

```gdscript
# BEFORE — hangs if hit.wav lives in a zone pack:
@onready var attackSFX = preload("res://SFX/hit.wav")

# AFTER — runtime resolution gated by an existence check:
@onready var attackSFX = (
    load("res://SFX/hit.wav")
    if ResourceLoader.exists("res://SFX/hit.wav")
    else null
)
```

### WC-03 — Replace per-frame `print()`

Godot's `print()` on WASM goes through a buffered C++→JS→stdout path. Calling it per-frame overflows the buffer and **fully freezes Firefox**, and noticeably slows Chrome. For one-shot diagnostics, `JavaScriptBridge.eval("console.log(...)")` goes straight to the browser's `eval()` and is more reliable — but even that saturates in a hot loop, so for per-frame telemetry write to a JS variable and read it from outside.

### WC-04 — Never access autoload `const` dictionaries per-frame

Per-frame access to a `const` dictionary on an autoload singleton inside `_physics_process` **permanently hangs WASM**. The mechanism is unclear (suspected to be the GDScript variant lookup through autoload script context) but it's reproducible. Critically, **`.duplicate()` is not a workaround** — it has the same hang. Only a manual `for k in dict` loop produces a safe local copy:

```gdscript
var _walk_map_cache = null
func _ensure_map_cache():
    if _walk_map_cache == null:
        _walk_map_cache = {}
        for k in Utility.WALK_MAP:        # NOT .duplicate() — that also hangs
            _walk_map_cache[k] = Utility.WALK_MAP[k]
```

### WC-05 — For held actions, use `Input.action_press()` not synthesized `InputEventAction`

An `InputEventAction` pushed via `parse_input_event` fires `_input(event)` exactly once, in the same frame. The action state does **not** persist to subsequent `_physics_process` calls. To simulate a held button across frames, use `Input.action_press()` / `action_release()`, which set the engine's action state directly. (Refinement: one-shot synthesized presses — menu clicks, dialogue advance — *do* work fine; this only bites when you need a button *held* across multiple frames.)

### WC-06 — Use threaded/interactive loading for complex scenes

`load()` is synchronous and walks the entire sub-resource tree (textures, fonts, child scenes, scripts) in one call — hundreds of milliseconds of blocking for a non-trivial `.tscn`, well past the responsive threshold. The fix is the non-blocking loader, polled with a time budget, yielding a frame between chunks. On Godot 3 this was `ResourceLoader.load_interactive()` + `poll()`; on Godot 4 it's `load_threaded_request()` + `load_threaded_get_status()`:

```gdscript
func _threaded_load_scene(path: String):
    if not ResourceLoader.exists(path):
        return null
    if ResourceLoader.load_threaded_request(path) != OK:
        return ResourceLoader.load(path)  # fallback: sync, blocks
    while true:
        var status := ResourceLoader.load_threaded_get_status(path)
        if status == ResourceLoader.THREAD_LOAD_LOADED:
            return ResourceLoader.load_threaded_get(path)
        if status in [ResourceLoader.THREAD_LOAD_FAILED, ResourceLoader.THREAD_LOAD_INVALID_RESOURCE]:
            return null
        await get_tree().process_frame   # the loading screen ticks here
```

On WASM without SharedArrayBuffer threading, the "threaded" loader **time-slices on the main thread** — each status poll processes one chunk and returns. The `await get_tree().process_frame` between polls is what gives the engine paint+input frames.

### WC-07 — Guard `get_tree().quit()`

Browsers can't "quit" — there's no process to exit. `quit()` is accepted but does nothing useful. Reload or redirect instead:

```gdscript
if OS.get_name() == "Web":
    JavaScriptBridge.eval("window.location.reload()")
else:
    get_tree().quit()
```

### WC-08 — Guard `user://` filesystem access

`user://` on web is backed by IndexedDB via Emscripten's IDBFS. `OS.is_userfs_persistent()` returns true if IndexedDB is available — but **gives false positives**, returning true even when the FS silently fails to write (incognito, blocked third-party cookies in an iframe, cleared site data, exceeded quota). Always have a fallback path; this codebase uses `localStorage` for save state.

```gdscript
if OS.is_userfs_persistent():
    # IndexedDB available — but still not guaranteed to succeed
else:
    # localStorage / server saves / warn the user
```

One more subtlety: writes to `user://` go to in-memory MEMFS first and aren't persistent until `FS.syncfs()` runs. Close the tab before the sync and the data is gone.

### WC-09 — `call_deferred` + `return`: never let the sync and deferred paths both run

The most insidious hang on the list. `call_deferred` queues a function for the next idle frame but does **not** return early from the current one. If the synchronous fallthrough runs the same heavy work the deferred path was meant to spread out, it hangs WASM *before the deferred call ever fires*.

```gdscript
func _ready():
    if OS.get_name() == "Web":
        call_deferred("_web_deferred_ready")
        return                 # ← THE FIX: don't fall through
    _do_heavy_layout()         # only runs on desktop
```

Finding the missing `return` was the single biggest unblocker in the menu-debugging session that produced this list.

### WC-10 — Stub global state with empty containers, not example values

When the bootstrap project needs to satisfy code that expects a fully-populated singleton (`GlobalWorld.party.data.currency`, `GlobalWorld.getCurrentParty().values()`), populate the stub with **empty** dictionaries and arrays. Loops over the singleton typically `.instance()` a heavy scene per entry. With an empty stub, the loop is a no-op. With one example entry, the loop runs and instances resources that often aren't even in the bootstrap pack — and hangs.

```gdscript
# BAD — looks helpful, hangs:
var party := {"Elias": StubUnit.new()}
# GOOD — code that loops over it is a no-op:
var party := {}
```

The companion rule: a minimal stub exposes only the values the immediate consumer reads, with empty containers for anything iterable. Before adding an entry, grep every loop that iterates the collection — stubbing a field to fix function A often causes a different hang in function B.

### WC-11 — Use `ProjectSettings` for resolution, not the live window size

Reading the *live* window size for layout — `OS.window_size` in Godot 3, `get_window().size` / `DisplayServer.window_get_size()` in Godot 4 — bites on web. On desktop it matches the project resolution; on web it returns the browser *canvas* size, which depends on CSS, viewport meta tags, and device pixel ratio. With stretch mode `canvas_items` + aspect `keep`, the internal viewport stays the project resolution — but the live window size doesn't, so UI laid out against it (dialogue boxes, menus, overlays) comes out wrong on web. Read the fixed project resolution instead:

```gdscript
var projectResolution = Vector2(
    ProjectSettings.get_setting("display/window/size/viewport_width"),
    ProjectSettings.get_setting("display/window/size/viewport_height")
)
```

### WC-12 — Guard `load()` with `ResourceLoader.exists()`

On desktop, `load()` of a missing resource returns `null` and prints an error. On WASM the fetch can block the main thread indefinitely — the browser requests the file, gets a 404, and the synchronous bridge doesn't handle the error gracefully. `ResourceLoader.exists()` checks the import index without triggering a fetch, so check first.

## More hangs the rules don't cover yet

A few WASM hang families that the static rules can't catch by reading code, all discovered the hard way:

- **Recursive `call_deferred` drains synchronously and OOMs the MessageQueue (gotcha #65).** Godot's deferred-call queue drains *to empty* once per frame. A deferred call that re-defers itself — directly, or via a signal handler it invokes (a turn loop, a state-machine tick) — is processed in the *same* drain pass, not the next frame, looping until the ~32MB queue fills. On desktop you get `ERROR: Message queue out of memory`. On WASM the tab silently locks because the drain blocks rendering, input, and console flush. **Fix: prepend `await get_tree().process_frame` at the top of the deferred function** — the call site doesn't help; only the receiving function can force a real frame boundary mid-drain. The error string naming your own function (`_advance_turn_after_action message queue out of memory`) is the tell.

- **Runtime `load()` of a brand-new `class_name` script OOMs the 2GB heap at boot (gotcha #64).** Add a `.gd` with a `class_name` and consume it via runtime `load()` (not `preload()`), and Godot 4 web tries to register the class in the global registry during boot. The allocation cascade asks the linear memory to grow past `2147483648` bytes (exactly 2³¹). You get `Cannot enlarge memory, requested ... bytes, but the limit is 2147483648 bytes!` followed by `Aborted(... corrupted its heap memory area (address zero))`. **Fix: `const _MyScript := preload("res://Path.gd")`** — preload bakes the script into compile-time references and sidesteps the runtime registration.

When a hang slips through anyway, the debugging procedure is in the **Debugging** section below.

## The bug that left no error: `:=` on a web export

Some failures hang. This one did the opposite — it made entire menus render *nothing*, with a completely clean console.

The symptom: open the Equipment menu and it appears… empty. Call `EquipmentMenu.showV(true)` and nothing happens — no error, no warning, no stack trace, just a silent no-op. Skills and the Skill Tree did the same thing. Three menus, all "opening," all drawing blank.

The culprit was a single character: `:=`.

In Godot 4, `var x := some_expr` is the *inferred-type* assignment — the engine resolves the variable's type from the right-hand side at parse time. It's tidy, and on desktop it's harmless. But it carries a requirement: the RHS type has to be **statically resolvable**. And game code returns `Variant` everywhere — autoload property lookups, dictionary access, `get_node()` chains, `JavaScriptBridge.eval()` calls bridging into the browser. When the inferred type can't be resolved, the script doesn't run *wrong* — it fails to **load at all**. The class quietly registers as a bare placeholder `Node`, and every method you call on it does nothing. No error, because from the engine's point of view there's simply no method there to fail.

On a desktop build you might catch it. On a WASM/web export — the script-class registry behaving slightly differently, no friendly editor in the loop — it just vanishes into a silent dead end. There were **107** of these `:=` assignments across the three menu files; converting each one to a plain `var x = some_expr` brought all three menus back to life in a single pass.

The fix is almost anticlimactic — drop the colon. The lesson is the part that's easy to over-correct: `:=` isn't the villain, **unresolvable right-hand sides** are. Literal and clearly-typed assignments are perfectly safe and worth keeping on purpose:

```gdscript
const ELIAS_PATH := "res://Sprites/Allies/Elias/IdleDown.png"   # fine — String literal
var hp := 3                                                     # fine — int
var dir := Vector2(1, 1)                                        # fine — constructor
var unit = some_autoload.get_current_unit()                    # use '=' — returns Variant
```

So the rule that went into the web-export catalog is scoped: reach for `=` the moment the right-hand side is a `Variant`-returning expression; keep `:=` for literals and obvious constructors. It's invisible until it isn't — another reminder that on a web export, "no error" doesn't always mean "no problem."

## Rendering: GLES2, and the textures that vanish

**Use GLES2 for web.** The list of things that break on GLES3 in browsers is longer than what you gain. WebGL 1.0 (GLES2) has ~99% support; WebGL 2.0 fails on older iOS, Safari before 15, and some Android stock browsers. GLES2 costs you GPU particles (use `CPUParticles2D`), HDR/glow, screen-space effects (SSR/SSAO), GIProbes, and several shader builtins (`textureSize()`, `dFdx`/`dFdy`, `fwidth`, dynamic shader loops) — none of which a 2D tactical RPG misses.

Two project settings that matter: set `quality/driver/fallback_to_gles2 = false` (otherwise you have to maintain an ETC variant of every texture), and `rendering/quality/driver/driver_name = GLES2`. Color-space caveat: GLES2 outputs sRGB, GLES3 linear — a custom shader emitting color looks different between them. The `OUTPUT_IS_SRGB` macro is defined for GLES2 builds.

The nastier rendering gotchas are silent texture failures from the pack split:

- **Cross-pack `ext_resource` references resolve to null (WC/gotcha — Rule 16, #58).** A `.pck` is exported from a *single* project tree; the exporter only walks that tree to resolve `ext_resource` paths. If a `.tscn` in Combat references a sprite that lives in the bootstrap pack, the path string is preserved in the binary but **no asset bytes are bundled**. At runtime the node's `texture` comes back `null` — no error, no warning. Visual: an invisible sprite over a working backdrop. The two packs only merge at runtime when both are mounted into the same `res://`, so the fix is to leave the node textureless in the `.tscn` and assign it in `_ready()` via runtime `load()` guarded by `ResourceLoader.exists()`:

```gdscript
const ELIAS_IDLE_PATH := "res://Sprites/Allies/Elias/IdleDown.png"
func _ready() -> void:
    if ResourceLoader.exists(ELIAS_IDLE_PATH):
        $Units/Elias.texture = load(ELIAS_IDLE_PATH)
```

- **Sprite2D in an instanced PackedScene inside a y_sort parent doesn't init its GPU texture on first render (gotcha #59).** The sprite exists, `visible = true`, the texture is assigned in the `.tscn` — but the canvas-item dirty flag isn't set when the scene is first drawn inside a y_sort parent after pack loading, so it's invisible. `call_deferred` and `await get_tree().process_frame` are both unreliable here because pack loading can drop deferred callbacks. The workaround is to reassign `sprite.texture = sprite.texture` after a few frames to force the dirty flag:

```gdscript
var _f := 0
func _process(_d):
    _f += 1
    if _f < 3: return
    set_process(false)
    sprite.texture = sprite.texture   # forces canvas-item dirty
```

- **Shader warmup.** First-time render stutter on web is on-demand WebGL shader compilation — the first fireball or shader-heavy menu freezes ~500ms while the browser compiles. During the loading screen, render every material once on a hidden node (off-screen or `modulate.a = 0.01`) for one frame to force compilation into the cache, then free the warmup node.

## Audio: the autoplay policy and the OGG decode stall

Browsers block automatic audio until the user has interacted with the page. A `play()` before the first click is silently rejected, so an autoload that starts music in `_ready()` emits nothing on first load. Don't try to bypass it — start the soundtrack on the first real input (the "New Game" button click is a natural place):

```gdscript
func _on_NewGame_pressed():
    if not BackgroundMusic.is_playing():
        BackgroundMusic.start_song("LariaTheme")
```

Godot 4's web export drives audio through an `AudioWorkletNode` (Godot 3.5 used the now-deprecated `ScriptProcessorNode`). Use OGG Vorbis (works everywhere; WAV balloons the bootstrap PCK).

The non-obvious one — **the first `play()` of any OGG blocks the main thread on `vorbis_init` (gotcha #69).** `load()` is cheap (~8ms — `ResourceLoader` caches the decoded resource bytes) but the *decoder state* is materialized lazily on the first `play()` of that specific stream: vorbis header parse, codebook unpacking, initial seek. In this codebase `BattleTheme.ogg` cost ~640ms on its first play — a half-second canvas freeze mid-jump-animation when an encounter starts.

What does **not** work: a pre-warm pass that only calls `load()` (the cache reports a hit but the next `play()` still pays the decode); deferring `play()` (just shifts the freeze to a frame boundary); or warming a *different* OGG first (decode state is per-asset, doesn't propagate). What works is an `AudioWarmer` autoload that, at pack-mount time (under the loading screen), plays each needed OGG at `volume_db = -80`, waits one frame, then sets `stream_paused = true` — and **keeps the warmer player alive**:

```gdscript
func warm(path: String) -> void:
    if _warmed.has(path) or not ResourceLoader.exists(path):
        return
    _warmed[path] = true
    var p := AudioStreamPlayer.new()
    add_child(p)
    p.stream = load(path)
    p.volume_db = -80.0
    p.play()
    await get_tree().process_frame
    p.stream_paused = true   # KEEP ALIVE — do NOT stop() or queue_free()
```

The decoder cache is bound to the `AudioStreamPlayback` instance lifetime, not the resource. The original sketch called `stop(); queue_free()` and cold-play still cost 229ms; keeping the warmer resident dropped it to 37ms. Cost is one tree node + ~500KB of decoded buffer per asset.

## Input: focus, the five sources, and what tests can't synthesize

Keyboard input only fires when the canvas has focus. Set `html/focus_canvas_on_start = true`, and know that some browsers still need a click first; clicking outside the canvas loses focus. Fullscreen and pointer lock can only be triggered from inside an active input handler (a button's `pressed` signal, or `_input` on an action press) — never from `_ready` or a timer. That's browser-mandated. When the tab loses focus, `_process`/`_physics_process` halt; the game pauses until focus returns, and you can't override it.

A Godot web game can receive input from five distinct sources, each with its own code path: keyboard, mouse, real touch, gamepad (polled via `navigator.getGamepads()` each frame, and not detected until a button is pressed), and Playwright-synthesized input. The one that bit testing: **Playwright's synthetic touch events do not reliably trigger Godot's `godot_js_input_touch_cb`.** A capture-phase listener confirms `touchstart`/`touchend` reach the canvas DOM, but Godot's registered callback doesn't fire (suspected `isTrusted`/internal-flag check on synthetic events). Real fingers on real mobile browsers work fine — it's strictly a test-harness limitation, tracked as `xfail`.

Two more UI-input gotchas specific to web popups:

- **`MOUSE_MODE_HIDDEN` doesn't stop `mouse_entered` signals or native button activation (gotcha #61).** It hides the OS cursor but Godot still tracks the internal mouse position, so hover signals fire and clicks activate the button under the hidden cursor — corrupting WASD navigation state. Fix: also set `mouse_filter = MOUSE_FILTER_IGNORE` on interactive Controls while in WASD mode, restore to `MOUSE_FILTER_STOP` when switching back.
- **An `OptionButton` popup confirmed via Enter leaks the same Enter to the next focused Control (gotchas #62/#63).** The popup is an HTML5 subwindow with input priority, so the parent's tracker variables stay stale, and the Enter that confirms an item keeps propagating down the focus chain and activates an unrelated sibling button. Fix: fall back to `popup.get_focused_item()` when the popup is open, and set `focus_mode = FOCUS_NONE` on sibling Controls while it's open (restore via `call_deferred` so the same-frame Enter still sees them as unfocusable).

## Memory: the linear-memory model and fragmentation crashes

A WASM module has one growable `ArrayBuffer` — its linear memory. Godot allocates one for the entire engine + game state. Every `memory.grow` copies the whole existing buffer into a larger one, so frequent growth is expensive; set the initial size for a typical session plus headroom. Practical max is ~2GB on Chrome/Firefox desktop, ~1GB on most mobile, less on iOS Safari.

The crash that confuses people: **fragmentation OOM**. Load 300MB into `PackedByteArray`s, free them, load another 300MB, and the browser may not find a contiguous block large enough even though there's free RAM. Symptoms: runs fine for ten minutes then crashes on a scene transition; `RuntimeError: index out of bounds` with no script-level cause; a mobile tab kill on a browser that should have plenty of memory. Mitigations: reuse `PackedByteArray` instances, avoid load/unload cycles (load a zone once and keep it resident), and watch Monitor → Memory for unbounded climb.

Decoding the DevTools errors:

- **`index out of bounds`** in a Godot context almost always means a `PackedByteArray` exceeded its allocated heap — look at asset loads, large `JSON.parse`, save serialization. Rarely a GDScript logic bug.
- **`LinkError` during instantiation** means the `.wasm` was served with the wrong MIME type, the COOP/COEP headers are missing, or the binary is truncated. Check the network tab: 200, `application/wasm`, full size.
- **`Aborted(...)`** is an Emscripten panic; the text after `Aborted(` names the failed assertion.

## Loading screens are structurally impossible by default

Single-threaded WASM has zero concurrency. The intent of a loading screen — "animate while work happens in the background" — assumes there's a background. There isn't. While the engine is inside a synchronous loader call, *every* animation source freezes: `_process`, `Timer` signals, `AnimatedSprite2D`, `Tween`, `AnimationPlayer`. And `process_mode = ALWAYS` does **not** save you — it opts a node out of `SceneTree.paused`, but here the loop itself is suspended; there's nothing to opt back into.

Some blocks you can fix, some you can't:

- **Family (a) — chunk it.** Decompose the work and `await get_tree().process_frame` between pieces (a 200-file JSON parse, yielding every 10 files). Works when the work is your code and decomposable.
- **Family (b) — design around it.** For atomic primitives that can't be chunked (`ProjectSettings.load_resource_pack()` has no async API), hide the animated UI right before the block and restore it right after. A frozen frame is uncanny; a brief absence is invisible. Bracket the call with `set_animated_visible(false/true)`.
- **Family (c) — JS-side overlay.** Render the loader in HTML/CSS *outside* the WASM canvas; the browser keeps painting it at 60fps even while WASM is suspended. Most polished for long, unknown-duration loads, but needs a custom HTML shell and a JS bridge.

Rough decision matrix: under ~100ms, don't bother (no visible freeze); 100–500ms, chunk if you can, else design-around; 500ms–2s, design-around; over 2s or unknown, JS overlay. This codebase uses (a) for chunkable work and (b) for the pack-mount block.

A diagnostic that earns its keep: instrument the loading screen with **five independent animation mechanisms** (a 100ms Timer, a 50ms Timer, a `_process` counter, an `AnimatedSprite2D` frame, and a `_process`-driven rotation), each driven by a different engine subsystem, sampled at 100ms. If all five freeze together during a load window, the WASM main thread is genuinely blocked. If only one freezes, it's a per-mechanism regression, not a thread block. Distinguishing those is the difference between "fix the call site" and "fix one node."

And a testing trap: a window-level "did each probe ever change?" assertion **passes even with a visible freeze** if the window is long enough that probes advance before and after the freeze. Assert *continuity* (maximum inter-sample gap under, say, 250ms), not just net advancement.

## Networking: what works and what doesn't

| API | Status |
|---|---|
| `WebSocket` (client) | Works |
| `WebRTC` (incl. data channels) | Works |
| `HTTPClient` / `HTTPRequest` | Limited — no StreamPeer, no blocking mode, no chunked responses |
| `MultiplayerENet` (UDP) | Does not work (no UDP in browsers) |
| Raw TCP sockets | Does not work |

Prefer JS `fetch()` over `HTTPRequest` for downloads (accurate progress, streaming, native error handling). And remember CORS applies to the game's own HTTP requests separately from the COOP/COEP headers the host needs — a third-party API must send `Access-Control-Allow-Origin` for your origin.

## Threading: leave it off unless you've profiled

The web export is single-threaded by default. The `Thread` class exists but no-ops or runs synchronously. Enabling real threads requires a threaded export template, COOP/COEP cross-origin isolation (so Emscripten can use `SharedArrayBuffer` + Web Workers for pthreads), and a browser that supports it. For a typical 2D game it isn't worth it: narrower browser support, harder debugging, and most performance problems are allocation / draw-call / main-thread-blocking issues that threads don't fix. Enable it only for a specific CPU-bound workload that profiles cleanly and parallelizes well. (The threaded build is the biggest unpulled lever for *initial WASM compile* speed on multi-core phones — the COOP/COEP infra is already in place; it's an export-preset flip.)

## Debugging a runtime with no debugger

You can't attach a normal debugger to a frozen WASM tab. The procedure that works, distilled from a long menu-hang arc:

1. **Identify the trigger.** What user action caused it? Engine init points at an autoload `_ready()` chain; a scene transition at the next scene's `_ready()` or missing pack resources; first input at an `_input` handler or a lazy `.instance()`. Add one print at the top of the suspected entry function to confirm — if it doesn't appear, re-aim.

2. **Try the cheap fix first.** Before any tracing, scan the suspect chain for the known anti-patterns: a missing `return` after `call_deferred` (WC-09), per-frame autoload const access (WC-04), synchronous `load()` of a complex `.tscn` (WC-06), a null deref from a missing stub field (WC-10). These are 30-second fixes, and each export+test cycle is ~30s, so they pay off before instrumentation.

3. **Binary-search with markers between calls, not inside them.** Place all markers in one editing pass (the bottleneck is export count, not marker count), with unique greppable tags. The hang is at-or-after the call following the *last logged marker*.

4. **Mind the buffered-output caveat.** WASM `print()` queues several lines before flushing, so the last marker you see is an **upper bound** — the real hang can be up to ~5 calls later, especially when those calls cascade. `JavaScriptBridge.eval` bypasses Godot's buffer but the CDP layer reorders events. For ground truth, push markers into a JS array (`window._myLog.push(...)`) and read it via `page.evaluate` while the page is responsive. This is the single biggest source of misdiagnosis.

5. **Bypass-test to confirm, with an `if` guard, not `return`.** `return` masks downstream symptoms; a targeted `if OS.get_name() != "Web":` around the suspect isolates only it, so a second hang downstream still surfaces. Bypass guards are scaffolding — they keep desktop working while you debug; they are not the fix.

6. **Distinguish "hung" from "completed but invisible." Pixels don't lie.** A test reporting "menu didn't open" can mean the menu opened off-screen, behind another node, at alpha 0, polled before the next render frame — or that the test bridge tracks the wrong field. In the canonical case, `menuShown=False` looked like a hang for a long time; the screenshot showed the menu fully rendered with all nine buttons. The bug was the test bridge reading `SaveLoadMenu` instead of `MenuOverlay`. When state-tracking disagrees with a screenshot, the state-tracking is wrong.

7. **Fix the root cause, then strip the markers and catalogue it.** Common fixes map to the table above (defer heavy `_ready()` work, threaded-load complex scenes, lazy-cache const dicts with a `for` loop, empty stub containers). Strip diagnostic prints with `git diff` (the uniform tag prefixes make them findable), because any marker left in a hot loop will eventually trip the per-frame-`print` freeze (WC-03).

Two harness facts underpin all of it: `page.evaluate()` blocks while WASM is in-frame (use timeouts — a tight loop means it never returns), and `page.keyboard.press()` blocks if WASM is hung when you press (which is itself a signal: a hang during the press vs during a later state poll tells you whether the input handler locked the thread or the previous frame already did).

When the runbook runs out, read the source — full clones of Godot, Emscripten, and Playwright are kept locally for exactly this. The four files worth knowing: `platform/javascript/os_javascript.cpp` (OS layer, FS, threads), `javascript_singleton.cpp` (`JavaScriptBridge.eval`), `core/io/resource_loader.cpp` (`load`/threaded load), and Emscripten's `src/library_idbfs.js` (`user://` persistence).

## The short version

- Set `COOP: same-origin` + `COEP: require-corp` on every response, serve `.wasm` as `application/wasm`, and compress it. GitHub Pages can't do the headers — don't try.
- Past ~30 `class_name` scripts or ~50MB, ship a minimal bootstrap project and stream the rest as `.pck` files via JS `fetch()` + `FS.writeFile()`, not Godot's `HTTPRequest`.
- The whole hang list is one thread blocking: guard `set_mouse_mode`, `preload`, `print`, per-frame const dicts, sync `load`/`.instance`, `quit`, `user://`, `call_deferred` (always `return`), populated stubs, the live window size, and unchecked `load()`.
- Use `=`, not `:=`, when the right-hand side returns `Variant` — inferred-type assignment that can't resolve its type silently fails to load the whole script on a web export (blank menus, clean console). Keep `:=` for literals and constructors.
- GLES2 for the renderer. Watch for cross-pack textures resolving to null (assign at runtime, not via `ext_resource`).
- Start audio on the first input; keep a resident paused `AudioStreamPlayer` per OGG to dodge the first-play vorbis decode stall.
- A loading screen can't animate over an atomic blocking call — chunk it, hide-and-restore around it, or render the loader in HTML/CSS outside the canvas.
- You can't attach a debugger: try the cheap fix, binary-search with markers between calls, trust screenshots over state, and remember buffered `print` is an upper bound.
