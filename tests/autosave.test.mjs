import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/core.ts';
import { codec } from '../contracts/examples.ts';

const ok = value => ({ kind: 'ok', value });
const settle = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };
async function fixture(t, options = {}) {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let record = null, clock = 0, sequence = 0;
  const calls = [], writes = [];
  const storage = {
    async read() { return ok(record); },
    async write(_scope, next) { writes.push(next); record = next; return ok(); },
    async remove() { record = null; return ok(); },
  };
  const remote = {
    replayWindowMs: 10000,
    async load() { return ok({ kind: 'absent', revision: 'r0' }); },
    async save(request) { calls.push(request); return ok({ kind: 'present', revision: `r${++sequence}`, value: request.value }); },
    async discard() { return ok({ kind: 'absent', revision: 'deleted' }); },
  };
  const result = await core.createRecovery({ scope: { userId: 'u', documentId: 'd', editorId: 'e' },
    initialValue: { title: '' }, codec, storage, remote, now: () => clock,
    createOperationId: () => `op-${++sequence}`, ...options });
  assert.equal(result.kind, 'ok');
  await settle();
  const c = result.value;
  t.after(() => c.dispose());
  const tick = async ms => { clock += ms; t.mock.timers.tick(ms); await settle(); };
  return { c, remote, storage, calls, writes, tick, record: () => record };
}

test('manual local policy leaves input editable until explicitly persisted', async t => {
  const f = await fixture(t, { localWritePolicy: 'manual' });
  f.c.update({ title: 'local' }); await settle();
  assert.equal(f.writes.length, 0);
  assert.equal((await f.c.persistLocal()).kind, 'ok');
  assert.equal(JSON.parse(f.record().payload).title, 'local');
});

test('scheduler is an opt-in core export', () => {
  assert.equal(typeof core.createAutosaveScheduler, 'function');
});

test('rapid input debounces local and remote independently; explicit save cancels duplicate', async t => {
  const f = await fixture(t, { localWritePolicy: 'manual' });
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100, localDebounceMs: 20 });
  t.after(() => s.dispose());
  f.c.update({ title: 'A' }); await f.tick(10); f.c.update({ title: 'B' });
  await f.tick(19); assert.equal(f.writes.length, 0); assert.equal(f.calls.length, 0);
  await f.tick(1); assert.equal(JSON.parse(f.record().payload).title, 'B');
  await f.tick(79); assert.equal(f.calls.length, 0);
  await f.tick(1); assert.equal(f.calls[0].value.title, 'B');
  f.c.update({ title: 'C' }); assert.equal((await s.save()).kind, 'ok');
  await f.tick(1000); assert.equal(f.calls.length, 2);
});

test('disconnect cancels timers; remount resumes dirty input and reconnect schedules once', async t => {
  const f = await fixture(t);
  const first = core.createAutosaveScheduler(f.c, { debounceMs: 100 });
  f.c.update({ title: 'A' }); first.dispose(); await f.tick(500);
  assert.equal(f.calls.length, 0);
  const second = core.createAutosaveScheduler(f.c, { debounceMs: 100, online: false });
  t.after(() => second.dispose());
  await f.tick(500); assert.equal(f.calls.length, 0);
  second.setOnline(true); await f.tick(100); assert.equal(f.calls.length, 1);
});

for (const kind of ['retryable', 'unknown', 'conflict']) test(`${kind} blocks automatic dispatch; retry preserves frozen input`, async t => {
  const f = await fixture(t);
  f.remote.save = async request => { f.calls.push(request); return kind === 'conflict'
    ? { kind, current: { kind: 'absent', revision: 'other' } }
    : { kind, message: 'Offline', retryAfterMs: 500 }; };
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100 }); t.after(() => s.dispose());
  f.c.update({ title: 'A' }); await f.tick(100); f.c.update({ title: 'B' });
  s.setOnline(false); s.setOnline(true); await f.tick(100);
  assert.equal(f.calls.length, 1);
  if (kind === 'conflict') {
    assert.equal((await s.save()).kind, 'permanent');
    f.c.reconcile({ kind: 'absent', revision: 'other' }, f.c.getSnapshot().value);
  } else {
    assert.equal((await s.retry()).code, 'retry_not_ready');
    await f.tick(500);
    f.remote.save = async request => { f.calls.push(request); return ok({ kind: 'present', revision: 'r1', value: request.value }); };
    assert.equal((await s.retry()).kind, 'ok');
    assert.deepEqual(f.calls[1], f.calls[0]);
  }
  f.remote.save = async request => { f.calls.push(request); return ok({ kind: 'present', revision: 'r2', value: request.value }); };
  await f.tick(100); assert.equal(f.calls.at(-1).value.title, 'B');
});

