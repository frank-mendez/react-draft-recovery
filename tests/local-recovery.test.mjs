import assert from 'node:assert/strict';
import test from 'node:test';

import { createLocalStorageAdapter, createLocalRecovery, storageKey } from '../src/local-recovery.ts';
const scope = { userId: 'alice', documentId: 'doc', editorId: 'editor' };
const now = Date.parse('2026-10-27T00:00:00.000Z');
const ok = value => ({ kind: 'ok', value });
const codec = {
  version: 2,
  encode: value => ok(JSON.stringify(value)),
  decode(payload, version) {
    const value = JSON.parse(payload);
    if (version === 1 && typeof value === 'string') return ok({ title: value });
    if (version === 2 && value && typeof value.title === 'string') return ok(value);
    return { kind: 'permanent', code: 'invalid_data', message: 'Invalid data' };
  },
};
const record = (overrides = {}) => ({ formatVersion: 1, scope, baseRevision: null,
  dataVersion: 2, payload: '{"title":"Recovered"}', savedAt: new Date(now).toISOString(), ...overrides });
function memory() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value),
    removeItem: key => data.delete(key) };
}
function fixture(raw = null, options = {}) {
  const backing = memory();
  const events = new EventTarget();
  const storage = createLocalStorageAdapter({ getStorage: () => backing, events });
  if (raw !== null) backing.setItem(storageKey(scope), typeof raw === 'string' ? raw : JSON.stringify(raw));
  const open = extra => createLocalRecovery({ scope, initialValue: { title: 'Active' }, storage, codec,
    now: () => now, ...options, ...extra });
  const event = (key = storageKey(scope), storageArea = backing) => {
    const e = new Event('storage');
    Object.assign(e, { key, storageArea });
    events.dispatchEvent(e);
  };
  return { backing, storage, open, event };
}
async function session(f, extra) { const result = await f.open(extra); assert.equal(result.kind, 'ok'); return result.value; }
const tick = () => new Promise(resolve => setImmediate(resolve));

