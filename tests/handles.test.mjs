// Unit tests for the username-saves host module (src/lib/handles.ts).
// A fake server stands in for the API, with the same status codes and
// revision rules as infrastructure/handle-saves/index.py. No network.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HandleSession, normalizeHandle, HANDLE_SHAPE } from '../src/lib/handles.ts';

const A = 'black-sparkling-opaque-ostrich';
const B = 'white-mossy-quiet-otter';

function fakeServer() {
  const names = new Map(); // handle -> { saves, revision }
  const linked = new Map(); // token -> handles[]
  const log = [];
  let offline = false;
  let draws = [A, B, 'gray-fuzzy-calm-heron'];
  const reply = (status, body) => ({ status, json: async () => body });
  async function fetch(url, { method, headers, body }) {
    if (offline) throw new TypeError('Failed to fetch');
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const data = body ? JSON.parse(body) : undefined;
    const token = headers.authorization?.slice(7);
    log.push(`${method} ${path}`);
    let m;
    if (method === 'POST' && path === '/handles') {
      const h = draws.find(d => !names.has(d));
      names.set(h, { saves: {}, revision: 0 });
      if (token) linked.set(token, [h, ...(linked.get(token) ?? [])]);
      return reply(200, { handle: h, saves: {}, revision: 0 });
    }
    if (method === 'GET' && (m = path.match(/^\/handles\/([^/]+)$/))) {
      const rec = names.get(m[1]);
      return rec ? reply(200, { handle: m[1], saves: { ...rec.saves }, revision: rec.revision }) : reply(404, { error: 'not_found' });
    }
    if (method === 'PUT' && (m = path.match(/^\/handles\/([^/]+)\/saves$/))) {
      const rec = names.get(m[1]);
      if (!rec) return reply(404, { error: 'not_found' });
      if (data.expectedRevision !== rec.revision) return reply(409, { error: 'conflict', revision: rec.revision });
      rec.saves = { ...data.saves }; rec.revision++;
      return reply(200, { revision: rec.revision });
    }
    if (path === '/me/handles') {
      if (!token) return reply(401, {});
      if (method === 'POST') linked.set(token, [data.handle, ...(linked.get(token) ?? []).filter(h => h !== data.handle)]);
      return reply(200, { handles: linked.get(token) ?? [] });
    }
    return reply(404, {});
  }
  return { fetch, names, linked, log, setOffline: v => { offline = v; }, setDraws: d => { draws = d; } };
}

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k), m };
}

function session({ server = fakeServer(), storage = memoryStorage(), token = null } = {}) {
  const sent = [];
  const timers = [];
  const s = new HandleSession({
    fetch: server.fetch, storage, post: msg => sent.push(msg), token: () => token,
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {},
    api: 'https://api.test',
  });
  const results = () => sent.filter(x => x.type === 'allbyte:handle-result');
  const lastLists = () => sent.filter(x => x.type === 'allbyte:handles').at(-1);
  return { s, sent, server, storage, timers, results, lastLists };
}

// ------------------------------------------------------------ normalize

test('normalize resolves case and separators like the server', () => {
  assert.equal(normalizeHandle('Black Sparkling Opaque Ostrich'), A);
  assert.equal(normalizeHandle('  black_sparkling.opaque/ostrich '), A);
  assert.equal(normalizeHandle('BLACK--SPARKLING , OPAQUE\\OSTRICH'), A);
  assert.equal(normalizeHandle(42), '');
  assert.ok(HANDLE_SHAPE.test(A));
  assert.ok(!HANDLE_SHAPE.test('black-sparkling-ostrich'));
});

// ------------------------------------------------------------ create / select / clear

test('create adopts a new username with empty saves and remembers it on the device', async () => {
  const t = session();
  await t.s.create('r1');
  assert.deepEqual(t.results().at(-1), { type: 'allbyte:handle-result', requestId: 'r1', ok: true, handle: A, saves: {}, revision: 0 });
  assert.equal(t.storage.getItem('ab_handle_active'), A);
  assert.deepEqual(t.lastLists(), { type: 'allbyte:handles', active: A, recent: [A], linked: [] });
});