test('UTF-8 limit blocks remote only, while local flush preserves input', async t => {
  const f = await fixture(t, { localWritePolicy: 'manual' });
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100, localDebounceMs: 50,
    validateRemote: value => new TextEncoder().encode(value.title).byteLength > 3
      ? { kind: 'permanent', code: 'payload_too_large', message: 'Too large' } : null });
  t.after(() => s.dispose());
  f.c.update({ title: '😀' }); assert.equal((await s.flushLocal()).kind, 'ok');
  await f.tick(100); assert.equal(f.calls.length, 0);
  assert.equal(JSON.parse(f.record().payload).title, '😀');
  f.c.update({ title: 'ok' }); await f.tick(100); assert.equal(f.calls.length, 1);
});

test('unavailable storage does not spin; explicit flush recovers and resumes remote', async t => {
  const f = await fixture(t, { localWritePolicy: 'manual' }); const write = f.storage.write;
  f.storage.write = async () => ({ kind: 'permanent', code: 'storage_unavailable', message: 'Denied' });
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100, localDebounceMs: 10 }); t.after(() => s.dispose());
  f.c.update({ title: 'A' }); await f.tick(10); await f.tick(1000);
  assert.equal(f.c.getSnapshot().error.code, 'storage_unavailable'); assert.equal(f.calls.length, 0);
  f.storage.write = write; await s.flushLocal(); await f.tick(100);
  assert.equal(f.calls.length, 1);
});

test('candidate and external save gates require resolution before automatic saves', async t => {
  const scope = { userId: 'u', documentId: 'd', editorId: 'e' };
  const storage = {
    async read() { return ok({ formatVersion: 1, scope, baseRevision: 'r0', dataVersion: 1,
      payload: JSON.stringify({ title: 'Recovered' }), savedAt: new Date().toISOString() }); },
    async write() { return ok(); }, async remove() { return ok(); },
  };
  const f = await fixture(t, { storage });
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100 }); t.after(() => s.dispose());
  f.c.update({ title: 'A' }); await f.tick(1000); assert.equal(f.calls.length, 0);
  f.c.restore(); await settle();
  s.setPaused(true); await f.tick(1000); assert.equal(f.calls.length, 0);
  s.setPaused(false);
  let finish, entered = false;
  const submitting = f.c.saveDocument(() => { entered = true; return new Promise(resolve => { finish = resolve; }); });
  await settle(); assert.equal(entered, true);
  await f.tick(1000); assert.equal(f.calls.length, 0);
  finish(ok({ id: 'd', version: 'v1' })); await submitting;
  await f.tick(100); assert.equal(f.calls.length, 1);
});

test('edits during an in-flight save get a new debounced save after acknowledgement', async t => {
  const f = await fixture(t); let finish;
  f.remote.save = request => { f.calls.push(request); return new Promise(resolve => { finish = resolve; }); };
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100 }); t.after(() => s.dispose());
  f.c.update({ title: 'A' }); await f.tick(100);
  f.c.update({ title: 'B' }); await f.tick(1000); assert.equal(f.calls.length, 1);
  finish(ok({ kind: 'present', revision: 'r1', value: { title: 'A' } })); await settle();
  await f.tick(99); assert.equal(f.calls.length, 1);
  await f.tick(1); assert.equal(f.calls[1].value.title, 'B');
  assert.equal(f.calls[1].expectedRevision, 'r1');
  finish(ok({ kind: 'present', revision: 'r2', value: { title: 'B' } })); await settle();
});