test('scope encoding isolates separators, Unicode, users, documents and editors', async () => {
  const f = fixture();
  const scopes = [scope, { ...scope, userId: 'bob' }, { ...scope, documentId: 'other' },
    { ...scope, editorId: 'other' }, { userId: 'a:b', documentId: 'c', editorId: '💾' },
    { userId: 'a', documentId: 'b:c', editorId: '💾' }];
  for (let i = 0; i < scopes.length; i++) assert.equal((await f.storage.write(scopes[i], record({ scope: scopes[i], payload: String(i) }))).kind, 'ok');
  for (let i = 0; i < scopes.length; i++) assert.equal((await f.storage.read(scopes[i])).value.payload, String(i));
});
test('discovery and migration preserve active input until explicit restore', async () => {
  const f = fixture(record({ dataVersion: 1, payload: '"Old schema"' }));
  const s = await session(f);
  assert.deepEqual(s.getSnapshot().value, { title: 'Active' });
  assert.deepEqual(s.getSnapshot().candidate, { kind: 'available', value: { title: 'Old schema' } });
  assert.equal((await s.persist()).code, 'recovery_pending');
  s.update({ title: 'Typed meanwhile' });
  assert.equal(s.restore().kind, 'ok');
  assert.deepEqual(s.getSnapshot().value, { title: 'Old schema' });
  assert.equal((await s.persist()).kind, 'ok');
  const saved = (await f.storage.read(scope)).value;
  assert.equal(saved.dataVersion, 2);
  assert.equal(saved.payload, '{"title":"Old schema"}');
});
test('missing drafts and nullable values are distinct', async () => {
  const f = fixture(); const s = await session(f);
  assert.deepEqual(s.getSnapshot().candidate, { kind: 'none' });
  assert.equal(s.restore().kind, 'ok');
  const nullable = { version: 1, encode: () => ok('null'), decode: () => ok(null) };
  await f.storage.write(scope, record({ dataVersion: 1, payload: 'null' }));
  const n = await session(f, { codec: nullable });
  assert.deepEqual(n.getSnapshot().candidate, { kind: 'available', value: null });
  n.restore(); assert.equal(n.getSnapshot().value, null);
});
test('invalid envelopes and corrupt payloads remain stored and never replace input', async () => {
  for (const raw of ['{', 'null', '[]', record({ formatVersion: 9 }), record({ scope: { ...scope, userId: 'bob' } }),
    record({ baseRevision: '' }), record({ dataVersion: 1.5 }), record({ dataVersion: -1 }),
    record({ payload: 4 }), record({ savedAt: 'yesterday' }), record({ payload: '{' }),
    record({ dataVersion: 99 })]) {
    const f = fixture(raw); const original = f.backing.getItem(storageKey(scope)); const s = await session(f);
    assert.equal(s.getSnapshot().candidate.kind, 'none');
    assert.ok(s.getSnapshot().error);
    assert.deepEqual(s.getSnapshot().value, { title: 'Active' });
    assert.equal((await s.persist()).code, 'recovery_pending');
    assert.equal(f.backing.getItem(storageKey(scope)), original);
    assert.equal((await s.discard()).kind, 'ok');
    assert.equal(f.backing.getItem(storageKey(scope)), null);
    assert.deepEqual(s.getSnapshot().value, { title: 'Active' });
  }
});
test('expiration is opt-in and boundary-expired drafts require explicit discard', async () => {
  const f = fixture(record({ savedAt: new Date(now - 1000).toISOString() }));
  assert.equal((await session(f)).getSnapshot().candidate.kind, 'available');
  const s = await session(f, { maxAgeMs: 1000 });
  assert.equal(s.getSnapshot().error.code, 'expired');
  assert.equal(s.getSnapshot().candidate.kind, 'none');
  assert.notEqual(f.backing.getItem(storageKey(scope)), null);
  const future = fixture(record({ savedAt: new Date(now + 1).toISOString() }));
  assert.equal((await session(future, { maxAgeMs: 1000 })).getSnapshot().error.code, 'invalid_timestamp');
});
test('unavailable storage is observable and creation still preserves input', async () => {
  const storage = createLocalStorageAdapter({ getStorage() { throw new DOMException('denied', 'SecurityError'); } });
  const result = await createLocalRecovery({ scope, storage, codec, initialValue: { title: 'Active' } });
  assert.equal(result.kind, 'ok');
  assert.equal(result.value.getSnapshot().error.code, 'storage_unavailable');
  assert.deepEqual(result.value.getSnapshot().value, { title: 'Active' });
});
test('quota and serialization failures retain the previous draft and support retry', async () => {
  const f = fixture(); const s = await session(f);
  s.update({ title: 'First' }); assert.equal((await s.persist()).kind, 'ok');
  const original = f.backing.getItem(storageKey(scope));
  const set = f.backing.setItem;
  f.backing.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  s.update({ title: 'Second' });
  assert.equal((await s.persist()).code, 'storage_quota');
  assert.equal(s.getSnapshot().dirty, true);
  assert.equal(f.backing.getItem(storageKey(scope)), original);
  f.backing.setItem = set;
  assert.equal((await s.persist()).kind, 'ok');
  const circular = {}; circular.self = circular;
  s.update(circular);
  assert.equal((await s.persist()).code, 'serialization_failed');
  assert.equal((await f.storage.read(scope)).value.payload, '{"title":"Second"}');
});
test('account cleanup removes every owned scope including corrupt data but preserves other accounts and keys', async () => {
  const f = fixture('{');
  const other = { ...scope, editorId: 'second' }; const bob = { ...scope, userId: 'bob' };
  await f.storage.write(other, record({ scope: other })); await f.storage.write(bob, record({ scope: bob }));
  f.backing.setItem('unrelated', 'keep');
  const s = await session(f);
  assert.equal((await s.logout()).kind, 'ok');
  assert.equal((await f.storage.read(scope)).value, null);
  assert.equal((await f.storage.read(other)).value, null);
  assert.notEqual((await f.storage.read(bob)).value, null);
  assert.equal(f.backing.getItem('unrelated'), 'keep');
  assert.equal((await s.persist()).code, 'disposed');
  const next = await session(f, { scope: bob });
  assert.equal(next.getSnapshot().candidate.kind, 'available');
});
test('competing tab changes notify without overwriting input and block unnoticed replacement', async () => {
  const f = fixture(); const a = await session(f); const b = await session(f);
  let changes = 0; a.subscribe(() => changes++);
  a.update({ title: 'Unsent A' }); b.update({ title: 'B' }); await b.persist();
  await tick();
  assert.deepEqual(a.getSnapshot().value, { title: 'Unsent A' });
  assert.equal(a.getSnapshot().externalChange, true);
  assert.deepEqual(a.getSnapshot().candidate, { kind: 'available', value: { title: 'B' } });
  assert.equal((await a.persist()).code, 'recovery_pending');
  assert.ok(changes > 1);
  a.restore(); assert.deepEqual(a.getSnapshot().value, { title: 'B' });
  assert.equal(a.getSnapshot().externalChange, false);
});
test('browser storage events filter unrelated scopes and areas, including clear events', async () => {
  const f = fixture(); const s = await session(f);
  f.event(storageKey({ ...scope, userId: 'bob' })); f.event(storageKey(scope), memory()); await tick();
  assert.equal(s.getSnapshot().externalChange, false);
  f.backing.setItem(storageKey(scope), JSON.stringify(record())); f.event(); await tick();
  assert.equal(s.getSnapshot().candidate.kind, 'available');
  assert.deepEqual(s.getSnapshot().value, { title: 'Active' });
  f.backing.removeItem(storageKey(scope)); f.event(null); await tick();
  assert.equal(s.getSnapshot().candidate.kind, 'none');
  assert.equal(s.getSnapshot().externalChange, true);
  await s.discard(); assert.equal(s.getSnapshot().externalChange, false);
});
test('disposal unsubscribes and late discovery cannot notify or mutate state', async () => {
  const f = fixture(); const s = await session(f); let calls = 0;
  s.subscribe(() => calls++); const before = s.getSnapshot(); s.dispose();
  f.backing.setItem(storageKey(scope), JSON.stringify(record())); f.event(); await tick();
  assert.equal(calls, 0); assert.equal(s.getSnapshot(), before);
  assert.throws(() => s.update({ title: 'late' }), /disposed/);
  assert.equal(s.restore().code, 'disposed');
});
test('invalid options fail before storage access', async () => {
  const f = fixture();
  for (const options of [{ maxAgeMs: -1 }, { maxAgeMs: Infinity }, { scope: { ...scope, userId: 1 } }, { codec: { ...codec, version: -1 } }]) {
    assert.equal((await f.open(options)).code, 'invalid_options');
  }
});

