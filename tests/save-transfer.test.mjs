import assert from 'node:assert/strict';
import { test, afterEach } from 'node:test';
import { build } from 'esbuild';
import { compileModule } from 'svelte/compiler';
import { readFile } from 'node:fs/promises';
import { SaveRequests, parseBackup, MAX_TRANSFER_BYTES } from '../src/lib/save-transfer.ts';

// Compile the real rune module for an isolated host harness. No app server,
// signed-in browser profile, deployed game or network is used here.
const built = await build({
  entryPoints: ['src/lib/saves.svelte.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', define: { 'import.meta.env.DEV': 'false' },
  plugins: [{ name: 'save-test', setup(b) {
    b.onResolve({ filter: /auth\.svelte\.ts$/ }, () => ({ path: 'auth', namespace: 'stub' }));
    b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const auth = globalThis.__saveAuth;' }));
    b.onLoad({ filter: /saves\.svelte\.ts$/ }, async args => {
      const ts = await readFile(args.path, 'utf8');
      const stripped = (await import('typescript')).default.transpileModule(ts, { compilerOptions: { target: 99, module: 99 } }).outputText;
      return { contents: compileModule(stripped, { filename: args.path, generate: 'server' }).js.code, loader: 'js' };
    });
  } }],
});
let counter = 0;
let active;
function snapshot(value = 'original') { return { saves: { slot_1: JSON.stringify({ gameName: 'Chronicles of Nesis', timestamp: 1, value }) }, options: '{}', keymapping: '{}' }; }
async function harness(signedIn = false) {
  globalThis.__saveAuth = { currentUser: signedIn ? { userId: 'a' } : null };
  const listeners = new Map();
  const messages = [];
  let downloads = 0;
  globalThis.window = { location: { href: 'https://host.test/play/' },
    addEventListener: (type, fn) => listeners.set(type, fn), removeEventListener: type => listeners.delete(type),
    dispatchEvent: event => { listeners.get(event.type)?.(event); return true; } };
  globalThis.document = { visibilityState: 'visible', body: { appendChild() {} },
    addEventListener() {}, removeEventListener() {}, createElement: tag => ({ style: {},
      addEventListener() {}, removeEventListener() {}, remove() {}, click() { if (tag === 'a') downloads++; } }) };
  const storage = new Map([['allbyte_token', 'test-token']]);
  globalThis.localStorage = { getItem: key => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };
  const iframe = { src: 'https://host.test/godot/index.html', addEventListener() {}, removeEventListener() {},
    contentWindow: { postMessage: (data, origin) => messages.push({ ...data, origin }) } };
  const mod = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text + `\n// ${counter++}`).toString('base64')}`);
  active = mod;
  mod.initSaveBridge(iframe);
  function send(data, extra = {}) { listeners.get('message')?.({ data: { protocolVersion: 2, sessionId: 'game-1', ...data }, source: iframe.contentWindow, origin: 'https://host.test', ...extra }); }
  function ready() { send({ type: 'allbyte:ready', maxSaveSlots: 12,
    saveCapabilities: { correlatedRequests: true, atomicImport: true, importConfirmation: true } }); }
  function reply(request, data = snapshot()) { send({ type: 'allbyte:all-saves', requestId: request.requestId, ...data }); }
  async function tick() { await new Promise(resolve => setImmediate(resolve)); }
  return { mod, messages, send, ready, reply, tick, downloads: () => downloads };
}
afterEach(() => active?.teardownSaveBridge());

test('production rejects wrong source, origin and dev bypass', async () => {
  const h = await harness(); window.__saves_test_skip_source_check = true;
  h.send({ type: 'allbyte:ready', maxSaveSlots: 12 }, { origin: 'https://evil.test' });
  h.send({ type: 'allbyte:ready', maxSaveSlots: 12 }, { source: {} });
  assert.equal(h.mod.saves.gameReady, false);
  h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves'));
  await h.tick(); assert.equal(h.mod.saves.gameReady, true);
  assert.equal(window.__saves_test, undefined);
  assert.equal(window.__allbyteSaveTrace, undefined);
  assert(h.messages.every(m => m.origin === 'https://host.test'));
});

test('export ignores unrelated and previous-session snapshots', async () => {
  const h = await harness(); h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves'));
  await h.tick();
  const pending = h.mod.downloadSavesFile();
  const request = h.messages.filter(m => m.type === 'allbyte:request-saves').at(-1);
  h.send({ type: 'allbyte:all-saves', requestId: 'other', ...snapshot('wrong') });
  h.send({ type: 'allbyte:all-saves', requestId: request.requestId, sessionId: 'old', ...snapshot('wrong') });
  await h.tick(); assert.equal(h.downloads(), 0);
  h.reply(request, snapshot('fresh')); await pending;
  assert.equal(h.downloads(), 1);
});

test('empty export downloads nothing and a later occupied snapshot can be exported', async () => {
  const h = await harness(); h.ready();
  h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  const emptyExport = h.mod.downloadSavesFile();
  h.reply(h.messages.filter(m => m.type === 'allbyte:request-saves').at(-1), { saves: {}, options: '', keymapping: '' });
  await emptyExport;
  assert.equal(h.downloads(), 0);
  assert.match(h.mod.saves.errorMessage, /numbered slot.*autosave and quicksave/);
  const populatedExport = h.mod.downloadSavesFile();
  h.reply(h.messages.filter(m => m.type === 'allbyte:request-saves').at(-1), snapshot('populated'));
  await populatedExport;
  assert.equal(h.downloads(), 1);
  assert.equal(h.mod.saves.errorMessage, null);
});

test('import waits for durable ack, excludes settings and accepts authoritative snapshot', async () => {
  const h = await harness(); h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  const pending = h.mod.uploadSavesFile(new File([JSON.stringify({ version: 1, ...snapshot('candidate') })], 'saves.json'));
  await h.tick();
  const request = h.messages.find(m => m.type === 'allbyte:load-saves');
  assert.equal(request.source, 'import'); assert.equal(request.options, undefined);
  assert.equal(request.keymapping, undefined);
  assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value, 'original');
  h.send({ type: 'allbyte:load-complete', requestId: request.requestId, ok: true, snapshot: snapshot('committed'), acceptedSlots: [1] });
  assert.equal(await pending, null);
  assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value, 'committed');
});

test('invalid and future files never reach game; failed import preserves mirror', async () => {
  const h = await harness(); h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  for (const value of [{ version: 2, ...snapshot() }, { version: 1, saves: [] }, { version: 1, saves: { slot_99: '{}' } }]) {
    assert(await h.mod.uploadSavesFile(new File([JSON.stringify(value)], 'bad.json')));
  }
  assert.equal(h.messages.filter(m => m.type === 'allbyte:load-saves').length, 0);
  const pending = h.mod.uploadSavesFile(new File([JSON.stringify({ version: 1, ...snapshot('bad') })], 'saves.json'));
  await h.tick(); const request = h.messages.find(m => m.type === 'allbyte:load-saves');
  h.send({ type: 'allbyte:load-complete', requestId: request.requestId, ok: false, reason: 'storage_write_failed' });
  assert.match(await pending, /storage_write_failed/);
  assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value, 'original');
});

test('teardown cancels an export without downloading cached data', async () => {
  const h = await harness(); h.ready();
  const pending = h.mod.downloadSavesFile(); h.mod.teardownSaveBridge(); await pending;
  assert.equal(h.downloads(), 0); assert.deepEqual(h.mod.saves.current.saves, {});
});

test('empty and settings-only backups never reach game and do not lock out another import', async () => {
  const h=await harness(); h.ready(); h.reply(h.messages.find(m=>m.type==='allbyte:request-saves')); await h.tick();
  for (const options of ['', '{"volume":0}']) {
    const error=await h.mod.uploadSavesFile(new File([JSON.stringify({version:1,saves:{},options})],'empty.json'));
    assert.match(error,/no saved game slots/);
  }
  assert.equal(h.messages.filter(m=>m.type==='allbyte:load-saves').length,0);
  assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value,'original');
  const pending=h.mod.uploadSavesFile(new File([JSON.stringify({version:1,...snapshot('valid')})],'valid.json'));
  await h.tick(); const request=h.messages.find(m=>m.type==='allbyte:load-saves'); assert(request);
  h.send({type:'allbyte:load-complete',requestId:request.requestId,ok:true,snapshot:snapshot('valid')});
  assert.equal(await pending,null);
});

test('request timeout removes waiter and teardown rejects pending operations', async () => {
  const requests = new SaveRequests();
  await assert.rejects(requests.wait('a', 'allbyte:all-saves', 's', 1), /fresh snapshot/);
  assert.equal(requests.accept({ type: 'allbyte:all-saves', requestId: 'a', sessionId: 's' }), false);
  const pending = requests.wait('b', 'allbyte:load-complete', 's', 500);
  requests.cancel(); await assert.rejects(pending, /session ended/);
});

test('wrong-game, oversized and noncanonical slot files are rejected', () => {
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, game: 'other', ...snapshot() })), /another game/);
  assert.throws(() => parseBackup(' '.repeat(MAX_TRANSFER_BYTES + 1)), /too large/);
  assert.throws(() => parseBackup(JSON.stringify({ version: 1, saves: { slot_01: '{}' } })), /slot/);
});

test('signed-in manual import ignores legacy cloud restore state and never contacts cloud', async () => {
  const h = await harness(true); const calls = [];
  globalThis.fetch = async (...args) => { calls.push(args); throw Error('cloud unavailable'); };
  const marker = JSON.stringify({ revision: null });
  localStorage.setItem('allbyte_save_restore_v1:a', marker);
  h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  assert.equal(h.messages.find(m => m.type === 'allbyte:account').cloudSaves, false);
  await h.mod.syncFromServer(); assert.equal(await h.mod.syncToServerNow(), false);
  for (const value of ['restored', 'second-import']) {
    const pending = h.mod.uploadSavesFile(new File([JSON.stringify({ version: 1, ...snapshot(value) })], 'saves.json'));
    await h.tick(); const request = h.messages.filter(m => m.type === 'allbyte:load-saves').at(-1);
    assert(request); assert.equal(request.source, 'import');
    assert.notEqual(JSON.parse(h.mod.saves.current.saves.slot_1).value, value);
    h.send({ type: 'allbyte:load-complete', requestId: request.requestId, ok: true, snapshot: snapshot(value) });
    assert.equal(await pending, null);
    assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value, value);
  }
  h.send({type:'allbyte:save-changed', slotId:1, data:snapshot('local').saves.slot_1});
  assert.equal(await h.mod.syncToServerNow(), false);
  assert.deepEqual(calls, []);
  assert.equal(localStorage.getItem('allbyte_save_restore_v1:a'), marker);
  assert.equal(h.mod.saves.syncStatus, 'idle');
});

test('replacing iframe session cancels pending transfer and allows a new one', async () => {
  const h = await harness(); h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  const old = h.mod.downloadSavesFile();
  h.send({ type: 'allbyte:ready', sessionId: 'game-2', maxSaveSlots: 12,
    saveCapabilities: { correlatedRequests: true, atomicImport: true, importConfirmation: true } });
  await old;
  const next = h.mod.downloadSavesFile();
  const request = h.messages.filter(m => m.type === 'allbyte:request-saves').at(-1);
  h.send({ type: 'allbyte:all-saves', sessionId: 'game-2', requestId: request.requestId, ...snapshot() });
  await next; assert.equal(h.downloads(), 1);
});

test('cancelled import preserves saves and permits another transfer', async () => {
  const h = await harness(); h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  const pending = h.mod.uploadSavesFile(new File([JSON.stringify({ version: 1, ...snapshot('candidate') })], 'saves.json'));
  await h.tick(); const request = h.messages.find(m => m.type === 'allbyte:load-saves');
  h.send({ type: 'allbyte:load-complete', requestId: request.requestId, ok: false, reason: 'cancelled' });
  assert.equal(await pending, null);
  assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value, 'original');
  const exported = h.mod.downloadSavesFile();
  h.reply(h.messages.filter(m => m.type === 'allbyte:request-saves').at(-1));
  await exported; assert.equal(h.downloads(), 1);
});

test('import timeout blocks retries until a matching late result arrives', async t => {
  const h = await harness(); h.ready(); h.reply(h.messages.find(m => m.type === 'allbyte:request-saves')); await h.tick();
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const file = new File([JSON.stringify({ version: 1, ...snapshot('candidate') })], 'saves.json');
  const pending = h.mod.uploadSavesFile(file);
  await h.tick(); const request = h.messages.find(m => m.type === 'allbyte:load-saves');
  t.mock.timers.tick(120000);
  assert.match(await pending, /result unknown/);
  assert.match(await h.mod.uploadSavesFile(file), /already pending/);
  assert.equal(h.messages.filter(m => m.type === 'allbyte:load-saves').length, 1);
  h.send({ type: 'allbyte:load-complete', requestId: request.requestId, ok: true, snapshot: snapshot('committed') });
  assert.equal(JSON.parse(h.mod.saves.current.saves.slot_1).value, 'committed');
  t.mock.timers.reset();
});