test('retry expiry fails closed and disconnected scheduler methods cannot dispatch', async t => {
  const f = await fixture(t);
  f.remote.save = async request => { f.calls.push(request); return { kind: 'unknown', message: 'Lost' }; };
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100 });
  f.c.update({ title: 'A' }); await f.tick(100); await f.tick(9000);
  assert.equal((await s.retry()).code, 'replay_window_expired'); assert.equal(f.calls.length, 1);
  s.dispose();
  assert.equal((await s.save()).code, 'disposed');
  assert.equal((await s.retry()).code, 'disposed');
  assert.equal((await s.flushLocal()).code, 'disposed');
});

test('invalid scheduler delays fail early', async t => {
  const f = await fixture(t);
  for (const delay of [-1, NaN, Infinity, 2147483648]) {
    assert.throws(() => core.createAutosaveScheduler(f.c, { debounceMs: delay }), RangeError);
    assert.throws(() => core.createAutosaveScheduler(f.c, { localDebounceMs: delay }), RangeError);
  }
});

test('browser example flushes on pagehide, warns, confirms routes, and holds unknown document outcomes', async t => {
  const { JSDOM } = await import('jsdom');
  const { connectBrowserAutosave, createBrowserAutosaveSession } = await import('../contracts/browser-autosave-example.ts');
  const dom = new JSDOM(''); t.after(() => dom.window.close());
  const f = await fixture(t, { localWritePolicy: 'manual' });
  const session = createBrowserAutosaveSession();
  let connection = connectBrowserAutosave(f.c, dom.window, session); t.after(() => connection.disconnect());
  f.c.update({ title: 'A' }); await settle(); assert.equal(f.writes.length, 0);
  const warning = new dom.window.Event('beforeunload', { cancelable: true });
  dom.window.dispatchEvent(warning); assert.equal(warning.defaultPrevented, true);
  assert.equal(await connection.confirmNavigation(async () => false), false);
  dom.window.dispatchEvent(new dom.window.Event('pagehide')); await settle();
  assert.equal(JSON.parse(f.record().payload).title, 'A');
  assert.equal(await connection.confirmNavigation(async () => true), true);
  const result = await connection.saveDocument(async () => ({ kind: 'unknown', message: 'Lost' }));
  assert.equal(result.kind, 'unknown');
  f.c.update({ title: 'B' }); await f.tick(2000); assert.equal(f.calls.length, 0);
  assert.equal((await connection.saveDocument(async () => assert.fail('unresolved'))).code, 'document_unresolved');
  connection.disconnect();
  connection = connectBrowserAutosave(f.c, dom.window, session);
  await f.tick(2000); assert.equal(f.calls.length, 0);
  connection.documentResolutionComplete(); await f.tick(1000); assert.equal(f.calls.length, 1);
  connection.disconnect();
  const after = new dom.window.Event('beforeunload', { cancelable: true });
  dom.window.dispatchEvent(after); assert.equal(after.defaultPrevented, false);
});

for (const outcome of ['unknown', 'ok']) test(`browser reconnect during external save respects ${outcome} outcome`, async t => {
  const { JSDOM } = await import('jsdom');
  const { connectBrowserAutosave, createBrowserAutosaveSession } = await import('../contracts/browser-autosave-example.ts');
  const dom = new JSDOM(''); t.after(() => dom.window.close());
  const f = await fixture(t);
  const session = createBrowserAutosaveSession();
  const first = connectBrowserAutosave(f.c, dom.window, session);
  f.c.update({ title: 'A' }); let finish;
  const submitting = first.saveDocument(() => new Promise(resolve => { finish = resolve; }));
  await settle(); first.disconnect();
  const second = connectBrowserAutosave(f.c, dom.window, session); t.after(() => second.disconnect());
  finish(outcome === 'unknown' ? { kind: 'unknown', message: 'Lost' } : ok({ id: 'd', version: 'v1' }));
  await submitting; await f.tick(1000);
  assert.equal(f.calls.length, outcome === 'unknown' ? 0 : 1);
  second.disconnect();
  const warning = new dom.window.Event('beforeunload', { cancelable: true });
  dom.window.dispatchEvent(warning); assert.equal(warning.defaultPrevented, false);
});
