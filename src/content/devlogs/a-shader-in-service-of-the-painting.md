---
title: "A Shader for My Hand-Painted Clouds"
description: "I hand-painted the clouds for the title screen and liked how they scrolled — but I wanted each one to slowly distort and shift, so slowly you don't quite register it. That needed a shader. Here are the cloud and cloud-shadow shaders in Godot 4, including the one I'm still tuning."
pubDate: 2026-06-22T12:00:00Z
category: "craft"
devlog: "chronicles"
tags: ["godot", "shaders", "art", "craft", "graphics"]
heroImage: "/og-image.jpg"
draft: true
---

I handcrafted the clouds for the title screen and liked how they scrolled across the sky. But I wanted to add one more thing: if you look at any part of a cloud, it should slowly distort and shift — so slowly your mind almost doesn't register it happening. That called for a shader, and I figured expanding on the existing cloud artwork (rather than replacing it) wouldn't be too crazy.

<video controls preload="metadata" width="100%" poster="/og-image.jpg" style="border-radius: 6px; margin: 1rem 0;">
  <source src="https://allbyte.studio/captures/recordings/capture-20260622-title-screen.mp4" type="video/mp4" />
</video>

## Keeping each cloud unique

There are five painted clouds on one sheet, spread across about eighteen sprites and five parallax layers. Reuse five clouds that many times and you start noticing the repeats. So each cloud gets a `unique_seed`, and the shader (Godot 4) uses it to warp the silhouette and break up the internal alpha a little differently — which is also where that slow drift-shift lives:

```glsl
void fragment() {
    // Per-cloud procedural variation so no two clouds share a pattern.
    vec2 distort_uv = UV * 6.0 + vec2(unique_seed * 13.7, unique_seed * 27.9);
    vec2 distort = vec2(_vnoise_(distort_uv) - 0.5, _vnoise_(distort_uv.yx + 1.7) - 0.5);

    // Dampen the warp near the edges so it never escapes the cloud's soft
    // transparent border (that was producing hard-edged clipping).
    vec2 edge_dist = min(UV, 1.0 - UV);
    vec2 edge_dampen = smoothstep(vec2(0.0), vec2(variation_distort * 2.0 + 0.01), edge_dist);
    vec2 warped_uv = UV + distort * variation_distort * edge_dampen;
    vec4 col = sample_base(TEXTURE, warped_uv);

    // Break up the painted cloud's internal density a touch.
    float alpha_noise = _vnoise_(UV * 3.0 + vec2(unique_seed * 7.1, unique_seed * 19.3));
    col.a *= 1.0 - variation_alpha * (1.0 - alpha_noise);

    COLOR = col;
}
```

The amount is tiny on purpose — `variation_distort` is about `0.012`. Push it higher and you'd catch the cloud visibly wobbling; the point is that you don't.

The one real fight was that `edge_dampen` line. Without it, the warp would push a sample past the cloud's soft transparent edge, the sampler would clamp, and you'd get a crisp rectangle where a soft cloud should be. Fading the warp to zero near the border fixed it.

## The shadows (still tuning these)

The cloud shadows aren't pulled from the clouds — each one is a procedural soft blob cast on the valley. Deriving a shadow from a cloud's exact shape would just double the painted silhouette and darken the scene too much. The annoying part is keeping a procedural blob from showing the straight edges of the quad it's drawn in, which takes layered noise on every edge:

```glsl
// Three octaves of value noise per side — a rare big bulge, the general
// shape, and fine detail — so the outline stays organic with no straight runs.
float side_n = huge_n * 0.7 + big_n + small_n * 0.35;
float half_w = clamp(0.40 + side_n * bumps_amount, 0.10, 0.47);
float blob_x = 1.0 - smoothstep(half_w - feather, half_w, abs(UV.x - 0.5));
```

They sit low (about 22% opacity) and drift slowly. Good enough to ship, but I'll be honest about what's still rough:

- The shadow doesn't match the cloud above it — it's a generic blob, not that cloud's shape.
- It animates on its own clock, separate from the cloud's drift.
- One soft lobe, flat top-down projection — no sun-angle skew.

## Why not just generate clouds

Because then they wouldn't be *my* clouds. Fully procedural clouds look generic and won't match a painted palette. Keeping the hand-painted sheet as the source and adding only the drift, the slow distortion, and the shadows let the art stay the art — the shader just keeps it from ever looking like a repeated sprite.
