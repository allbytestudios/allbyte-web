#!/usr/bin/env python3
#
# Open-sourced from the web port of The Chronicles of Nesis. This is the .tscn /
# .tres migrator described in the devlog "Godot 3.6 to 4.6: A Migration Built on
# Silent Failures" (https://allbyte.studio/devlog/godot-3-to-4-retrospective/).
# It mechanizes the scene/resource rename rules for a Godot 3 -> 4 migration; the
# silent-failure rationale for each rule is in the module docstring below.
#
"""
G3->G4 .tscn migrator (Nix, ticket SCENE-WIDE-G4-MIGRATION + MENU-G3-PROPERTIES-SWEEP).

Transforms applied:
  1. Header  : `format=2` -> `format=3` (gd_scene line only).
  2. Type    : `type="Sprite"` -> `type="Sprite2D"`.
  3. Type    : `type="AnimatedSprite"` -> `type="AnimatedSprite2D"`.
  4. Type    : `type="KinematicBody2D"` -> `type="CharacterBody2D"`.
  5. ExtRes  : `type="Texture"` -> `type="Texture2D"` (negative-lookahead, no double-rewrite).
  6a. Label  : `^align = N` (inside [node ... type="Label"...]) -> `horizontal_alignment = N`.
  6b. Button : `^align = N` (inside [node ... type="Button"...]) -> `alignment = N`.
              (Probed against Godot 4.6: Label has `horizontal_alignment`, Button has `alignment`.)
  7. Margins : Position-aware rename of `margin_(left|top|right|bottom) = X` to
                  - `texture_margin_*` if inside a `[sub_resource type="StyleBoxTexture" ...]` block
                  - `offset_*` if inside a `[node ...]` block (Control descendant).
                Skipped if inside any other `[sub_resource ...]` block to avoid touching
                StyleBoxFlat/StyleBoxLine etc. that may have their own margin semantics.
  8. Theme   : `custom_(styles|fonts|colors|constants|icons)/X` -> `theme_override_$1/X`.
                G4 silently drops the G3 `custom_*` property names at load time, leaving
                Controls with default (often invisible) styling. Rename is the documented
                G3->G4 migration path. (MENU-G3-PROPERTIES-SWEEP, 2026-04-26.)
  9. FontSize: When a `[node ...]` body assigns
                  `theme_override_fonts/<name> = ExtResource( N )`
                where ExtResource(N) points at a known FontVariation .tres in
                WebBootstrap/GUI/Fonts/, inject
                  `theme_override_font_sizes/<name>_size = <size>`
                immediately after, IF the body does not already set that key.
                Size is read from the FontVariation .tres's "Original size=N" comment
                left by the prior G3->G4 migration (see GUI/Fonts/*.tres).
                In G4 the font size lives on the Control (theme override), not on
                the FontVariation; without this injection labels render at default 16pt.
 10. StyleBoxTextureRepair: Godot 4's built-in converter mis-renamed `margin_*`
                inside StyleBoxTexture sub_resources to `offset_*`. The correct
                property is `texture_margin_*`. We catch both the original
                `margin_*` form (rule 7) and the post-converter `offset_*` form
                (this rule) inside StyleBoxTexture blocks only.
 11. ShaderParam: `shader_param/X` -> `shader_parameter/X` everywhere. The G3
                form parses cleanly in G4 — engine treats it as a custom dynamic
                property on the material — but does NOT bind to the GLSL
                uniform of the same name. Silent no-op; shader runs with default
                or zero. Also covers AnimationTrack paths embedded as NodePath
                strings (e.g. `tracks/0/path = NodePath(".:material:shader_param/cutoff")`).
                Whole-document rewrite is safe because the prefix `shader_param/`
                only appears in ShaderMaterial property assignments and animation-
                track NodePaths — both need the same rename.
                See the "Shaders: SCREEN_TEXTURE and the silent param rename"
                section of the migration devlog linked in the header above.

NOT touched (out of scope, separate tickets):
  - Inline shader code (SCREEN_TEXTURE): owned by ticket TITLE-SHADER-G4.
  - GDScript inside .gd files (move_and_slide() API, _ready() injection for AnimatedSprite2D play()).
  - load_steps recount.

Usage:
  python3 migrate_g3_to_g4_tscn.py --check FILE...     # dry-run, print summary
  python3 migrate_g3_to_g4_tscn.py --apply FILE...     # rewrite in place

Exit 0 if all files processed without internal error; exit 1 on parse anomaly.
Per-file diagnostics emitted on stderr.
"""
import argparse
import os
import re
import sys
from typing import List, Tuple

HEADER_RE = re.compile(r'^(\[gd_scene[^\]]*?)format=2(\s*[\]\s])', re.M)