test('typing a messy existing name logs in and returns its saves', async () => {
  const t = session();
  t.server.names.set(A, { saves: { slot_1: 'one', slot_0: 'auto' }, revision: 4 });
  await t.s.select('r2', 'Black Sparkling_Opaque.Ostrich');
  const r = t.results().at(-1);
  assert.equal(r.ok, true); assert.equal(r.handle, A);
  assert.deepEqual(r.saves, { slot_1: 'one', slot_0: 'auto' });
  assert.deepEqual(t.s.recent(), [A]);
});

test('a name that is not four words fails as invalid without a network call', async () => {
  const t = session();
  await t.s.select('r3', 'hello there');
  assert.equal(t.results().at(-1).error, 'invalid');
  assert.equal(t.server.log.length, 0);
});

test('unknown name is not_found and keeps the current username', async () => {
  const t = session({ storage: memoryStorage({ ab_handle_active: B }) });
  t.server.names.set(B, { saves: {}, revision: 0 });
  await t.s.select('r4', A);
  const r = t.results().at(-1);
  assert.equal(r.ok, false); assert.equal(r.error, 'not_found'); assert.equal(r.handle, B);
  assert.equal(t.s.active, B);
});

test('rate limit passes retryAfterSec through to the game', async () => {
  const t = session();
  t.s.deps.fetch = async () => ({ status: 429, json: async () => ({ error: 'rate_limited', retryAfterSec: 412 }) });
  await t.s.select('r5', A);
  const r = t.results().at(-1);
  assert.equal(r.error, 'rate_limited'); assert.equal(r.retryAfterSec, 412);
});

test('offline select reports network and keeps the username', async () => {
  const t = session({ storage: memoryStorage({ ab_handle_active: B }) });
  t.server.setOffline(true);
  await t.s.select('r6', A);
  assert.equal(t.results().at(-1).error, 'network');
  assert.equal(t.s.active, B);
});

test('clear returns to device saves', async () => {
  const t = session({ storage: memoryStorage({ ab_handle_active: A }) });
  t.s.clear('r7');
  assert.deepEqual(t.results().at(-1), { type: 'allbyte:handle-result', requestId: 'r7', ok: true, handle: null });
  assert.equal(t.storage.getItem('ab_handle_active'), null);
  assert.equal(t.lastLists().active, null);
});

// ------------------------------------------------------------ uploads

test('slot writes under a username upload merged with the server copy', async () => {
  const t = session();
  t.server.names.set(A, { saves: { slot_1: 'old1', slot_2: 'keep' }, revision: 1 });
  await t.s.select('r', A);
  t.s.slotChanged(A, 1, 'new1');
  t.s.slotChanged(A, 0, 'auto');
  assert.equal(t.timers.at(-1).ms, 2000, 'debounced ~2s');
  await t.s.flush();
  assert.deepEqual(t.server.names.get(A), { saves: { slot_1: 'new1', slot_2: 'keep', slot_0: 'auto' }, revision: 2 });
  assert.equal(t.s.hasPending(), false);
});

test('device saves (handle null) never upload', async () => {
  const t = session();
  t.s.slotChanged(null, 1, 'local');
  await t.s.flush();
  assert.equal(t.s.hasPending(), false);
  assert.ok(!t.server.log.some(l => l.startsWith('PUT')));
});

test('autosave 0 and quicksave 13 are accepted; junk slot ids are not', () => {
  const t = session();
  t.s.slotChanged(A, 0, 'a'); t.s.slotChanged(A, 13, 'q');
  t.s.slotChanged(A, 100, 'x'); t.s.slotChanged(A, 1.5, 'x'); t.s.slotChanged(A, 2, 7);
  assert.deepEqual(JSON.parse(t.storage.getItem('ab_handle_pending')), { [A]: { slot_0: 'a', slot_13: 'q' } });
});

