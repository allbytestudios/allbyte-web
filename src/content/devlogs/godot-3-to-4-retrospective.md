---
title: "Godot 3.6 to 4.6: A Migration Built on Silent Failures"
description: "Migrating The Chronicles of Nesis from Godot 3.6.2 to 4.6.2. What convert3to4 missed, the rename-by-rename catalog of silent failures, and the .tscn migrator that did the mechanical bulk."
pubDate: 2026-06-23T15:00:00Z
category: "engineering"
devlog: "godot-and-claude"
tags: ["godot", "migration", "gdscript", "tooling", "tscn"]
draft: false
---

The shipping web build of The Chronicles of Nesis runs on Godot 4.6.2. It started on Godot 3.6.2. This is the retrospective on the engine version jump — what broke, how I translated it, and which class of bug ate the most time.

This post is strictly about the **3.x → 4.x engine migration**. The browser/WASM-specific failures (single-threaded hangs, pack loading, the loading-screen freeze problem) are a separate story. Here I only care about what changed because the engine version changed, on any platform.

The headline finding: Godot's own `convert3to4` converter caught almost none of the bugs that actually hurt. The expensive ones were **silent failures** — code that parses cleanly, runs without an error, and behaves wrong. No parse error, no runtime warning, no `--check-only` diagnostic. Just the wrong pixels on screen, or no pixels at all.

## What convert3to4 does and doesn't catch

The converter handles the obvious mechanical renames in `.gd` source — `yield` → `await`, `OS.get_time()` → `Time.get_time_dict_from_system()`, the method-not-found stuff that the parser would flag anyway. That part is fine.

What it misses is everything where the **old name still parses in Godot 4**. Godot 4 is loose enough that a stale Godot 3 property assignment or method call frequently resolves against the engine's stub surface, binds nothing, and returns a default. The converter has no way to know that `t.create_from_image(img)` used to populate `t` and now doesn't. So it leaves it alone, and you ship a blank texture.

Every rule below was discovered the hard way, by chasing a visible symptom back to a rename the converter didn't make.

## The .tscn side: mechanical, and tooled