# Block boundary detection. A line beginning with [tag ...] starts a new section.
BLOCK_START_RE = re.compile(r'^\[([a-z_]+)([^\]]*)\]', re.M)
LABEL_NODE_RE = re.compile(r'\btype="Label"')
BUTTON_NODE_RE = re.compile(r'\btype="Button"')
STYLEBOX_TEXTURE_RE = re.compile(r'^\[sub_resource\s+type="StyleBoxTexture"')
ALIGN_RE = re.compile(r'^align\s*=', re.M)
MARGIN_RE = re.compile(r'^margin_(left|top|right|bottom)\s*=', re.M)
# Godot 4's built-in converter mis-renamed `margin_*` to `offset_*` inside
# StyleBoxTexture sub_resources (offset_* is a Control property, not a stylebox property).
# Repair: inside StyleBoxTexture sub_resource bodies, `offset_*` -> `texture_margin_*`.
OFFSET_AS_TEXMARGIN_RE = re.compile(
    r'^offset_(left|top|right|bottom)\s*=', re.M)
# Rule 8: G3 custom_* property names dropped silently in G4. Match start-of-line so we
# don't accidentally rewrite the same key inside a quoted string or comment.
CUSTOM_THEME_RE = re.compile(
    r'^custom_(styles|fonts|colors|constants|icons)/', re.M)

# Rule 11: G3 `shader_param/X` -> G4 `shader_parameter/X`. Silent no-op in G4 if
# left as the G3 form; shader uniform never binds. Match both standalone property
# assignments (anchored at start-of-line) AND embedded NodePath strings used in
# animation tracks (e.g. `NodePath(".:material:shader_param/cutoff")`). The
# substring `shader_param/` is unique to these two contexts in well-formed .tscn
# content.
SHADER_PARAM_RE = re.compile(r'shader_param/')

# Rule 9: ExtResource(N) lookup for FontVariation paths -> font size injection.
EXT_RESOURCE_FONT_RE = re.compile(
    r'^\[ext_resource\s+[^\]]*?path="res://GUI/Fonts/([^"]+)"[^\]]*?'
    r'type="FontVariation"[^\]]*?id=(?:"?)(\d+)(?:"?)\s*\]', re.M)
THEME_FONT_LINE_RE = re.compile(
    r'^theme_override_fonts/([A-Za-z0-9_]+)\s*=\s*ExtResource\(\s*"?(\d+)"?\s*\)\s*$',
    re.M)
THEME_FONT_SIZE_KEY_RE = re.compile(
    r'^theme_override_font_sizes/([A-Za-z0-9_]+)\s*=', re.M)

# Original-size hints left by the prior G3->G4 FontVariation migration. We look these
# up by .tres basename (e.g. "Alundra.tres"). Source: comments in GUI/Fonts/*.tres.
# Only fonts that appear in our menu/.tscn pack are listed; extend as needed.
FONT_SIZE_BY_BASENAME = {
    'Adventurer.tres': 16,
    'Alundra.tres': 24,
    'AlundraDamage.tres': 14,
    'AlundraLarge.tres': 38,
    'AlundraLargeNoOutline.tres': 28,
    'AlundraLargeOutline.tres': 25,
    'AlundraMXLargeOutline.tres': 28,
    'AlundraNameLargeOutline.tres': 28,
    'AlundraOutline.tres': 22,
    'AlundraSmall.tres': 16,
    'AlundraSmallBlack.tres': 16,
    'AlundraSmallXpment.tres': 64,
    'AlundraTXLargeOutline.tres': 64,
    'AlundraTitleSize.tres': 32,
    'AlundraTitleXL.tres': 64,
    'AlundraXLargeOutline.tres': 22,
    'AlundraXSmall.tres': 12,
    'AlundraXXLargeOutline.tres': 38,
    'Frikativ.tres': 16,
    'Gothic2_10.tres': 50,
    'Gothic2_20.tres': 20,
    'KarmaSuture.tres': 18,
    'LastPriestess.tres': 22,
    'ModernGothicLargeOutline.tres': 24,
    'TimesNewPixel.tres': 24,
    'TimesNewPixelLarge.tres': 64,
    'TimesNewPixelSmall.tres': 14,
    'TooseOrnament.tres': 16,
    'TooseOrnamentLarge.tres': 48,
    'pexllocale_20.tres': 20,
    'pixellocale_12.tres': 12,
    'pixellocale_14.tres': 14,
    'pixellocale_16.tres': 16,
    'pixellocale_4.tres': 16,
    'pixellocale_8.tres': 8,
}


