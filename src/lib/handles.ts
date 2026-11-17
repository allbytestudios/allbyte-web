// Username saves: the host half (server: infrastructure/handle-saves.yaml).
//
// A four-word username (black-sparkling-opaque-ostrich) is the whole credential
// for a set of saves on the server. Deliberately not secure (owner, 2026-11-17):
// it is a quick way back into a game, on top of save export/import and Patreon
// login. The game shows the Save/Load page UI and keeps a local copy of each
// username's slots; this module owns the device list, the account-linked list
// and every network call. Contract: APP_CLAUDE_USERNAME_SAVES.md "BUILD GO".
//
// Kept free of Svelte and the DOM (dependencies are passed in) so it unit-tests
// under node:test; saves.svelte.ts wires it to the game iframe.

export const HANDLES_API = "https://1f379pb6ek.execute-api.us-east-1.amazonaws.com";
export const HANDLE_SHAPE = /^[a-z]+(-[a-z]+){3}$/;
const RECENT_KEY = "ab_handles";
const ACTIVE_KEY = "ab_handle_active";
const PENDING_KEY = "ab_handle_pending";
const MAX_RECENT = 20;
const UPLOAD_DELAY_MS = 2000;
const RETRY_DELAY_MS = 30000;
const MAX_CONFLICT_RETRIES = 3;

export type HandleError = "not_found" | "invalid" | "rate_limited" | "network" | "unavailable";
type Saves = Record<string, string>;

export interface HandleDeps {
  fetch: typeof fetch;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
  post: (message: Record<string, unknown>) => void;
  token: () => string | null;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (id: unknown) => void;
  api?: string;
}

/** Lowercase; any run of spaces or . _ , / \ - becomes one dash. Same rule as the server. */
export function normalizeHandle(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().toLowerCase().replace(/[\s._,/\\-]+/g, "-").replace(/^-+|-+$/g, "");
}

class Failure extends Error {
  code: HandleError;
  retryAfterSec?: number;
  constructor(code: HandleError, retryAfterSec?: number) {
    super(code);
    this.code = code;
    this.retryAfterSec = retryAfterSec;
  }
}

export class HandleSession {
  private deps: HandleDeps;
  private api: string;
  active: string | null;
  linked: string[] = [];
  // Last server copy of each username we've talked to: the base for uploads.
  private server = new Map<string, { saves: Saves; revision: number }>();
  private timer: unknown = null;
  private flushing: Promise<void> | null = null;

  constructor(deps: HandleDeps) {
    this.deps = deps;
    this.api = deps.api ?? HANDLES_API;
    const stored = deps.storage.getItem(ACTIVE_KEY);
    this.active = stored && HANDLE_SHAPE.test(stored) ? stored : null;
  }

  // ------------------------------------------------------------ lists

  recent(): string[] {
    return this.readJson<{ h: string; t: number }[]>(RECENT_KEY, [])
      .filter((e) => e && typeof e.h === "string" && HANDLE_SHAPE.test(e.h))
      .sort((a, b) => b.t - a.t)
      .map((e) => e.h);
  }

