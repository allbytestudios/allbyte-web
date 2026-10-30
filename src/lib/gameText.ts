/**
 * Game Text store — data layer for /test/game-text/ (bead mak7p).
 *
 * ONE list of every editable line of game text, each in its CURRENT in-game
 * state, plus a propose → review → apply loop over it. The contract with Arc
 * (CON_CLAUDE_GAME_TEXT_EXPORT_SHAPE.md, amendments agreed 2026-10-29):
 *
 *  - Export: Arc's `tools/game_text.json` — dialogue / ambient / vignette, one
 *    entry per line, `text` = the EFFECTIVE line (core + applied overrides).
 *    `card` entries are App's and are built here from manualCards.ts, the same
 *    source the loader draws, so they can never drift from what ships.
 *  - hash = sha1 over the exact UTF-8 bytes (no trim, no normalisation), first
 *    12 hex. Both sides compute it; it must agree byte for byte.
 *  - Proposals + reviews are append-only streams. Status is DERIVED, never
 *    stored: a proposal is applied when the export carries its text, stale when
 *    the line changed under it, and otherwise follows the owning lead's verdict.
 *  - v1 is edit-only: no adding or deleting lines through the tab.
 */

import { MANUAL_CARDS } from "./manualCards";

export type TextKind = "dialogue" | "ambient" | "vignette" | "card";
export type Person = "owner" | "arc" | "app" | "quinn" | "rowan";

export interface TextEntry {
  id: string;
  kind: TextKind;
  source_ref: { file: string; key: string };
  context: Record<string, unknown>;
  text: string;
  game_version: string;
  hash: string;
  /** id before '#': the lines of one situation / relic tier / card */
  group: string;
  order: number;
}

export interface GameTextExport {
  schema_version: number;
  game_version: string;
  generated_by?: string;
  entries: TextEntry[];
}

export interface Proposal {
  proposal_id: string;
  text_id: string;
  base_hash: string;
  proposed: string;
  author: Person;
  ts: string;
}

export interface Review {
  proposal_id: string;
  reviewer: Person;
  verdict: "approve" | "change" | "reject";
  note?: string;
  ts: string;
}

/** Who applies each kind: their approve is what triggers the apply. */
export const OWNING_LEAD: Record<TextKind, Person> = {
  dialogue: "arc",
  ambient: "arc",
  vignette: "arc",
  card: "app",
};

export const KIND_LABEL: Record<TextKind, string> = {
  dialogue: "Dialogue",
  ambient: "Ambient",
  vignette: "Vignettes",
  card: "Loading cards",
};

/** sha1(UTF-8 bytes)[:12] — the pinned contract hash. */
export async function textHash(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 12);
}

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60);

/**
 * App's half of the export: one entry per editable piece of each loading card.
 * id = card/<title-slug>#title | #l<i> | #r<i>.term | #r<i>.desc | #quote.
 */
export async function cardEntries(gameVersion: string): Promise<TextEntry[]> {
  const out: TextEntry[] = [];
  for (const [ci, card] of MANUAL_CARDS.entries()) {
    const group = `card/${slug(card.title)}`;
    const parts: [string, string, string][] = [["title", "Title", card.title]];
    card.lines?.forEach((l, i) => parts.push([`l${i}`, `Line ${i + 1}`, l]));
    card.rows?.forEach(([term, desc], i) => {
      parts.push([`r${i}.term`, `Row ${i + 1} term`, term]);
      parts.push([`r${i}.desc`, `Row ${i + 1} description`, desc]);
    });
    if (card.quote) parts.push(["quote", "Quote", card.quote]);
    for (const [order, [suffix, label, text]] of parts.entries()) {
      out.push({
        id: `${group}#${suffix}`,
        kind: "card",
        source_ref: { file: "(web)src/lib/manualCards.ts", key: `MANUAL_CARDS[${ci}].${suffix}` },
        context: { card: card.title, part: label, episode: "one", owner: "app", note: "documents the design, not the build" },
        text,
        game_version: gameVersion,
        hash: await textHash(text),
        group,
        order,
      });
    }
  }
  return out;
}

/** Fill `group` / `order` if an older export lacks them (pre-amendment sample). */
export function normaliseEntry(e: TextEntry): TextEntry {
  const [group, suffix = ""] = e.id.split("#");
  const n = Number(suffix.match(/\d+/)?.[0] ?? 0);
  return { ...e, group: e.group ?? group, order: e.order ?? n };
}

export function parseNdjson<T>(raw: string): T[] {
  const out: T[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try { out.push(JSON.parse(t) as T); } catch { /* skip a torn line, keep the rest */ }
  }
  return out;
}

