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
    title: "Damage types",
    rows: [
      ["Physical", "blocked by physical defense"],
      ["Poison", "leaves the target Poisoned"],
      ["Acid", "leaves the target Acid Covered"],
      ["Radiant (Smite)", "ignores physical defense AND resistance"],
      ["Every element", "blocked only by Magic Defense"],
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
      ["Intelligence", "magic attack + defense (softens Smite)"],
      ["Wisdom", "the off-stat that feeds everything"],
    ],
  },
  {
    title: "Battle stats — calculated from your build",
    rows: [
      ["HP", "← Constitution · what you can take"],
      ["MP", "← Intelligence · fuels Smite & Cure"],
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
      ["Action (red)", "Smite · Cure · Push — spends AP/MP on your turn"],
      ["Reaction (yellow)", "Counterattack · Parry — fires on its own"],
      ["Passive (blue)", "Scan · Move-up — always on"],
    ],
  },
  {
    title: "In battle",
    lines: [
      "No random encounters — you see enemies on the field. Where you make contact groups them, and the ground you stand on becomes the grid.",
      "Radiant damage (Smite) ignores physical defense AND resistance — the answer to a tanky wall like the Venom Slime.",
      "Your crits swing fights your way — roughly 16% for you against a foe's 6%.",
    ],
  },
  {
    title: "Growing stronger",
    lines: [
      "Win fights for XP, then level up — each level grants JP for raw stats and SP for the Paladin skill tree.",
      "Skills grow with use: lean on one and it earns Expertise, getting stronger over a run.",
      "Spend your JP and SP after every level. An unspent pile is wasted power.",
    ],
  },
];

// --- "Living manual" sprite card -------------------------------------------
// One load card is a random non-boss sprite that turns + swings, captioned with
// the character's role + blurb below. The loader builds the visual cast from the
// handcrafted sprite GIFs; these constants are the shared identity + copy.
export const NONBOSS_SPRITES = new Set([
  "Elias",
  "Falmri",
  "eastwood",
  "spiter",
  "vepir",
  "slime",
]);

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
  Eastwood: { role: "Enemy · Episode One", blurb: "" },
  Spiter: { role: "Enemy · Episode One", blurb: "" },
  Vepir: { role: "Enemy · Episode One", blurb: "" },
};
