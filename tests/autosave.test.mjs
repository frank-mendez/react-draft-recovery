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

for (const candidate of [false, true]) test(`navigation allows unchanged input with ${candidate ? 'pending candidate' : 'unavailable storage'}`, async t => {
  const { JSDOM } = await import('jsdom');
  const { connectBrowserAutosave, createBrowserAutosaveSession } = await import('../contracts/browser-autosave-example.ts');
  const dom = new JSDOM(''); t.after(() => dom.window.close());
  let writes = 0;
  const storage = {
    async read() { return ok(candidate ? { formatVersion: 1, scope: { userId: 'u', documentId: 'd', editorId: 'e' },
      baseRevision: 'r0', dataVersion: 1, payload: JSON.stringify({ title: 'Prior draft' }), savedAt: new Date().toISOString() } : null); },
    async write() { writes++; return { kind: 'permanent', code: 'quota_exceeded', message: 'Full' }; },
    async remove() { assert.fail('must preserve candidate'); },
  };
  const f = await fixture(t, { storage });
  const connection = connectBrowserAutosave(f.c, dom.window, createBrowserAutosaveSession()); t.after(() => connection.disconnect());
  let confirmations = 0;
  if (candidate) assert.equal(await connection.confirmNavigation(async () => false), false);
  assert.equal(await connection.confirmNavigation(async () => { confirmations++; return true; }), true);
  assert.equal(confirmations, candidate ? 1 : 0); assert.equal(writes, 0);
  // A candidate does not prove newly typed input is durable.
  f.c.update({ title: 'New unsaved input' }); await settle();
  assert.equal(await connection.confirmNavigation(async () => true), false);
});

for (const kind of ['absent', 'present']) test(`input before ${kind} remote discovery exposes reconciliation and resumes after resolution`, async t => {
  let finishLoad;
  const calls = [];
  const remote = {
    replayWindowMs: 10000,
    load: () => new Promise(resolve => { finishLoad = resolve; }),
    async save(request) { calls.push(request); return ok({ kind: 'present', revision: 'r2', value: request.value }); },
    async discard() { assert.fail('no discard'); },
  };
  const f = await fixture(t, { remote });
  const results = [];
  const scheduler = core.createAutosaveScheduler(f.c, { debounceMs: 100, onResult: (_action, result) => results.push(result) });
  t.after(() => scheduler.dispose());
  f.c.update({ title: 'Early input' });
  const snapshot = kind === 'absent' ? { kind, revision: 'r1' } : { kind, revision: 'r1', value: { title: 'Other input' } };
  finishLoad(ok(snapshot)); await settle();
  assert.equal(f.c.getSnapshot().status, 'error');
  assert.equal(f.c.getSnapshot().error.code, 'reconciliation_required');
  f.c.update({ title: 'More input' }); await f.tick(1000);
  assert.equal(calls.length, 0); assert.equal(results.length, 0);
  assert.equal(f.c.reconcile(snapshot, f.c.getSnapshot().value).kind, 'ok');
  await f.tick(100);
  assert.equal(calls.length, 1); assert.equal(calls[0].value.title, 'More input');
  assert.equal(calls[0].expectedRevision, 'r1');
});

test('remote validation rejection survives unrelated local notifications; explicit save revalidates', async t => {
  const f = await fixture(t); let validations = 0;
  const s = core.createAutosaveScheduler(f.c, { debounceMs: 100, validateRemote: value => {
    validations++;
    return value.title === 'large' ? { kind: 'permanent', code: 'payload_too_large', message: 'Large' } : null;
  } }); t.after(() => s.dispose());
  f.c.update({ title: 'large' }); await f.tick(100); assert.equal(validations, 1);
  await s.flushLocal(); await f.tick(1000); assert.equal(validations, 1);
  assert.equal((await s.save()).code, 'payload_too_large'); assert.equal(validations, 2);
  f.c.update({ title: 'small' }); await f.tick(100); assert.equal(validations, 3); assert.equal(f.calls.length, 1);
});