export type ProposalStatus =
  | "applied"    // the export now carries the proposed text
  | "stale"      // the line changed under it; nothing to re-anchor to
  | "approved"   // owning lead approved; waiting for the apply + export
  | "rejected"
  | "changes"    // someone asked for changes
  | "pending";

export interface ResolvedProposal extends Proposal {
  status: ProposalStatus;
  /** the entry it currently attaches to (may differ from text_id after a re-anchor) */
  entry?: TextEntry;
  reanchored: boolean;
  reviews: Review[];
  proposedHash: string;
}

/**
 * Derive every proposal's status. Order matters:
 *  1. applied — the proposed text is live (exported hash == hash(proposed)),
 *     checked across the whole group so a reorder after the apply still counts.
 *  2. re-anchor — text_id's line changed, but a line in the same group still
 *     has base_hash: the line moved (a reorder), so follow it.
 *  3. stale — base_hash is nowhere in the group: the text it was written
 *     against is gone. Never applied over newer game text.
 *  4. otherwise the latest verdict: the owner's overrides everyone; the owning
 *     lead's approve is what makes it "approved"; anyone can reject or ask for changes.
 */
export async function resolveProposals(
  entries: TextEntry[],
  proposals: Proposal[],
  reviews: Review[],
): Promise<ResolvedProposal[]> {
  const byId = new Map(entries.map((e) => [e.id, e]));
  const byGroup = new Map<string, TextEntry[]>();
  for (const e of entries) (byGroup.get(e.group) ?? byGroup.set(e.group, []).get(e.group)!).push(e);
  const reviewsFor = new Map<string, Review[]>();
  for (const r of reviews) (reviewsFor.get(r.proposal_id) ?? reviewsFor.set(r.proposal_id, []).get(r.proposal_id)!).push(r);

  const out: ResolvedProposal[] = [];
  for (const p of proposals) {
    const proposedHash = await textHash(p.proposed);
    const group = byGroup.get(p.text_id.split("#")[0]) ?? [];
    const rs = (reviewsFor.get(p.proposal_id) ?? []).sort((a, b) => a.ts.localeCompare(b.ts));
    let entry = byId.get(p.text_id);
    let reanchored = false;
    let status: ProposalStatus;

    const live = group.find((e) => e.hash === proposedHash);
    if (live) {
      status = "applied";
      entry = live;
      reanchored = live.id !== p.text_id;
    } else {
      if (!entry || entry.hash !== p.base_hash) {
        const moved = group.find((e) => e.hash === p.base_hash);
        if (moved) { entry = moved; reanchored = true; }
        else { out.push({ ...p, status: "stale", entry, reanchored: false, reviews: rs, proposedHash }); continue; }
      }
      const lead = OWNING_LEAD[entry.kind];
      const owner = [...rs].reverse().find((r) => r.reviewer === "owner");
      const latest = rs.at(-1);
      if (owner) status = owner.verdict === "approve" ? "approved" : owner.verdict === "reject" ? "rejected" : "changes";
      else if (latest?.verdict === "reject") status = "rejected";
      else if (latest?.verdict === "change") status = "changes";
      else if (rs.some((r) => r.reviewer === lead && r.verdict === "approve")) status = "approved";
      else status = "pending";
    }
    out.push({ ...p, status, entry, reanchored, reviews: rs, proposedHash });
  }
  return out;
}

export const STATUS_LABEL: Record<ProposalStatus, string> = {
  applied: "applied ✓",
  stale: "stale",
  approved: "approved · awaiting apply",
  rejected: "rejected",
  changes: "changes requested",
  pending: "in review",
};

/** A one-line summary of where a line sits in the game, per kind. */
export function contextLine(e: TextEntry): string {
  const c = e.context as Record<string, any>;
  switch (e.kind) {
    case "dialogue":
    case "ambient": {
      const cond = c.condition && typeof c.condition === "object"
        ? `cond ${c.condition.min ?? "?"}–${c.condition.max ?? "?"}`
        : c.condition != null ? `cond ${c.condition}` : "";
      return [c.zone, c.scene, cond].filter(Boolean).join(" · ");
    }
    case "vignette":
      return [c.tier != null ? `tier ${c.tier}` : "", c.label, c.status].filter(Boolean).join(" · ");
    case "card":
      return String(c.part ?? "");
  }
}

/** The heading a group shows under (speaker / relic / card title). */
export function groupTitle(e: TextEntry): string {
  const c = e.context as Record<string, any>;
  switch (e.kind) {
    case "dialogue":
    case "ambient":
      return `${c.npc ?? "?"} — ${c.label ?? c.situation ?? e.group}`;
    case "vignette":
      return `${c.relic ?? e.group}${c.tier != null ? ` · tier ${c.tier}` : ""}`;
    case "card":
      return String(c.card ?? e.group);
  }
}
