import { defineCollection } from "astro:content";
import { glob } from "astro/loaders";
import { z } from "astro/zod";

const devlogs = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/devlogs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    pubDate: z.coerce.date(),
    category: z.enum(["engineering", "workflow", "strategy", "narrative", "craft"]),
    devlog: z.enum(["chronicles", "godot-and-claude", "studio"]),
    tags: z.array(z.string()).default([]),
    heroImage: z.string().optional(),
    draft: z.boolean().optional().default(false),
    // Keep the post's page reachable by URL but hide it from every listing
    // (devlog index + landing count). For posts parked indefinitely.
    unlisted: z.boolean().optional().default(false),
    // Target focus group — drives where the post gets syndicated and whether
    // AI framing is allowed. "gamedev"/"players" posts must stay AI-free
    // (the game-dev audience is AI-sensitive); "ai-dev" leans into it.
    // `scripts/devlog-plan.js` reads this to say what to post where.
    // "manifesto" (added 2026-07-21) is deliberately NOT a syndication target.
    // These are the big-picture pieces that combine everything — gamedev, Godot,
    // AI, test infra, the day-job-to-dream arc. The audience for that combination
    // is vanishingly narrow today: they're written for the retrospective, worth a
    // lot IF the studio succeeds and close to nothing before that. Tagging them
    // as a normal audience made them look like un-posted backlog on the
    // distribution board, which is why they kept surfacing as work to do.
    // They get no venues by design — see private/marketing/devlog-distribution.json.
    audience: z
      .enum(["ai-dev", "gamedev", "players", "manifesto", "general"])
      .optional()
      .default("general"),
  }),
});

// Walkthrough — one file per scene, synced from Quinn's authoring dir by
// `npm run sync:walkthrough`. Contract with Quinn (2026-07-20):
//
//   She owns : prose, [L-1.3] codes, checklists, OPTIONAL/MISSABLE/BOSS, recaps
//   Arc owns : scene adjacency, cond gates, pack, media -- joined at render time
//              on the `scene` field, which is the FK into walkthrough-scenes.json
//
// So exits/cond deliberately do NOT appear here. They're machine-derivable from
// the game; hand-maintaining them in frontmatter would silently rot. They stay
// in the prose body as editorial ("--> Take Front Road toward the windmills").
//
// .strict() is load-bearing: a typo'd key must fail the build, not vanish.
const walkthrough = defineCollection({
  loader: glob({ pattern: "**/*.md", base: "./src/content/walkthrough" }),
  schema: z
    .object({
      /** Section code, e.g. "L-1.3". Anchor id + cross-ref key. Unique. */
      code: z.string().regex(/^[A-Z]+-\d+\.\d+$/, 'code must look like "L-1.3"'),
      /** FK into the scene graph (walkthrough-scenes.json). Validated at sync. */
      scene: z.string(),
      area: z.string(),
      /** Narrative-spine tags — slugs into src/data/story-spine.json. The render
       *  hierarchy is chapter → section → step → scene; the STEP label is the only
       *  heading, and `title` below is just a location ("you are here") label. */
      chapter: z.string(),
      section: z.string(),
      step: z.string(),
      /** Position within the area. */
      order: z.number(),
      /** Location only, e.g. "Mayor's House". Rendered as a muted label on the
       *  scene block, never as a heading — the step label is the heading. */
      title: z.string(),
      /** Free-form descriptor, e.g. "town hub". Display only. */
      kind: z.string().optional(),
      items: z
        .array(
          z.object({
            name: z.string(),
            where: z.string(),
            reach: z.enum(["main", "optional"]),
            missable: z.boolean().default(false),
          })
        )
        .default([]),
      /** Bare basenames, no extension -- resolved to the built WebP at render
       *  time. Keeping the extension out is what lets sync stay verbatim. */
      screenshots: z.array(z.string()).default([]),
      /** Callout markers pointing at interactables on a screenshot.
       *
       *  x/y are in the SOURCE still's pixel space (what Quinn's driver reports).
       *  They are NOT used as pixels at render time: sync emits the original
       *  dimensions to still-dimensions.json and the renderer converts to a
       *  percentage, so markers stay correct through the 1280px downscale and
       *  any future resize. Authoring in source pixels is the whole point --
       *  she reads coords straight off the driver with no math. */
      indicators: z
        .array(
          z.object({
            label: z.string(),
            target: z.enum(["chest", "door", "bed", "npc", "item", "exit"]).optional(),
            x: z.number(),
            y: z.number(),
            /** Which still, when a scene has several. Defaults to the first. */
            screenshot: z.string().optional(),
          })
        )
        .default([]),
      boss: z
        .object({
          name: z.string(),
          cond: z.number().optional(),
          hp: z.number().optional(),
          steal: z.array(z.string()).default([]),
          attacks: z.array(z.string()).default([]),
          notes: z.string().optional(),
        })
        .optional(),
    })
    .strict(),
});

export const collections = { devlogs, walkthrough };