def split_blocks(text: str) -> List[Tuple[str, List[str], str]]:
    """Return list of (header_line, body_lines, kind) where kind is 'gd_scene'|'ext_resource'|
    'sub_resource'|'node'|'connection'|'editable'|'preamble' for content before first block.
    body_lines is the list of lines (preserving blank lines) AFTER the header up to the next
    block start (excluding the next header). Reassembly is just '\\n'.join(header + body_lines)
    per block, then '\\n'-joined across blocks — this round-trips exactly when no edits made."""
    lines = text.split('\n')
    blocks: List[Tuple[str, List[str], str]] = []
    current_header = ''
    current_body_lines: List[str] = []
    current_kind = 'preamble'
    header_line_re = re.compile(r'^\[([a-z_]+)([^\]]*)\]\s*$')
    for ln in lines:
        m = header_line_re.match(ln)
        if m:
            blocks.append((current_header, current_body_lines, current_kind))
            current_header = ln
            current_body_lines = []
            current_kind = m.group(1)
        else:
            current_body_lines.append(ln)
    blocks.append((current_header, current_body_lines, current_kind))
    return blocks


def apply_transforms(text: str) -> Tuple[str, dict]:
    counts = {
        'header': 0,
        'sprite': 0,
        'animatedsprite': 0,
        'kinematicbody': 0,
        'texture': 0,
        'label_align': 0,
        'button_align': 0,
        'texture_margin': 0,
        'offset_margin': 0,
        'skipped_margin_in_other_subresource': 0,
        'screen_texture_present': 0,
        'custom_theme_renamed': 0,
        'shader_param_renamed': 0,
        'font_size_injected': 0,
        'font_size_skipped_already_set': 0,
        'font_size_skipped_unknown_font': 0,
        'ysort': 0,
    }

    # Header bump (count first)
    if HEADER_RE.search(text):
        counts['header'] = len(HEADER_RE.findall(text))
        text = HEADER_RE.sub(r'\1format=3\2', text)

    # Detection-only signal for shader gotcha
    if 'SCREEN_TEXTURE' in text:
        counts['screen_texture_present'] = text.count('SCREEN_TEXTURE')

    # Type rewrites — use explicit bucket alongside each rule.
    type_rules = [
        (re.compile(r'type="Sprite"(?!2D)'), 'type="Sprite2D"', 'sprite'),
        (re.compile(r'type="AnimatedSprite"(?!2D)'), 'type="AnimatedSprite2D"', 'animatedsprite'),
        (re.compile(r'type="KinematicBody2D"'), 'type="CharacterBody2D"', 'kinematicbody'),
        (re.compile(r'type="Texture"(?!2D)'), 'type="Texture2D"', 'texture'),
    ]
    for rx, repl, bucket in type_rules:
        n = len(rx.findall(text))
        if n:
            text = rx.sub(repl, text)
            counts[bucket] += n

    # YSort rewrite (the owner 2026-05-12): G3's [node type="YSort"] became
    # a `y_sort_enabled` property on Node2D in G4. Rewrite the header
    # line to type="Node2D" and inject `y_sort_enabled = true` on the
    # next line so children y-sort correctly. Symptom of missing
    # migration: items in Bodies render in scene-order, e.g. Relic
    # drawing on top of Player regardless of grid Y (waterway1).
    YSORT_RE = re.compile(r'^(\[node [^\n]*?type=")YSort("[^\n]*?\])$', re.MULTILINE)
    n = len(YSORT_RE.findall(text))
    if n:
        text = YSORT_RE.sub(r'\1Node2D\2\ny_sort_enabled = true', text)
        counts['ysort'] += n

    # Rule 8: G3 custom_* -> G4 theme_override_*. Whole-document; safe because the regex
    # is anchored at start-of-line and only the legacy property prefixes match. This must
    # happen BEFORE the block-aware font-size injection (rule 9) so the fonts/X line is
    # already in its theme_override_fonts/ form when we look for it.
    n = len(CUSTOM_THEME_RE.findall(text))
    if n:
        text = CUSTOM_THEME_RE.sub(r'theme_override_\1/', text)
        counts['custom_theme_renamed'] += n

    # Rule 11: G3 shader_param/ -> G4 shader_parameter/. Silent-rebind otherwise.
    # See SHADER-PARAM-G4-SWEEP (2026-04-28). Whole-document — covers both
    # property-assignment lines and animation-track NodePath strings.
    n = len(SHADER_PARAM_RE.findall(text))
    if n:
        text = SHADER_PARAM_RE.sub('shader_parameter/', text)
        counts['shader_param_renamed'] += n

    # Build ExtResource id -> FontVariation basename map for rule 9. Only FontVariation
    # ext_resources count; other types (Texture2D, Script, Theme, ...) are skipped so we
    # never inject a font_size for a non-font ExtResource(N) reference.
    ext_id_to_font_basename: dict = {}
    for m in EXT_RESOURCE_FONT_RE.finditer(text):
        basename = m.group(1)
        ext_id = m.group(2)
        ext_id_to_font_basename[ext_id] = basename

    # Block-aware rewrites for Label.align/Button.align and margin_*.
    blocks = split_blocks(text)
    out_blocks: List[Tuple[str, List[str], str]] = []
    for header, body_lines, kind in blocks:
        # Track whether this block had any body lines at all (including just blanks).
        had_body = len(body_lines) > 0
        new_body = '\n'.join(body_lines)
        if kind == 'node' and LABEL_NODE_RE.search(header):
            new_body, n = ALIGN_RE.subn('horizontal_alignment =', new_body)
            counts['label_align'] += n
        elif kind == 'node' and BUTTON_NODE_RE.search(header):
            new_body, n = ALIGN_RE.subn('alignment =', new_body)
            counts['button_align'] += n
        if kind == 'sub_resource' and STYLEBOX_TEXTURE_RE.match(header):
            new_body, n = MARGIN_RE.subn(r'texture_margin_\1 =', new_body)
            counts['texture_margin'] += n
            # Repair the converter-mistake: offset_* inside StyleBoxTexture is wrong;
            # the property is texture_margin_*. (BED-HIGHLIGHT-9PATCH cascade.)
            new_body, n = OFFSET_AS_TEXMARGIN_RE.subn(
                r'texture_margin_\1 =', new_body)
            counts['texture_margin'] += n
        elif kind == 'sub_resource':
            if MARGIN_RE.search(new_body):
                counts['skipped_margin_in_other_subresource'] += len(MARGIN_RE.findall(new_body))
        elif kind == 'node':
            new_body, n = MARGIN_RE.subn(r'offset_\1 =', new_body)
            counts['offset_margin'] += n
        # Rule 9: inject theme_override_font_sizes/<name>_size after every
        # theme_override_fonts/<name> = ExtResource(N) line whose ExtResource is a
        # known FontVariation .tres in GUI/Fonts/. Only applies inside [node ...] blocks.
        if kind == 'node' and ext_id_to_font_basename:
            existing_size_keys = set(THEME_FONT_SIZE_KEY_RE.findall(new_body))
            body_lines = new_body.split('\n')
            out_lines_block: List[str] = []
            for line in body_lines:
                out_lines_block.append(line)
                fm = THEME_FONT_LINE_RE.match(line)
                if fm:
                    name = fm.group(1)
                    ext_id = fm.group(2)
                    font_basename = ext_id_to_font_basename.get(ext_id)
                    if font_basename is None:
                        # ExtResource pointed at a non-FontVariation; ignore.
                        continue
                    size = FONT_SIZE_BY_BASENAME.get(font_basename)
                    if size is None:
                        counts['font_size_skipped_unknown_font'] += 1
                        continue
                    size_key = name + '_size'
                    if size_key in existing_size_keys:
                        counts['font_size_skipped_already_set'] += 1
                        continue
                    out_lines_block.append(
                        'theme_override_font_sizes/{key} = {sz}'.format(
                            key=size_key, sz=size))
                    counts['font_size_injected'] += 1
                    # Track so a second font line in the same block doesn't double-inject
                    # if both happen to use the same name (shouldn't, but be defensive).
                    existing_size_keys.add(size_key)
            new_body = '\n'.join(out_lines_block)
        # Preserve original line list shape: even an empty body that was [''] stays [''].
        if had_body:
            out_blocks.append((header, new_body.split('\n'), kind))
        else:
            out_blocks.append((header, [], kind))

    # Reassemble: emit header (if any) then body_lines, joined with '\n'.
    out_lines: List[str] = []
    for i, (header, body_lines, kind) in enumerate(out_blocks):
        if header:
            out_lines.append(header)
        out_lines.extend(body_lines)
    new_text = '\n'.join(out_lines)
    return new_text, counts


def process(path: str, apply: bool) -> dict:
    with open(path, 'r', encoding='utf-8') as f:
        original = f.read()
    new_text, counts = apply_transforms(original)
    counts['changed'] = (new_text != original)
    if apply and counts['changed']:
        with open(path, 'w', encoding='utf-8') as f:
            f.write(new_text)
    return counts


def main() -> int:
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument('--check', action='store_true', help='dry-run, print summary')
    g.add_argument('--apply', action='store_true', help='rewrite in place')
    ap.add_argument('files', nargs='+')
    args = ap.parse_args()

    grand = {}
    for p in args.files:
        if not os.path.isfile(p):
            print(f'[skip] not found: {p}', file=sys.stderr)
            continue
        try:
            counts = process(p, apply=args.apply)
        except Exception as e:
            print(f'[error] {p}: {e}', file=sys.stderr)
            return 1
        verdict = 'CHANGED' if counts['changed'] else 'noop'
        print(f'{verdict}\t{p}\t{counts}')
        for k, v in counts.items():
            if isinstance(v, int):
                grand[k] = grand.get(k, 0) + v
    print(f'\nGRAND TOTAL: {grand}')
    return 0


if __name__ == '__main__':
    sys.exit(main())
