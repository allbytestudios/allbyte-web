// The /play load-screen "manual" cards — the single source of truth for both the
// loader (GodotEmbed.svelte) AND the Dev Console review tab (/test/cards/).
// Editing a card here changes what players see AND what the console shows, so the
// review surface can never drift from what ships.
//
// HOUSE RULES for this file, learned the hard way (owner, 2026-09-08):
//
// 1. SHORT. This is a loading screen, not a wiki. A player reads it for a few
//    seconds while the WASM compiles. Three or four rows is the ceiling; a
//    six-row table is a wall nobody finishes.
// 2. THE MANUAL'S WORDS, not a paraphrase. Where a card shows something the
//    booklet also documents, copy the booklet — a second, breezier phrasing of
//    the same rule is how the two drift apart. Table cards take the FIRST TWO
//    COLUMNS of the manual's table and stop.
// 3. EPISODE ONE ONLY. The manual marks later content with ◈. A player here
//    cannot meet Acid, Ice, Fire or Necrotic, so teaching them their statuses
//    spends the one moment we have on things that will not happen.
// 4. THESE DOCUMENT THE DESIGN, NOT THE DEPLOYED BUILD (owner, 2026-09-08).
//    A card describing behaviour that has not shipped yet is CORRECT; the game
//    catches up. The trap runs the other way — seeing the game do something a
//    card does not say and "fixing" the card to match a bug.
// 5. A HINT BEATS A TABLE. The booklet's Hints chapter is already written in
//    exactly this register — one imperative, one line of why. Prefer them.
//
// Previous versions of this file documented AP (actions per turn) on three
// separate cards. AP was retired from the game; the loading screen went on
// teaching it to every player. Anything mechanical here has to be checked
// against the shipped build, not against memory.

export interface ManualCard {
  title: string;
  /** Prose paragraphs. */
  lines?: string[];
  /** [term, description] rows for the two-column cards. */
  rows?: [string, string][];
  quote?: string;
}

export const MANUAL_CARDS: ManualCard[] = [
  // --- Hints. Straight from the booklet's Hints & Tips chapter. ------------
  {
    title: "Spend it as you earn it",
    lines: ["JP buys raw stats, SP buys the skill tree. An unspent pile is wasted power."],
  },
  {
    title: "Equip what you find",
    lines: ["Gear in your bag does nothing until you put it on."],
  },
  {
    // The booklet said "Mugwort is your only HP restore", which this card copied
    // verbatim under rule 2 — and it was wrong: Cure heals too, and heals MORE,
    // because it scales with your stats where Mugwort is a flat item. Copying the
    // manual only protects you when the manual is right, so a card is worth
    // sanity-checking against the game even when it is quoting the book.
    title: "Heal between fights",
    lines: ["Mugwort is your only healing item. The Cure skill restores more, and grows with your stats."],
  },
  {
    title: "A winding-up enemy is an opportunity",
    lines: ["Break its charge and it loses the next turn too — but you must stand in reach of everything else. Scan shows the damage needed."],
  },
  {
    title: "Crits are on your side",
    lines: ["Your crit chance beats most enemies'. Even fights swing your way."],
  },
  {
    title: "Use your favourite skills",
    lines: ["Skills grow with use. Lean on one and it becomes far stronger over a run."],
  },
  {
    title: "Take Counterattack early",
    lines: ["It answers the crowding most early fights are built on."],
  },

  // --- Reference. First two columns of the manual's tables, Episode One rows.
  {
    // Manual: Damage Types table, columns "Damage type" and "Category". The
    // Category IS the useful half — it tells you which defense applies.
    title: "Damage types",
    rows: [
      ["Physical", "Physical"],
      ["Poison", "Magical"],
      ["Radiant", "Magical"],
    ],
  },
  {
    // Manual: Status Effects table, description column, verbatim. Episode One
    // statuses only — the rest are ◈ and cannot be met yet.
    title: "Status effects",
    rows: [
      ["Poisoned", "Small damage every turn. Less likely to land hits, more likely to be hit."],
      ["Blinded", "Much less likely to land hits, much more likely to be hit."],
    ],
  },
  {
    title: "The ground fights too",
    rows: [
      ["Poison", "a chance to poison you each step"],
      ["Web", "cannot move, but can still attack"],
    ],
  },
  {
    title: "Your turn",
    lines: ["One move and one action, in either order. You cannot split the move around the action."],
  },
  {
    title: "Where you fight",
    lines: ["No random encounters. The ground you were standing on becomes the grid."],
  },
];

// --- "Living manual" sprite card -------------------------------------------
// One load card is a random non-boss sprite that turns + swings, captioned with
// the character's role + blurb below. The loader builds the visual cast from the
// handcrafted sprite GIFs; these constants are the shared identity + copy.
// Every non-boss sprite the capture pipeline knows about, Episode 1 AND 2. The
// /play load screen must NOT draw from this directly — see EPISODE_1_SPRITES.
export const NONBOSS_SPRITES = new Set([
  "Elias",
  "Falmri",
  "eastwood",
  "spiter",
  "vepir",
  "slime",
]);

// Episode 2 cast (owner 2026-08-07). The sprites exist and the art is done, but
// a player on Episode 1 hasn't met them — showing them on the loading screen
// spoils characters they have no context for. Kept in the data (the console's
// /test/cards/ review page still lists them, and Episode 2 flips them on) but
// filtered out of the live rotation.
export const EPISODE_2_SPRITES = new Set(["Falmri", "eastwood", "spiter", "vepir"]);

/** The cast the /play living-sprite card may actually draw. */
export const EPISODE_1_SPRITES = new Set(
  [...NONBOSS_SPRITES].filter((s) => !EPISODE_2_SPRITES.has(s)),
);

export const SPRITE_DISPLAY: Record<string, string> = {
  Elias: "Elias",
  Falmri: "Falmri",
  eastwood: "Eastwood",
  spiter: "Spiter",
  vepir: "Vepir",
  slime: "Slime",
};

export interface SpriteLore {
  role: string;
  blurb: string;
}

// Role + one-line blurb per character, keyed by display name. Sourced from the
// manual's Characters + Bestiary chapters — blurbs only where the manual actually
// documents the entity (never invented).
export const SPRITE_LORE: Record<string, SpriteLore> = {
  Elias: {
    role: "Paladin · Elf of Laria",
    blurb:
      "The windmill mechanic of Laria who never stopped believing the world is larger than the hills around him.",
  },
  Falmri: {
    role: "Warrior · Dwarf",
    blurb:
      "A gruff old dwarf who remembers when dwarves lived openly among humans and elves, and the great roads were still open.",
  },
  Slime: {
    role: "Enemy · The Waterway",
    blurb:
      "The bread-and-butter Waterway foe — no resistances, no tricks. The danger is numbers, not any single Slime.",
  },
  Eastwood: { role: "Enemy · Episode Two", blurb: "" },
  Spiter: { role: "Enemy · Episode Two", blurb: "" },
  Vepir: { role: "Enemy · Episode Two", blurb: "" },
};
