---
title: "A Shader in Service of the Painting"
description: "The title screen of The Chronicles of Nesis looks hand-painted because it is — clouds and all. The only thing that isn't hand-made is a small Godot 4 shader that keeps those painted clouds alive and non-repeating without ever overpowering the art. Here's how the cloud and cloud-shadow shaders work, including the one I'm still refining."
pubDate: 2026-06-22T12:00:00Z
category: "craft"
devlog: "chronicles"
tags: ["godot", "shaders", "art", "craft", "graphics"]
heroImage: "/og-image.jpg"
draft: true
---

The first thing you see in The Chronicles of Nesis is a quiet valley under a drifting sky. The valley is painted by hand. So are the clouds. The only thing that *isn't* hand-made is the part that makes them move — and I spent a surprising amount of effort making sure you'd never notice it.

That's the whole idea here: engineering in service of the painting, not layered on top of it.

<video controls preload="metadata" width="100%" poster="/og-image.jpg" style="border-radius: 6px; margin: 1rem 0;">
  <source src="https://allbyte.studio/captures/recordings/capture-20260622-title-screen.mp4" type="video/mp4" />
</video>

## The clouds are hand-painted — the shader just keeps them honest

It would have been easier to generate clouds procedurally: a little noise, some drift, done. But procedural clouds look like *procedural clouds* — generic puffs that never match a specific painted palette. So the clouds aren't generated. They're a hand-painted sheet — five separate clouds I authored by hand — and the shader's only job is to make them feel alive and non-repeating.

About eighteen cloud sprites drift across five parallax depth layers, each sampling a region of that painted sheet. Nearer clouds drift faster, farther ones slower. The art stays the source of truth; the Godot 4 shader adds only motion and variation around it.

## Making a painted cloud unique

Reusing five painted clouds across eighteen sprites has an obvious risk: repetition. See the same puff twice and the illusion breaks. So every cloud carries a `unique_seed`, and a small `fragment()` uses it to bend each one a little differently:

```glsl
void fragment() {
    // Per-cloud procedural variation so no two clouds share a pattern.
    vec2 distort_uv = UV * 6.0 + vec2(unique_seed * 13.7, unique_seed * 27.9);
    vec2 distort = vec2(_vnoise_(distort_uv) - 0.5, _vnoise_(distort_uv.yx + 1.7) - 0.5);

    // Dampen the warp near the sprite edges so it never escapes the cloud's
    // soft transparent border (that was producing hard-edged clipping).
    vec2 edge_dist = min(UV, 1.0 - UV);
    vec2 edge_dampen = smoothstep(vec2(0.0), vec2(variation_distort * 2.0 + 0.01), edge_dist);
    vec2 warped_uv = UV + distort * variation_distort * edge_dampen;
    vec4 col = sample_base(TEXTURE, warped_uv);

    // Break up the painted cloud's internal density so it reads as a living
    // puff, not a flat decal.
    float alpha_noise = _vnoise_(UV * 3.0 + vec2(unique_seed * 7.1, unique_seed * 19.3));
    col.a *= 1.0 - variation_alpha * (1.0 - alpha_noise);

    COLOR = col;
}
```

Two tiny moves: warp the silhouette a hair (differently per seed) and break up the internal alpha a hair. The amounts are deliberately small — `variation_distort` is about `0.012`. Any more and you'd catch the cloud *wobbling*; the goal is that you never do.

That `edge_dampen` line is a scar. Early on, the warp would push a sample past the cloud's soft transparent edge, the sampler would clamp, and you'd get a crisp rectangle where a soft cloud should be. Fading the warp to zero near the sprite boundary fixed it — distortion can never reach outside the painted cloud's own AA border.

## The shadow I'm still refining

The cloud shadows are the honest part of this post. They are *not* derived from the clouds. Deriving a shadow from each cloud's exact silhouette would double the painted shape and over-darken the scene, so instead each shadow is a fully procedural soft blob cast onto the valley — a shape that reads as "a cloud's shadow" without being any specific cloud's.

The whole challenge is keeping a procedural blob from *looking* procedural — specifically, from showing the straight edges of the quad it lives in. The fix is layered noise:

```glsl
// Three octaves of value noise per side — a huge rare bulge, the general
// shape, and fine detail — combined to keep the edge organic and break up
// any straight runs. Drifts slowly over TIME so it's barely alive.
float side_n = huge_n * 0.7 + big_n + small_n * 0.35;
float half_w = clamp(0.40 + side_n * bumps_amount, 0.10, 0.47);
float blob_x = 1.0 - smoothstep(half_w - feather, half_w, abs(UV.x - 0.5));
```

The same multi-octave treatment runs on the top and bottom edges too, or the quad's horizontal boundaries show up as hard lines slicing across the hills. The shadow sits at about 22% opacity and wobbles on a slow `TIME * 0.02` clock — present, never dominant.

It's good enough to ship, and I'm still refining it. The honest rough edges:

- **The shadow doesn't match the cloud above it.** It's a generic blob; compare a cloud to its shadow and you won't find the same shape. Intentional, but it's the main thing I'd improve.
- **It runs on its own clock.** The shadow's edge-wobble is decoupled from the cloud's drift, so they animate on slightly different cadences rather than as one rigid object.
- **It's a single soft lobe** with a flat top-down projection — no multi-lobed shapes, no sun-angle skew.

None of that breaks the frame, but I know where the seams are.

## Why do it this way at all

Because the painting is the point. Off-the-shelf cloud effects are one of two things: fully procedural (generic and palette-blind) or static sprites (lifeless). The custom path keeps my *painted* clouds as the source of truth — palette-matched by construction — and adds only the variation, parallax, and slow life needed to make the sky breathe.

## Restraint is the craft

Every knob got tuned *down*, repeatedly: drift speed, wisp frequency, shadow opacity, edge wobble. The hand-painted terrain is still and deliberate; the code supplies just enough motion to make the frame feel alive without turning the title screen into a tech demo. The tech is supposed to be invisible — you should feel the world is alive and never notice a shader.

That's the studio in a single screen: the art is made by hand, and the engineering exists to serve it.