function deferred() { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; }
test('persist freezes a detached value at dispatch and preserves later dirty edits', async () => {
  const f = fixture(); const gate = deferred(); const entered = deferred();
  const storage = { ...f.storage, async write(scope, record, origin) { entered.resolve(); await gate.promise; return f.storage.write(scope, record, origin); } };
  const s = await session(f, { storage });
  const value = { title: 'First' }; s.update(value);
  const saving = s.persist();
  value.title = 'Mutated after dispatch'; s.update({ title: 'Second' });
  await entered.promise;
  assert.equal((await s.persist()).code, 'operation_in_progress');
  gate.resolve(); assert.equal((await saving).kind, 'ok');
  assert.equal((await f.storage.read(scope)).value.payload, '{"title":"First"}');
  assert.deepEqual(s.getSnapshot().value, { title: 'Second' }); assert.equal(s.getSnapshot().dirty, true);
});
test('logout drains an in-flight write before cleanup, and late completion cannot update the session', async () => {
  const f = fixture(); const gate = deferred(); const entered = deferred();
  const storage = { ...f.storage, async write(scope, record, origin) { entered.resolve(); await gate.promise; return f.storage.write(scope, record, origin); } };
  const s = await session(f, { storage }); s.update({ title: 'Pending' });
  const saving = s.persist(); await entered.promise;
  const before = s.getSnapshot(); const leaving = s.logout();
  gate.resolve(); assert.equal((await saving).code, 'disposed'); assert.equal((await leaving).kind, 'ok');
  assert.equal((await f.storage.read(scope)).value, null); assert.equal(s.getSnapshot(), before);
});
test('failed account cleanup can be retried after disposal', async () => {
  const f = fixture(record()); const s = await session(f); const remove = f.backing.removeItem;
  f.backing.removeItem = () => { throw new Error('denied'); };
  assert.equal((await s.logout()).code, 'storage_unavailable');
  assert.notEqual(f.backing.getItem(storageKey(scope)), null);
  f.backing.removeItem = remove;
  assert.equal((await s.logout()).kind, 'ok'); assert.equal(f.backing.getItem(storageKey(scope)), null);
});
test('clearing an account stops sibling sessions before they can recreate its drafts', async () => {
  const f = fixture(); const a = await session(f); const b = await session(f);
  await a.logout(); assert.equal((await b.persist()).code, 'disposed');
  assert.throws(() => b.update({ title: 'Old account' }), /disposed/);
});
test('late reads cannot restore a candidate discarded while discovery was pending', async () => {
  const f = fixture(record()); const s = await session(f); const read = f.storage.read; const gate = deferred();
  f.storage.read = () => gate.promise;
  const refreshing = s.refresh(); await s.discard();
  gate.resolve(ok(record())); await refreshing;
  assert.deepEqual(s.getSnapshot().candidate, { kind: 'none' });
  f.storage.read = read; assert.equal((await f.storage.read(scope)).value, null);
});
test('a failed discard preserves the candidate and active input', async () => {
  const f = fixture(record()); const s = await session(f);
  f.backing.removeItem = () => { throw new Error('denied'); };
  assert.equal((await s.discard()).code, 'storage_unavailable');
  assert.equal(s.getSnapshot().candidate.kind, 'available');
  assert.deepEqual(s.getSnapshot().value, { title: 'Active' });
});
test('codec failures and unexpected storage rejections remain visible', async () => {
  const f = fixture(); const denied = { kind: 'permanent', code: 'invalid_data', message: 'Rejected' };
  const s = await session(f, { codec: { ...codec, encode: () => denied } });
  assert.deepEqual(await s.persist(), denied); assert.deepEqual(s.getSnapshot().error, denied);
  const throwing = await session(f, { storage: { ...f.storage, write: async () => { throw new Error('private details'); } } });
  assert.equal((await throwing.persist()).code, 'storage_unavailable');
  assert.equal(throwing.getSnapshot().error.message.includes('private details'), false);
});
test('server import and default adapter access fail gracefully without a browser', async () => {
  const storage = createLocalStorageAdapter({ getStorage: () => undefined });
  assert.equal((await storage.read(scope)).code, 'storage_unavailable');
});
test('notification failures cannot turn a committed write into failure', async () => {
  const f = fixture(); f.storage.subscribe(scope, () => { throw new Error('observer'); });
  assert.equal((await f.storage.write(scope, record())).kind, 'ok');
  assert.equal((await f.storage.read(scope)).value.payload, '{"title":"Recovered"}');
});
test('invalid clock and subscription failures remain visible instead of rejecting creation', async () => {
  const f = fixture(record());
  const result = await f.open({ now: () => { throw new Error('clock'); }, maxAgeMs: 1000 });
  assert.equal(result.kind, 'ok'); assert.equal(result.value.getSnapshot().error.code, 'invalid_timestamp');
  const s = await session(f, { storage: { ...f.storage, subscribe() { throw new Error('events'); } } });
  assert.equal(s.getSnapshot().error.code, 'notifications_unavailable');
});