test('a second tab writing first causes a rebase, not a lost save', async () => {
  const t = session();
  t.server.names.set(A, { saves: { slot_1: 'a' }, revision: 1 });
  await t.s.select('r', A);
  // Another tab uploads slot_2 behind our back.
  t.server.names.set(A, { saves: { slot_1: 'a', slot_2: 'other-tab' }, revision: 2 });
  t.s.slotChanged(A, 1, 'mine');
  await t.s.flush();
  assert.deepEqual(t.server.names.get(A).saves, { slot_1: 'mine', slot_2: 'other-tab' });
  assert.equal(t.server.names.get(A).revision, 3);
});

test('offline writes survive a reload and upload on the next start', async () => {
  const server = fakeServer();
  server.names.set(A, { saves: { slot_1: 'server' }, revision: 1 });
  const storage = memoryStorage();
  const first = session({ server, storage });
  await first.s.select('r', A);
  server.setOffline(true);
  first.s.slotChanged(A, 1, 'offline-write');
  await first.s.flush();
  assert.equal(first.timers.at(-1).ms, 30000, 'retry later when offline');
  // Page reloads; the network is back.
  server.setOffline(false);
  const second = session({ server, storage });
  await second.s.start();
  assert.deepEqual(server.names.get(A).saves, { slot_1: 'offline-write' });
  const boot = second.results().at(-1);
  assert.equal(boot.requestId, null); assert.equal(boot.ok, true);
  assert.deepEqual(boot.saves, { slot_1: 'offline-write' }, 'game gets the merged copy, not the stale one');
});

test('switching username uploads the previous one first', async () => {
  const t = session();
  t.server.names.set(A, { saves: {}, revision: 0 });
  t.server.names.set(B, { saves: {}, revision: 0 });
  await t.s.select('r1', A);
  t.s.slotChanged(A, 3, 'before-switch');
  await t.s.select('r2', B);
  assert.equal(t.server.names.get(A).saves.slot_3, 'before-switch');
});

// ------------------------------------------------------------ boot + account

test('start restores the last active username unsolicited (requestId null)', async () => {
  const t = session({ storage: memoryStorage({ ab_handle_active: A }) });
  t.server.names.set(A, { saves: { slot_2: 'two' }, revision: 7 });
  await t.s.start();
  const r = t.results().at(-1);
  assert.deepEqual(r, { type: 'allbyte:handle-result', requestId: null, ok: true, handle: A, saves: { slot_2: 'two' }, revision: 7 });
});

test('a stored active value that is not a username is ignored', () => {
  const t = session({ storage: memoryStorage({ ab_handle_active: 'nonsense' }) });
  assert.equal(t.s.active, null);
});

test('signed in: linked names show in the dropdown and new names link to the account', async () => {
  const server = fakeServer();
  server.names.set(B, { saves: {}, revision: 0 });
  server.linked.set('tok', [B]);
  const t = session({ server, token: 'tok' });
  await t.s.start();
  assert.deepEqual(t.lastLists().linked, [B]);
  await t.s.create('r');
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(t.lastLists().linked, [A, B]);
});

test('signed in: logging into an existing name links it', async () => {
  const server = fakeServer();
  server.names.set(A, { saves: {}, revision: 0 });
  const t = session({ server, token: 'tok' });
  await t.s.select('r', A);
  await new Promise(r => setTimeout(r, 0));
  assert.deepEqual(server.linked.get('tok'), [A]);
  assert.deepEqual(t.lastLists().linked, [A]);
});

test('recent list is newest first, de-duplicated and capped', async () => {
  const t = session();
  for (const h of [A, B, A]) { t.server.names.set(h, { saves: {}, revision: 0 }); await t.s.select('r', h); }
  assert.deepEqual(t.s.recent(), [A, B]);
});
