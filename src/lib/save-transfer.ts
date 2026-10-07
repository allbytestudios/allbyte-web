export interface Snapshot {
  saves: Record<string, string>;
  options: string;
  keymapping: string;
}

export const MAX_TRANSFER_BYTES = 8 * 1024 * 1024;

export function parseSnapshot(value: unknown, maxSlots = 12): Snapshot {
  const v = value as Partial<Snapshot> | null;
  if (!v || typeof v !== 'object' || Array.isArray(v) || !v.saves ||
      typeof v.saves !== 'object' || Array.isArray(v.saves)) throw Error('Invalid save bundle');
  const entries = Object.entries(v.saves);
  if (entries.length > maxSlots) throw Error('Too many save slots');
  for (const [key, data] of entries) {
    if (!/^slot_[1-9]\d*$/.test(key) || Number(key.slice(5)) > maxSlots || typeof data !== 'string') {
      throw Error('Unsupported save slot or payload');
    }
  }
  for (const key of ['options', 'keymapping'] as const) {
    if (v[key] !== undefined && typeof v[key] !== 'string') throw Error(`Invalid ${key}`);
  }
  if (new TextEncoder().encode(JSON.stringify(v)).length > MAX_TRANSFER_BYTES) throw Error('Save bundle is too large');
  return { saves: { ...v.saves }, options: v.options ?? '', keymapping: v.keymapping ?? '' };
}

export function parseBackup(text: string, maxSlots = 12): Snapshot {
  if (new TextEncoder().encode(text).length > MAX_TRANSFER_BYTES) throw Error('Save file is too large');
  const v = JSON.parse(text);
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Invalid save file');
  if (v.version !== 1) throw Error('Unsupported save file version. Use a version 1 bundle exported by this host.');
  if (v.game !== undefined && v.game !== 'chronicles-of-nesis') throw Error('Save file is for another game');
  if (!v.saves) throw Error('A save bundle is required. Legacy single-slot files are not supported; export a bundle from the host.');
  return parseSnapshot(v, maxSlots);
}

export class SaveRequests {
  private pending = new Map<string, { type: string; session: string; resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  wait(id: string, type: string, session: string, timeout: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error(type === 'allbyte:load-complete' ? 'Import result unknown. Do not retry until the game result is reconciled.' : 'The game did not return a fresh snapshot. Please retry.'));
      }, timeout);
      this.pending.set(id, { type, session, resolve, reject, timer });
    });
  }
  accept(data: any): boolean {
    const p = this.pending.get(data.requestId);
    if (!p || p.type !== data.type || p.session !== data.sessionId) return false;
    clearTimeout(p.timer);
    this.pending.delete(data.requestId);
    p.resolve(data);
    return true;
  }
  cancel() {
    for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(Error('Game session ended')); }
    this.pending.clear();
  }
}
