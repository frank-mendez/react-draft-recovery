import assert from 'node:assert/strict';
import test from 'node:test';
import * as core from '../src/core.ts';
const ok = value => ({ kind: 'ok', value });
const scope = { userId: 'alice', documentId: 'doc', editorId: 'old' };
const codec = { version: 1, encode: value => ok(JSON.stringify(value)), decode: payload => ok(JSON.parse(payload)) };
const record = (s = scope, payload = '"draft"') => ({ formatVersion: 1, scope: s, baseRevision: 'r1', dataVersion: 1, payload, savedAt: '2026-10-28T00:00:00.000Z' });
function fixture() {
  const data = new Map();
  const backing = { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const storage = core.createLocalStorageAdapter({ getStorage: () => backing });
  let user = 'alice';
  const open = (options = {}) => core.createRecoveryDiscovery({ userId: user, getUserId: () => user, adapter: storage.discovery, codec, ...options });
  return { backing, storage, open, setUser: value => { user = value; } };
}

test('new editor discovers independent writers without changing active input', async () => {
  assert.equal(typeof core.createRecoveryDiscovery, 'function');
  const f = fixture();
  const first = (await core.createLocalRecovery({ scope, initialValue: 'initial', storage: f.storage, codec })).value;
  first.update('saved'); await first.persist(); first.dispose();
  const secondScope = { ...scope, editorId: 'second' };
  await f.storage.write(secondScope, record(secondScope, '"second"'));
  const active = (await core.createLocalRecovery({ scope: { ...scope, editorId: 'new' }, initialValue: 'typed', storage: f.storage, codec })).value;
  const discovery = f.open({ documentId: 'doc' });
  const candidates = (await discovery.refresh()).value;
  assert.equal(candidates.length, 2);
  assert.deepEqual((await discovery.refresh()).value.map(c => c.id), candidates.map(c => c.id));
  assert.equal(active.getSnapshot().value, 'typed');
  const selected = candidates.find(c => c.record.scope.editorId === 'old');
  const restored = await discovery.restore(selected.id, selected.revision);
  assert.equal(restored.value.value, 'saved');
  assert.equal(restored.value.record.baseRevision, null);
  active.update(restored.value.value);
  assert.equal(active.getSnapshot().value, 'saved');
  assert.equal((await discovery.discard(selected.id, selected.revision)).kind, 'ok');
  assert.equal((await f.storage.read(secondScope)).value.payload, '"second"');
  active.dispose();
});

test('unfinished list filters users and malformed records, and supports document filtering', async () => {
  const f = fixture();
  for (const s of [scope, { ...scope, documentId: 'other' }, { ...scope, userId: 'bob' }]) await f.storage.write(s, record(s));
  f.backing.setItem(core.storageKey({ ...scope, editorId: 'bad' }), '{');
  f.backing.setItem(core.storageKey({ ...scope, editorId: 'spoof' }), JSON.stringify(record({ ...scope, userId: 'bob' })));
  await f.storage.write({ ...scope, editorId: 'bad-payload' }, record({ ...scope, editorId: 'bad-payload' }, '{'));
  assert.deepEqual((await f.open().refresh()).value.map(c => c.record.scope.documentId).sort(), ['doc', 'other']);
  assert.equal((await f.open({ documentId: 'doc' }).refresh()).value.length, 1);
});

test('restore and discard refuse candidates updated since discovery', async () => {
  const f = fixture(); await f.storage.write(scope, record());
  const d = f.open(); const [candidate] = (await d.refresh()).value;
  await f.storage.write(scope, record(scope, '"newer"'));
  assert.equal((await d.restore(candidate.id, candidate.revision)).code, 'candidate_changed');
  assert.equal((await d.discard(candidate.id, candidate.revision)).code, 'candidate_changed');
  assert.equal((await f.storage.read(scope)).value.payload, '"newer"');
  const [updated] = (await d.refresh()).value;
  assert.equal(updated.id, candidate.id);
  assert.equal((await d.discard(updated.id, updated.revision)).kind, 'ok');
});

test('account changes and disposal invalidate candidates and in-flight discovery', async () => {
  const f = fixture(); await f.storage.write(scope, record());
  const d = f.open(); const [candidate] = (await d.refresh()).value;
  f.setUser('bob');
  assert.equal((await d.restore(candidate.id, candidate.revision)).code, 'account_changed');
  assert.equal((await d.discard(candidate.id, candidate.revision)).code, 'account_changed');
  assert.equal((await d.refresh()).code, 'account_changed');
  f.setUser('alice');
  let release;
  const adapter = { ...f.storage.discovery, list: query => new Promise(resolve => { release = async () => resolve(await f.storage.discovery.list(query)); }) };
  const delayed = f.open({ adapter }); const pending = delayed.refresh(); delayed.dispose(); await release();
  assert.equal((await pending).code, 'disposed');
  assert.notEqual((await f.storage.read(scope)).value, null);
});

test('legacy import persists current codec format before explicit source cleanup', async () => {
  const f = fixture();
  let legacy = JSON.stringify({ version: 1, title: 'legacy' });
  const adapter = {
    async list() { return ok(legacy === null ? [] : [{ id: 'post-recovery:v1:doc', revision: legacy, record: record(scope, JSON.stringify(JSON.parse(legacy).title)) }]); },
    async read(query, id) { return ok((await this.list(query)).value.find(c => c.id === id) ?? null); },
    async remove(query, id, revision) { if (legacy !== revision) return { kind: 'permanent', code: 'candidate_changed', message: 'Changed' }; legacy = null; return ok(); },
  };
  const d = f.open({ adapter }); const [candidate] = (await d.refresh()).value;
  const target = { ...scope, editorId: 'imported' };
  const unavailable = { writeIfAbsent: async () => ({ kind: 'retryable', code: 'storage_quota', message: 'Full' }) };
  assert.equal((await d.importCandidate(candidate.id, target, unavailable, candidate.revision)).code, 'storage_quota');
  assert.notEqual(legacy, null);
  assert.equal((await d.importCandidate(candidate.id, target, f.storage.discovery, candidate.revision)).kind, 'ok');
  assert.equal((await f.storage.read(target)).value.payload, '"legacy"');
  assert.notEqual(legacy, null);
  assert.equal((await d.importCandidate(candidate.id, target, f.storage.discovery, candidate.revision)).code, 'destination_exists');
  assert.equal((await d.discard(candidate.id, candidate.revision)).kind, 'ok'); assert.equal(legacy, null);
});

test('account change while listing or reading never returns the previous account data', async () => {
  for (const operation of ['list', 'read']) {
    const f = fixture(); await f.storage.write(scope, record());
    let release;
    const adapter = { ...f.storage.discovery };
    const d = f.open({ adapter });
    const [candidate] = (await d.refresh()).value;
    adapter[operation] = (...args) => new Promise(resolve => { release = async () => resolve(await f.storage.discovery[operation](...args)); });
    const pending = operation === 'list' ? d.refresh() : d.restore(candidate.id, candidate.revision);
    f.setUser('bob'); await release();
    assert.equal((await pending).code, 'account_changed');
    f.setUser('alice');
    assert.equal((await d.restore(candidate.id, candidate.revision)).code, 'account_changed');
  }
});

test('conditional cleanup catches updates made after discard dispatch', async () => {
  const f = fixture(); await f.storage.write(scope, record());
  let release;
  const adapter = { ...f.storage.discovery, remove: (...args) => new Promise(resolve => {
    release = async () => resolve(await f.storage.discovery.remove(...args));
  }) };
  const d = f.open({ adapter }); const [candidate] = (await d.refresh()).value;
  const pending = d.discard(candidate.id, candidate.revision);
  await f.storage.write(scope, record(scope, '"during cleanup"'));
  await release();
  assert.equal((await pending).code, 'candidate_changed');
  assert.equal((await f.storage.read(scope)).value.payload, '"during cleanup"');
});

test('consumer adapters cannot expose out-of-scope, invalid or ambiguous candidates', async () => {
  const f = fixture();
  const valid = { id: 'valid', revision: 'v1', record: record() };
  const entries = [valid, { ...valid, id: 'bob', record: record({ ...scope, userId: 'bob' }) },
    { ...valid, id: 'other-doc', record: record({ ...scope, documentId: 'other' }) },
    { ...valid, id: 'invalid', record: { ...record(), formatVersion: 2 } },
    { ...valid, id: 'duplicate' }, { ...valid, id: 'duplicate' }, { ...valid, id: 'null', record: null }];
  const adapter = { ...f.storage.discovery, list: async () => ok(entries), read: async () => ok({ ...valid, record: record({ ...scope, userId: 'bob' }) }) };
  const d = f.open({ adapter, documentId: 'doc' });
  assert.deepEqual((await d.refresh()).value.map(c => c.id), ['valid']);
  assert.equal((await d.restore('valid', 'v1')).code, 'unauthorized_candidate');
  assert.equal((await d.discard('bob')).code, 'unknown_candidate');
  assert.equal((await f.storage.discovery.remove({ userId: 'bob' }, core.storageKey(scope), 'anything')).code, 'unauthorized_candidate');
});

test('failed and superseded listings do not replace the latest candidate selection', async () => {
  const f = fixture(); await f.storage.write(scope, record());
  let release;
  const adapter = { ...f.storage.discovery };
  const d = f.open({ adapter });
  adapter.list = query => new Promise(resolve => { release = async () => resolve(await f.storage.discovery.list(query)); });
  const slow = d.refresh();
  adapter.list = f.storage.discovery.list;
  const [candidate] = (await d.refresh()).value;
  await release(); assert.equal((await slow).code, 'discovery_superseded');
  adapter.list = async () => { throw new Error('unavailable'); };
  assert.equal((await d.refresh()).code, 'discovery_unavailable');
  assert.equal((await d.restore(candidate.id, candidate.revision)).value.value, 'draft');
});

test('import upgrades data versions, rejects other scopes, and retains originals after quota failure', async () => {
  const f = fixture(); await f.storage.write(scope, record());
  const codecV2 = { version: 2, decode: (payload, version) => ok(version === 1 ? { title: JSON.parse(payload) } : JSON.parse(payload)), encode: value => ok(JSON.stringify(value)) };
  const d = f.open({ codec: codecV2 }); const [candidate] = (await d.refresh()).value;
  assert.equal((await d.importCandidate(candidate.id, { ...scope, userId: 'bob' }, f.storage.discovery, candidate.revision)).code, 'unauthorized_candidate');
  assert.equal((await d.importCandidate(candidate.id, { ...scope, documentId: 'other' }, f.storage.discovery, candidate.revision)).code, 'unauthorized_candidate');
  const target = { ...scope, editorId: 'imported' };
  const setItem = f.backing.setItem;
  f.backing.setItem = () => { const error = new Error('full'); error.name = 'QuotaExceededError'; throw error; };
  assert.equal((await d.importCandidate(candidate.id, target, f.storage.discovery, candidate.revision)).code, 'storage_quota');
  assert.notEqual((await f.storage.read(scope)).value, null);
  f.backing.setItem = setItem;
  assert.equal((await d.importCandidate(candidate.id, target, f.storage.discovery, candidate.revision)).kind, 'ok');
  const imported = (await f.storage.read(target)).value;
  assert.equal(imported.dataVersion, 2);
  assert.deepEqual(JSON.parse(imported.payload), { title: 'draft' });
  assert.equal(imported.baseRevision, 'r1');
  const active = (await core.createLocalRecovery({ scope: target, initialValue: { title: 'active' }, storage: f.storage, codec: codecV2 })).value;
  assert.equal(active.getSnapshot().value.title, 'active');
  active.restore(); assert.equal(active.getSnapshot().value.title, 'draft');
  assert.equal(active.getSnapshot().baseRevision, 'r1'); active.dispose();
});

test('background refresh cannot retarget cleanup after an older import', async () => {
  const f = fixture(); await f.storage.write(scope, record(scope, '"v1"'));
  const d = f.open(); const [selected] = (await d.refresh()).value;
  let release;
  const target = { ...scope, editorId: 'imported' };
  const destination = { writeIfAbsent: (...args) => new Promise(resolve => {
    release = async () => resolve(await f.storage.discovery.writeIfAbsent(...args));
  }) };
  // The revision argument must pin this action to the displayed snapshot.
  const importing = d.importCandidate(selected.id, target, destination, selected.revision);
  await new Promise(resolve => setImmediate(resolve));
  await f.storage.write(scope, record(scope, '"v2"'));
  await d.refresh();
  await release(); assert.equal((await importing).kind, 'ok');
  assert.equal((await d.discard(selected.id, selected.revision)).code, 'candidate_changed');
  assert.equal((await d.restore(selected.id, selected.revision)).code, 'candidate_changed');
  assert.equal((await f.storage.read(scope)).value.payload, '"v2"');
  assert.equal((await f.storage.read(target)).value.payload, '"v1"');
});

test('import renews retention so an old source remains recoverable after cleanup', async () => {
  const f = fixture(); const now = Date.parse('2026-10-28T00:00:00.000Z');
  await f.storage.write(scope, { ...record(), savedAt: '2026-01-01T00:00:00.000Z' });
  const d = f.open({ now: () => now }); const [candidate] = (await d.refresh()).value;
  const target = { ...scope, editorId: 'imported' };
  assert.equal((await d.importCandidate(candidate.id, target, f.storage.discovery, candidate.revision)).kind, 'ok');
  assert.equal((await d.discard(candidate.id, candidate.revision)).kind, 'ok');
  const local = (await core.createLocalRecovery({ scope: target, initialValue: '', storage: f.storage, codec, maxAgeMs: 7 * 86400000, now: () => now })).value;
  assert.equal(local.getSnapshot().candidate.kind, 'available');
  local.restore(); assert.equal(local.getSnapshot().value, 'draft');
  assert.equal((await f.storage.read(target)).value.savedAt, new Date(now).toISOString()); local.dispose();
});

test('excluded active writer cannot be listed, read or discarded', async () => {
  const f = fixture(); const active = { ...scope, editorId: 'active' };
  await f.storage.write(scope, record()); await f.storage.write(active, record(active));
  const query = { userId: 'alice', documentId: 'doc', excludeEditorId: 'active' };
  assert.equal((await f.storage.discovery.list(query)).value.length, 1);
  assert.equal((await f.storage.discovery.read(query, core.storageKey(active))).value, null);
  const revision = f.backing.getItem(core.storageKey(active));
  assert.equal((await f.storage.discovery.remove(query, core.storageKey(active), revision)).code, 'unauthorized_candidate');
  // Core also enforces the exclusion for consumer adapters that ignore it.
  const adapter = { ...f.storage.discovery, list: () => f.storage.discovery.list({ userId: 'alice' }) };
  const d = f.open({ adapter, excludeEditorId: 'active' });
  assert.deepEqual((await d.refresh()).value.map(c => c.record.scope.editorId), ['old']);
  assert.equal((await d.discard(core.storageKey(active), revision)).code, 'unknown_candidate');
  assert.notEqual((await f.storage.read(active)).value, null);
});

test('duplicate IDs are rejected even when either entry fails decoding', async () => {
  for (const reverse of [false, true]) {
    const f = fixture(); const valid = { id: 'duplicate', revision: '1', record: record() };
    const entries = [valid, { ...valid, revision: '2', record: null }];
    if (reverse) entries.reverse();
    const d = f.open({ adapter: { ...f.storage.discovery, list: async () => ok(entries) } });
    assert.deepEqual((await d.refresh()).value, []);
    assert.equal((await d.discard(valid.id, valid.revision)).code, 'unknown_candidate');
  }
});
