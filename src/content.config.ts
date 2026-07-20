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
    audience: z
      .enum(["ai-dev", "gamedev", "players", "general"])
      .optional()
      .default("general"),
  }),
});

export const collections = { devlogs };
