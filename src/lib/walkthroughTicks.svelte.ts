/**
 * Walkthrough checklist state — shared across islands.
 *
 * The nav rail (progress per section) and the per-scene checklists are separate
 * Astro islands, so tick state can't live in either one. This module-level rune
 * store is the shared source; both import it and stay in sync automatically.
 *
 * Keyed by `${code}::${item name}` rather than by array index, so a reader's
 * ticks survive Quinn reordering or inserting items. They only reset if an item
 * is renamed, which is the correct behaviour — a renamed item is a different
 * item, and silently carrying a tick across would be worse.
 *
 * Anonymous and local-only: no account, no server, nothing to sync. A walkthrough
 * checklist isn't worth an auth prompt.
 */

const STORAGE_KEY = "walkthrough-ticks";

class TickStore {
  ticked = $state<Record<string, boolean>>({});
  loaded = $state(false);

  load() {
    if (this.loaded) return;
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) this.ticked = JSON.parse(raw);
    } catch {
      /* corrupt or unavailable storage — start clean rather than break the page */
    }
    this.loaded = true;
  }

  private persist() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.ticked));
    } catch {
      /* quota or private mode — ticks still work for the session */
    }
  }

  key(code: string, name: string) {
    return `${code}::${name}`;
  }

  isTicked(code: string, name: string) {
    return !!this.ticked[this.key(code, name)];
  }

  toggle(code: string, name: string) {
    const k = this.key(code, name);
    // Reassign rather than mutate so the rune's proxy sees the change.
    this.ticked = { ...this.ticked, [k]: !this.ticked[k] };
    this.persist();
  }

  clear() {
    this.ticked = {};
    this.persist();
  }

  /** Ticked / total across the given [code, itemName] pairs. */
  progress(pairs: Array<[string, string]>) {
    const total = pairs.length;
    const done = pairs.filter(([c, n]) => this.isTicked(c, n)).length;
    return { done, total, pct: total ? Math.round((done / total) * 100) : 0 };
  }
}

export const ticks = new TickStore();