test('a stale candidate cannot be restored while a refresh is validating a replacement', async () => {
  const f = fixture(record()); const s = await session(f); const gate = deferred();
  f.storage.read = () => gate.promise;
  const refreshing = s.refresh();
  assert.equal(s.restore().code, 'operation_in_progress');
  gate.resolve(ok(record({ payload: '{"title":"Newer"}' }))); await refreshing;
  assert.equal(s.restore().kind, 'ok'); assert.deepEqual(s.getSnapshot().value, { title: 'Newer' });
});
test('a write failure remains visible when a competing read completes during that write', async () => {
  const f = fixture(); const gate = deferred();
  const storage = { ...f.storage, write: () => gate.promise };
  const s = await session(f, { storage });
  s.update({ title: 'Own' }); const saving = s.persist();
  f.backing.setItem(storageKey(scope), JSON.stringify(record())); f.event(); await tick();
  const error = { kind: 'permanent', code: 'storage_quota', message: 'Full' };
  gate.resolve(error); assert.deepEqual(await saving, error);
  assert.deepEqual(s.getSnapshot().error, error);
  assert.equal(s.getSnapshot().candidate.kind, 'available');
  assert.deepEqual(s.getSnapshot().value, { title: 'Own' });
});

test('successful discard reconciles discovery that ran before an asynchronous removal completed', async () => {
  const f = fixture(record()); const gate = deferred();
  const storage = { ...f.storage, async remove(scope, origin) { await gate.promise; return f.storage.remove(scope, origin); } };
  const s = await session(f, { storage });
  const removing = s.discard();
  f.event(); await tick(); // An external notification reads the record before deletion.
  gate.resolve(); assert.equal((await removing).kind, 'ok');
  assert.equal((await f.storage.read(scope)).value, null);
  assert.equal(s.getSnapshot().candidate.kind, 'none');
  assert.equal(s.getSnapshot().externalChange, false);
  assert.equal((await s.persist()).kind, 'ok');
});