  private remember(handle: string) {
    const list = this.readJson<{ h: string; t: number }[]>(RECENT_KEY, []).filter((e) => e?.h !== handle);
    list.unshift({ h: handle, t: Date.now() });
    this.deps.storage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, MAX_RECENT)));
  }

  broadcast() {
    this.deps.post({ type: "allbyte:handles", active: this.active, recent: this.recent(), linked: this.linked });
  }

  // ------------------------------------------------------------ lifecycle

  /** On game ready: publish the lists, then restore the last active username. */
  async start() {
    this.broadcast();
    await this.refreshLinked();
    if (!this.active) return;
    const handle = this.active;
    try {
      await this.flush();
      const got = await this.fetchSaves(handle);
      if (this.active === handle) this.deps.post({ type: "allbyte:handle-result", requestId: null, ok: true, handle, ...got });
    } catch (e) {
      // Keep the username: the game still has its local copy, and uploads retry.
      this.deps.post(this.failure(null, e));
    }
  }

  async refreshLinked() {
    if (!this.deps.token()) {
      if (this.linked.length) { this.linked = []; this.broadcast(); }
      return;
    }
    try {
      const res = await this.call("GET", "/me/handles");
      this.linked = Array.isArray(res.handles) ? res.handles.filter((h: unknown) => typeof h === "string") : [];
      this.broadcast();
    } catch { /* the device list still works */ }
  }

  // ------------------------------------------------------------ game requests

  async select(requestId: string, raw: unknown) {
    const handle = normalizeHandle(raw);
    if (!HANDLE_SHAPE.test(handle)) return this.deps.post(this.failure(requestId, new Failure("invalid")));
    try {
      await this.flush();
      const got = await this.fetchSaves(handle);
      this.adopt(handle);
      this.deps.post({ type: "allbyte:handle-result", requestId, ok: true, handle, ...got });
      this.broadcast();
      void this.linkToAccount(handle);
    } catch (e) {
      this.deps.post(this.failure(requestId, e));
    }
  }

  async create(requestId: string) {
    try {
      await this.flush();
      const res = await this.call("POST", "/handles");
      const handle = String(res.handle);
      this.server.set(handle, { saves: {}, revision: 0 });
      this.adopt(handle);
      this.deps.post({ type: "allbyte:handle-result", requestId, ok: true, handle, saves: {}, revision: 0 });
      this.broadcast();
      // The server links on create when a token is sent; refresh to pick it up.
      if (this.deps.token()) void this.refreshLinked();
    } catch (e) {
      this.deps.post(this.failure(requestId, e));
    }
  }

  clear(requestId: string) {
    void this.flush();
    this.active = null;
    this.deps.storage.removeItem(ACTIVE_KEY);
    this.deps.post({ type: "allbyte:handle-result", requestId, ok: true, handle: null });
    this.broadcast();
  }

  private adopt(handle: string) {
    this.active = handle;
    this.deps.storage.setItem(ACTIVE_KEY, handle);
    this.remember(handle);
  }

  private async linkToAccount(handle: string) {
    if (!this.deps.token()) return;
    try {
      const res = await this.call("POST", "/me/handles", { handle });
      if (Array.isArray(res.handles)) { this.linked = res.handles; this.broadcast(); }
    } catch { /* linking is a convenience; the device list still has it */ }
  }

  // ------------------------------------------------------------ uploads

  /** A slot was written under `handle` (autosave = slot 0, quicksave = 13). */
  slotChanged(handle: unknown, slotId: unknown, data: unknown) {
    if (typeof handle !== "string" || !HANDLE_SHAPE.test(handle)) return; // device save: stays local
    if (!Number.isInteger(slotId) || (slotId as number) < 0 || (slotId as number) > 99 || typeof data !== "string") return;
    const pending = this.pending();
    (pending[handle] ??= {})[`slot_${slotId}`] = data;
    this.deps.storage.setItem(PENDING_KEY, JSON.stringify(pending));
    this.schedule(UPLOAD_DELAY_MS);
  }

  hasPending(): boolean {
    return Object.keys(this.pending()).length > 0;
  }

  private schedule(ms: number) {
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => { this.timer = null; void this.flush(); }, ms);
  }

  /** Upload every pending username. Safe to call repeatedly; runs one at a time. */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushAll().finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private async flushAll() {
    for (const handle of Object.keys(this.pending())) {
      try {
        await this.upload(handle);
      } catch {
        this.schedule(RETRY_DELAY_MS); // offline or server trouble: keep it, try later
        return;
      }
    }
  }

  private async upload(handle: string) {
    for (let attempt = 0; attempt <= MAX_CONFLICT_RETRIES; attempt++) {
      const changes = this.pending()[handle];
      if (!changes) return;
      const base = this.server.get(handle) ?? await this.fetchSaves(handle);
      const merged = { ...base.saves, ...changes };
      try {
        const res = await this.call("PUT", `/handles/${handle}/saves`, { saves: merged, expectedRevision: base.revision });
        this.server.set(handle, { saves: merged, revision: Number(res.revision) });
        // Drop only what we sent; a write that arrived mid-upload stays queued.
        const pending = this.pending();
        for (const [slot, value] of Object.entries(changes)) {
          if (pending[handle]?.[slot] === value) delete pending[handle][slot];
        }
        if (pending[handle] && !Object.keys(pending[handle]).length) delete pending[handle];
        this.deps.storage.setItem(PENDING_KEY, JSON.stringify(pending));
        return;
      } catch (e) {
        if ((e as { status?: number }).status === 409) { this.server.delete(handle); continue; } // another tab won: rebase
        if ((e as { status?: number }).status === 404) { this.dropPending(handle); return; } // name is gone
        throw e;
      }
    }
    throw new Failure("unavailable");
  }

  private dropPending(handle: string) {
    const pending = this.pending();
    delete pending[handle];
    this.deps.storage.setItem(PENDING_KEY, JSON.stringify(pending));
  }

  private pending(): Record<string, Saves> {
    return this.readJson<Record<string, Saves>>(PENDING_KEY, {});
  }

  // ------------------------------------------------------------ network

  private async fetchSaves(handle: string) {
    const res = await this.call("GET", `/handles/${handle}`);
    const got = { saves: (res.saves ?? {}) as Saves, revision: Number(res.revision ?? 0) };
    this.server.set(handle, got);
    return got;
  }

  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    const token = this.deps.token();
    if (token) headers.authorization = `Bearer ${token}`;
    let res: Response;
    try {
      res = await this.deps.fetch(this.api + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new Failure("network");
    }
    let json: any = {};
    try { json = await res.json(); } catch { /* empty body */ }
    if (res.status >= 200 && res.status < 300) return json;
    const fail = res.status === 429 ? new Failure("rate_limited", Number(json.retryAfterSec) || 600)
      : res.status === 404 ? new Failure("not_found")
      : res.status === 400 ? new Failure("invalid")
      : new Failure("unavailable");
    (fail as unknown as { status: number }).status = res.status;
    throw fail;
  }

  private failure(requestId: string | null, e: unknown) {
    const f = e instanceof Failure ? e : new Failure("unavailable");
    return { type: "allbyte:handle-result", requestId, ok: false, handle: this.active, error: f.code,
      ...(f.retryAfterSec !== undefined ? { retryAfterSec: f.retryAfterSec } : {}) };
  }

  private readJson<T>(key: string, fallback: T): T {
    try {
      const raw = this.deps.storage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : fallback;
      return parsed ?? fallback;
    } catch {
      return fallback;
    }
  }
}
