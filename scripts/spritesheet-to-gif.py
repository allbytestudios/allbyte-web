"""Convert sprite sheets to animated GIFs for the web portal.

Each sprite sheet is a horizontal strip of equal-sized frames.
Frame size is determined by the image height (frames are square).
"""

import os
import sys
import json
import struct
import hashlib
from PIL import Image

def sheet_to_gif(src_path, dest_path, frame_duration=150, scale=3, frame_width=None):
    """Convert a horizontal sprite sheet to an animated GIF."""
    sheet = Image.open(src_path).convert("RGBA")
    h = sheet.size[1]
    frame_w = frame_width if frame_width else h  # Default: square frames
    n_frames = sheet.size[0] // frame_w

    if n_frames < 1:
        print(f"  Skip: {src_path} (no frames detected)")
        return False

    frames = []
    for i in range(n_frames):
        frame = sheet.crop((i * frame_w, 0, (i + 1) * frame_w, h))
        # Scale up for web display (pixel art)
        scaled = frame.resize((frame_w * scale, h * scale), Image.NEAREST)
        # Convert RGBA to RGB with transparency handled
        bg = Image.new("RGBA", scaled.size, (0, 0, 0, 0))
        bg.paste(scaled, (0, 0), scaled)
        frames.append(bg)

    # Save as GIF with loop
    frames[0].save(
        dest_path,
        save_all=True,
        append_images=frames[1:],
        duration=frame_duration,
        loop=0,
        disposal=2,  # Clear frame before drawing next
        transparency=0,
    )
    return True


def process_manifest():
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    manifest_path = os.path.join(root, "scripts", "asset-manifest.json")

    with open(manifest_path) as f:
        manifest = json.load(f)

    godot = manifest["godotProject"]
    out_dir = os.path.join(root, "public", "assets", "sprites")
    os.makedirs(out_dir, exist_ok=True)

    # Process sprite GIF entries
    gif_config = manifest.get("spriteGifs", {})
    results = []

    for char_name, config in gif_config.items():
        char_dir = os.path.join(godot, config["sourceDir"])
        scale = config.get("scale", 3)
        duration = config.get("frameDuration", 150)
        sheets = config.get("sheets", [])

        print(f"\n{char_name}:")
        frame_widths = config.get("frameWidths", {})
        seen_hashes = {}  # hash -> first animation name

        for sheet_name in sheets:
            src = os.path.join(char_dir, f"{sheet_name}.png")
            if not os.path.exists(src):
                print(f"  Skip: {sheet_name}.png not found")
                continue

            # Dedup: skip if source file is identical to one already processed
            src_hash = hashlib.md5(open(src, "rb").read()).hexdigest()
            if src_hash in seen_hashes:
                print(f"  Skip: {sheet_name}.png (duplicate of {seen_hashes[src_hash]})")
                continue
            seen_hashes[src_hash] = sheet_name

            dest_name = f"{char_name}_{sheet_name}.gif"
            dest = os.path.join(out_dir, dest_name)
            fw_override = frame_widths.get(sheet_name)

            if sheet_to_gif(src, dest, frame_duration=duration, scale=scale, frame_width=fw_override):
                print(f"  {sheet_name}.png -> {dest_name}")
                results.append({
                    "character": char_name,
                    "animation": sheet_name,
                    "file": f"/assets/sprites/{dest_name}",
                })

    # Write sprite gif index
    index_path = os.path.join(root, "src", "data", "sprite-gifs.json")
    os.makedirs(os.path.dirname(index_path), exist_ok=True)
    with open(index_path, "w") as f:
        json.dump(results, f, indent=2)

    print(f"\nGenerated {len(results)} sprite GIFs")


if __name__ == "__main__":
    process_manifest()