Scene files (`.tscn`) and standalone text resources (`.tres`) carry a big share of the breakage, and almost all of it is mechanical text rewriting. I wrote a Python migrator ([`migrate_g3_to_g4_tscn.py`](https://github.com/allbytestudios/allbyte-web/blob/main/scripts/migrate_g3_to_g4_tscn.py), open source in this site's repo) that codifies every `.tscn`/`.tres` rule I found, and Claude drives it through an agent-callable wrapper (`batch_g3_to_g4`) that runs `--check` (dry run, counts only) by default and `--apply` to rewrite in place. It reports per-file rule-bucket counts so I can see exactly what changed.

The rules it applies:

### Header and node-type renames

```diff
- [gd_scene load_steps=N format=2]
+ [gd_scene load_steps=N format=3]
```

| Godot 3 | Godot 4 |
|---|---|
| `type="Sprite"` | `type="Sprite2D"` |
| `type="AnimatedSprite"` | `type="AnimatedSprite2D"` |
| `type="KinematicBody2D"` | `type="CharacterBody2D"` |
| `type="Texture"` (in `ext_resource`) | `type="Texture2D"` |
| `type="YSort"` (node) | `type="Node2D"` + `y_sort_enabled = true` |

The `YSort` one is worth calling out: in Godot 3 it was a node type; in Godot 4 it collapsed into a `y_sort_enabled` property on `Node2D`. Miss it and items render in scene order instead of by grid Y — a dropped relic draws on top of the player regardless of position.

### Control margins and StyleBoxTexture margins are different renames

```diff
[node name="X" type="Control" parent="..."]
- margin_left = 0.0
+ offset_left = 0.0
```

```diff
[sub_resource type="StyleBoxTexture" id=N]
- margin_left = 22.0
+ texture_margin_left = 22.0
```

Same Godot 3 spelling (`margin_*`), two different Godot 4 targets depending on context. On a Control node it becomes `offset_*`; inside a `StyleBoxTexture` it becomes `texture_margin_*`. Get the StyleBoxTexture one wrong and the nine-patch slicing collapses to a single stretched quad — the panel border looks oversized and wrong, with no error. (Godot's own converter actually mis-renamed these to `offset_*` inside StyleBoxTexture blocks, so my migrator has a repair pass for that specific mistake too.)

### Label vs Button alignment — also not the same rename

```diff
[node name="X" type="Label" parent="..."]
- align = 1
+ horizontal_alignment = 1
```

```diff
[node name="Y" type="Button" parent="..."]
- align = 1
+ alignment = 1
```

Label uses `horizontal_alignment`; Button uses `alignment`. Don't conflate them. This `align` rename on TestScene `.tscn` files was the actual blocker that kept `change_scene_to_file()` from working on ~50 of 70 test files early in the migration — the scenes were still `format=2` and silently no-op'd.

### The theme-override rename family (the big silent one)

Godot 4 renamed the entire `custom_*` theme-override property family to `theme_override_*`. These live inside `[node]` blocks. Godot 4 silently drops the unrecognized Godot 3 names, so controls fall back to default empty StyleBox / default font / default colors.

```diff
[node name="X" type="Panel" parent="..."]
- custom_styles/panel = SubResource(...)
+ theme_override_styles/panel = SubResource(...)

[node name="Y" type="RichTextLabel" parent="..."]
- custom_fonts/normal_font = ExtResource(...)
+ theme_override_fonts/normal_font = ExtResource(...)
- custom_colors/font_color = Color(...)
+ theme_override_colors/font_color = Color(...)
```

The rule is `custom_` → `theme_override_` across `styles`, `fonts`, `colors`, `constants`, `icons`. Symptoms when missed: panels render transparent (looks like black on a dark scene), RichTextLabels render in Godot's default fuzzy font, text colors fall back to white where black was set. I burned a debugging session on a paper-background panel where the texture import, region rect, and z-order were all correct — only the property prefix was wrong.

### Font size moved off the font resource

In Godot 3 the font size lived on the `DynamicFont`/FontVariation resource. In Godot 4 it's a separate theme override on the Control:

```diff
[node name="X" type="RichTextLabel" parent="..."]
theme_override_fonts/normal_font = ExtResource(...)
+ theme_override_font_sizes/normal_font_size = 24
```

Rename the property name but forget to add the size override and the font renders at Godot 4's default (16) regardless of intent. My migrator handles this automatically: it reads the original size from a hint comment the font migration left in each `.tres`, keyed by basename, and injects the matching `theme_override_font_sizes/...` line after any `theme_override_fonts/...` assignment that points at a known font — but only if the size key isn't already set.

Also worth noting: every `.tscn` rule above applies to standalone `.tres` files too — theme, stylebox, and font resources saved as text. A set of shared button styleboxes referenced through one theme cascaded a silent failure into every button using that theme. Glob for `*.{tscn,tres}`, not just `*.tscn`.

## The GDScript side: hand work, mostly silent

These don't run through the `.tscn` migrator — they need code edits.

### The renames the converter does handle

```gdscript
get_tree().change_scene("res://X.tscn")          # G3
get_tree().change_scene_to_file("res://X.tscn")  # G4

node.connect("sig", target, "method")            # G3
node.connect("sig", Callable(target, "method"))  # G4
node.sig.connect(target.method)                  # G4, preferred

yield(get_tree().create_timer(1), "timeout")     # G3
await get_tree().create_timer(1).timeout         # G4
```

### Signal and function can no longer share a name

```gdscript
# G3 — legal
signal npcTriggeredEvent
func npcTriggeredEvent(arg): ...

# G4 — PARSE ERROR: "Function X already exists as a signal"
signal npcTriggeredEvent
func _on_npcTriggeredEvent(arg): ...
```

At least this one is loud — it's a parse error, not a silent failure. It cascades, though: a single parse error in a parent script makes every child that `extends` it fail with "Could not resolve class," which points you at the wrong file entirely. When you see "Could not resolve class X," the bug is in X, not in the child.

### AnimatedSprite `playing = true` doesn't auto-start

```gdscript
# G3 — playing=true in the .tscn auto-started the animation
# G4 — must call .play() explicitly
func _ready():
    $LoadingIcon.play("default")
```

Symptom: an AnimatedSprite2D sits on a static frame. My selection cursor stopped spinning because of this.

### PackedStringArray lost .join()

```gdscript
var s = parts.join(",")    # G3 — PoolStringArray.join()
var s = ",".join(parts)    # G4 — String.join(array)
```

`PackedStringArray` has no `.join()` — the call raises "Nonexistent function 'join'." This is technically loud, but if the surrounding code swallows the error, the real symptom shows up far away (in my case a game-state field that silently stopped updating because the line after the failed `.join` never ran).

### The silent-rename hall of fame

These four are the worst category: the Godot 3 spelling still parses and runs, binds nothing or returns null, and there is no diagnostic anywhere.

**`ImageTexture.create_from_image` went from instance method to static factory.**

```gdscript
# G3 — instance method populates t
var t = ImageTexture.new()
t.create_from_image(img)

# G4 — static factory returns the texture
var t = ImageTexture.create_from_image(img)
```

In Godot 4 the Godot 3 form parses fine — `ImageTexture.new()` returns an empty texture, `t.create_from_image(img)` resolves against the stub and binds nothing, and you return the empty texture. The runtime emits one misleading line claiming the image is null. The image isn't null; the *bind* is wrong. This made save-slot thumbnails render blank.

**`Viewport.get_texture().get_data()` → `.get_image()`.**

```gdscript
var img = get_viewport().get_texture().get_data()   # G3 — returns null in G4
var img = get_viewport().get_texture().get_image()  # G4
```

The Godot 3 chain still parses; `.get_data()` resolves and returns `null`. This was actually upstream of the `ImageTexture` bug above — even with the static-factory fix in place, the *input* image was already null, so the factory still produced an empty texture. Two silent renames stacked on the same feature.

**`RichTextLabel.fit_content_height` → `fit_content`.**

```gdscript
optionLabel.fit_content_height = true   # G3 — silently a no-op dynamic property in G4
optionLabel.fit_content = true          # G4
```

GDScript happily sets `fit_content_height` as a dynamic property on the object — no compile check, no error. The label's `size.y` then reads 0 no matter how much text it renders. Any layout that sums label heights collapses. My dialogue option panel rendered a Yes/No prompt at 50px tall (two rows of `0 + 25`) and the player couldn't see the options. The glyphs still drew; only the size reads were wrong.

**`Vector2.angle_to_point` flipped sign.**

```gdscript
# G3 — atan2(self.y - target.y, self.x - target.x)   (target → self)
# G4 — atan2(target.y - self.y, target.x - self.x)   (self → target), OPPOSITE
var angle = position.angle_to_point(perspectivePoint)   # SAME LINE, flipped meaning
```

This is the nastiest of the four because there's no rename to grep for — same identifier, opposite result. Every `cos(angle)`/`sin(angle)` downstream inverts. My perspective-hill effect shoved the player left when it should have nudged right. The fix isn't a rename, it's flipping the operator signs at every consumer — which means human review at each call site, since the converter can't know whether a given site was already adjusted for the new convention.

### Godot 4's stricter type checking silently no-ops calls

```gdscript
# G3 — accepted any duck-typed arg
func initialize(unit: Unit) -> void:
    self.unit = unit

# G4 — a duck-typed stub silently fails the type check; the call doesn't dispatch
func initialize(passed_unit) -> void:   # drop the type at duck-typed callsites
    self.unit = passed_unit
```

I use lightweight `RefCounted` stubs in the web build that duck-type heavy classes like `Unit` (they provide the subset of properties the function reads). In Godot 3 a typed parameter accepted any value whose surface covered what the function used. Godot 4's type check at call resolution rejects the mismatch — and instead of erroring, the call simply doesn't dispatch. The function body never runs, the return is the default, and no warning surfaces. Symptom: a panel renders with empty default labels, and a `print()` inside the function is silent. Easy to misdiagnose as "the panel isn't in the tree" or "the data layer broke" when the real cause is the setup function was never called.

### Control.size collapses if set before add_child

```gdscript
# G3 — size retained after add_child
panel.size = Vector2(400, 100)
parent.add_child(panel)

# G4 — tree-enter layout pass resets size to (0, 0)
# Correct G4 order: add_child first, then anchors, then size
parent.add_child(panel)
panel.set_anchors_preset(Control.PRESET_TOP_LEFT, false)
panel.size = Vector2(400, 100)
panel.position = Vector2(50, 20)
```

Godot 4 runs a synchronous layout pass when a Control enters the tree, and that pass resets `size` based on anchors/container rules. `set_size()` accepts the assignment, then tree-enter overwrites it — both silently. The reliable order is `add_child` → `set_anchors_preset(PRESET_TOP_LEFT, false)` → `size` → `position`; the `false` keeps margins independent so the post-add size lands. This one compounded with the duck-type bug on the same panel: empty labels *and* (0, 0) size, two effects chased at once.

### Two input-handled flags now exist

Godot 3 had one "input handled" flag. Godot 4 split it into `SceneTree.set_input_as_handled()` and `Viewport.set_input_as_handled()` — two independent flags that don't affect each other. Godot's own `_unhandled_input` dispatch checks the Viewport flag. So if one node consumes an event via `get_tree().set_input_as_handled()` (the muscle-memory port) and another gates on `get_viewport().is_input_handled()`, the gate sees `false` and fires anyway. A single right-click cascaded through three nested menus back to the main menu because of this. Pick one pair per project — `get_viewport().*` is canonical — and use it everywhere.

## Shaders: SCREEN_TEXTURE and the silent param rename

Two shader changes hit hard.

`SCREEN_TEXTURE` was removed; Godot 4 wants an explicit uniform:

```glsl
// G3
vec4 c = texture(SCREEN_TEXTURE, SCREEN_UV);

// G4
uniform sampler2D screen_tex : hint_screen_texture, filter_linear_mipmap;
vec4 c = texture(screen_tex, SCREEN_UV);
```

That's the loud half — it's a compile error. The silent half is in the `.tscn`: the property prefix `shader_param/X` became `shader_parameter/X`.

```diff
- shader_param/reflectionOffset = 0.615
+ shader_parameter/reflectionOffset = 0.615
```

The Godot 3 prefix still loads in Godot 4 — the engine treats it as a custom dynamic property on the material that never binds to the GLSL uniform. The shader compiles, the scene loads, and every tuned value you set has no effect; the uniform sits at its shader-side default. Foam doesn't move, reflections look wrong, no error anywhere. My migrator rewrites this prefix across the whole document, including animation-track NodePath strings (`.:material:shader_param/cutoff`). The GDScript equivalent — `set_shader_param` → `set_shader_parameter` — is caught by the parser, so only the `.tscn` and animation-track forms fail silently.

And one more that bit even after the syntax was correct: in Godot 3, referencing `SCREEN_TEXTURE` implicitly triggered a back-buffer copy. Godot 4 dropped that magic — a screen-reading shader now needs an explicit `BackBufferCopy` node placed as a sibling *before* the screen-reading sprite in tree order. Without it, `texture(screen_tex, ...)` returns black, the shader runs fine, and the reflection layer is just dead.

## The order that worked

The migration wasn't "convert, then fix." It was iterative, symptom-driven, and roughly:

1. Run the `.tscn`/`.tres` migrator (`--check` first to see the blast radius, then `--apply`) to clear all the mechanical renames in scenes and resources.
2. Run `convert3to4` for the loud GDScript renames it does handle.
3. Boot the title screen and chase what's visibly broken. Every silent failure surfaced as a concrete visual symptom — blank thumbnail, fuzzy text, transparent panel, frozen cursor, a panel too small to read.
4. Trace each symptom back to a rename, catalog it, and (where mechanical) fold it into the migrator so the next sweep catches it.

A symptom → root-cause table turned out to be the most useful artifact, because so many of these present as something unrelated. "Scene doesn't load" was usually a parse error from a signal/function name collision. "Panel renders transparent" was the StyleBoxTexture margin rename. "Thumbnail is blank" was one of two stacked silent renames. Building that table — and the migrator that mechanizes the `.tscn` half — is what kept the back half of the migration from being pure whack-a-mole.

## What I'd tell someone starting this jump

- Trust `convert3to4` for the loud renames only. Assume it caught nothing that fails silently.
- The expensive bugs are silent renames where the Godot 3 spelling still parses. Grep for the old names directly — `fit_content_height`, `.get_data()`, `ImageTexture.new()` paired with `.create_from_image`, `shader_param/`, `custom_styles/` — rather than waiting for an error that never comes.
- `angle_to_point` is the one with no name to grep for. Audit every call site by hand.
- Mechanize the `.tscn`/`.tres` renames. They're pure text rewrites, idempotent, and there are too many to do by hand across a 1500-file project. A dry-run mode that reports per-rule counts is worth the hour it takes to build.
- Keep a symptom → root-cause table as you go. In a silent-failure migration, the symptom almost never points at the cause.
