// The /play load-screen "manual" cards — the single source of truth for both the
// loader (GodotEmbed.svelte, drawn by the worker) AND the Dev Console review tab
// (/test/cards/). Editing a card here changes what players see AND what the
// console shows, so the review surface can never drift from what ships.

export interface ManualCard {
  title: string;
  /** Prose paragraphs. */
  lines?: string[];
  /** [term, description] rows for the two-column cards. */
  rows?: [string, string][];
  quote?: string;
}

export const MANUAL_CARDS: ManualCard[] = [
  {
    // A damage type is NOT a status effect, even where they share a name
    // (owner 2026-08-06). Poison is a damage type that may ALSO have a chance to
    // apply Poisoned — it deals its damage either way. The statuses themselves
    // are the next card's job; this one stays about how damage is reduced.
    // Rows only, no `lines`: the worker renderer draws rows OR lines, never
    // both, so prose added here would be invisible to players on /play.
    title: "Damage types",
    rows: [
      ["Physical", "reduced by Physical Defense"],
      ["Everything else", "reduced by Magic Defense"],
      ["Poison · Acid", "damage first — each may also apply its status"],
      ["Radiant", "ignores Physical Defense AND resistance"],
      ["Gear & effects", "can cut one specific type further"],
    ],
  },
  {
    title: "Status effects",
    rows: [
      ["Poisoned", "damage every turn; worse aim, easier to hit"],
      ["Acid Covered", "you deal less and take more"],
      ["Blind", "hit chance cratered (from Radiant)"],
      ["Chilled", "movement reduced"],
      ["Burning", "significant damage every turn"],
    ],
  },
  {
    title: "The ground fights too",
    rows: [
      ["Poison tile", "a chance to Poison you each step"],
      ["Acid tile", "moderate damage + Acid Covered"],
      ["Icy tile", "double move cost; may fall prone"],
      ["Aflame tile", "sets you Burning, and trails fire"],
    ],
  },
  {
    title: "Raw stats — the knobs you turn with JP",
    rows: [
      ["Strength", "physical attack, and HP"],
      ["Constitution", "HP and physical defense"],
      ["Dexterity", "accuracy, dodge, defense"],
      ["Agility", "initiative and move range"],
      ["Intelligence", "magic attack + defense (softens Radiant)"],
      ["Wisdom", "the off-stat that feeds everything"],
    ],
  },
  {
    title: "Battle stats — calculated from your build",
    rows: [
      ["HP", "← Constitution · what you can take"],
      ["MP", "← Intelligence · fuels your skills"],
      ["Initiative", "← Agility · who acts first"],
      ["Physical Attack", "← Strength · your weapon damage"],
      ["Magic Defense", "← Intelligence · the only softener of Radiant"],
      ["AP", "← Speed · actions per turn, grows slowly"],
    ],
  },
  {
    title: "The shorthand",
    rows: [
      ["XP", "fills the bar → level up"],
      ["JP", "spend on your raw stats"],
      ["SP", "spend on the skill tree"],
      ["MP", "fuels your skills"],
      ["AP", "actions per turn"],
      ["EP", "grows a skill through use"],
    ],
  },
  {
    title: "Skill types",
    rows: [
      ["Action (red)", "spends AP and MP on your turn"],
      ["Reaction (yellow)", "fires on its own when triggered"],
      ["Passive (blue)", "always on, costs nothing"],
    ],
  },
  {
    title: "In battle",
    lines: ["No random encounters. Where you make contact becomes the grid."],
    rows: [
      ["Where you fight", "the ground you were standing on"],
      ["Facing at contact", "sets the initiative order"],
      ["Facing in the fight", "strike from behind to hit far more often"],
    ],
  },
  {
    title: "Growing stronger",
    lines: ["Spend JP and SP as you earn them — an unspent pile is wasted power."],
    rows: [
      ["XP", "won from fights; fills to a level"],
      ["JP", "granted each level; buys raw stats"],
      ["SP", "granted each level; buys skill-tree nodes"],
      ["Expertise", "earned by using a skill; makes it stronger"],
    ],
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
