// Static milestone metadata. Source of truth for milestone framing
// (status, description, ordering) — content lives here because it's owner
// scope/narrative, not derived from issue tracker state. Per-milestone
// progress is computed by combining this with `bd` issue counts.

export type MilestoneStatus = "complete" | "current" | "planned";

export interface MilestoneMeta {
  /** Matches the suffix of bd labels like "milestone:alpha" → "alpha". */
  id: string;
  label: string;
  status: MilestoneStatus;
  description: string;
  order: number;
}

export const MILESTONES: MilestoneMeta[] = [
  {
    id: "pre_alpha",
    label: "Pre Alpha",
    status: "complete",
    description: "Foundation web export",
    order: 1,
  },
  {
    id: "alpha",
    label: "Alpha",
    status: "current",
    description:
      "Combat working; gameplay through Mother Slime boss playable and tested",
    order: 2,
  },
  {
    id: "beta",
    label: "Beta",
    status: "planned",
    description: "",
    order: 3,
  },
];

const LABEL_PREFIX = "milestone:";

export function milestoneIdFromLabel(label: string): string | null {
  if (!label.startsWith(LABEL_PREFIX)) return null;
  return label.slice(LABEL_PREFIX.length);
}

export function milestoneIdFromLabels(labels: string[] | undefined): string | null {
  for (const l of labels ?? []) {
    const id = milestoneIdFromLabel(l);
    if (id) return id;
  }
  return null;
}

export function milestoneMeta(id: string | null | undefined): MilestoneMeta | null {
  if (!id) return null;
  return MILESTONES.find((m) => m.id === id) ?? null;
}

export function milestonesOrdered(): MilestoneMeta[] {
  return [...MILESTONES].sort((a, b) => a.order - b.order);
}
