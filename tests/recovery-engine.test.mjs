import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecovery } from '../src/recovery-engine.ts';
import { codec } from '../contracts/examples.ts';

const ok = value => ({ kind: 'ok', value });
const absent = revision => ({ kind: 'absent', revision });
const present = (revision, title) => ({ kind: 'present', revision, value: { title } });
const scope = { userId: 'u', documentId: 'd', editorId: 'e' };
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function fixture(overrides = {}) {
  let record = null, clock = 0, id = 0;
  const calls = [];
  const storage = {
    async read() { return ok(record); },
    async write(_scope, value) { record = structuredClone(value); return ok(); },
    async remove() { record = null; return ok(); },
  };
  const remote = {
    replayWindowMs: 10000,
    async load() { return ok(absent('r0')); },
    async save(request) { calls.push(structuredClone(request)); return ok(present('r1', request.value.title)); },
    async discard(request) { calls.push(structuredClone(request)); return ok(absent('r2')); },
  };
  const options = { scope, initialValue: { title: 'Initial' }, codec, storage, remote,
    now: () => clock, createOperationId: () => `op-${++id}`, ...overrides };
  return { options, remote, storage, calls, record: () => record, advance: ms => { clock += ms; },
    async open() { const r = await createRecovery(options); assert.equal(r.kind, 'ok'); return r.value; } };
}
async function ready(f) {
  const c = await f.open();
  if (c.getSnapshot().remote.kind === 'loading') await new Promise(resolve => {
    const unsub = c.subscribe(() => { if (c.getSnapshot().remote.kind !== 'loading') { unsub(); resolve(); } });
  });
  return c;
}

test('creation offers local recovery while remote discovery hangs; late load preserves edits', async () => {
  const f = fixture(); const load = deferred(); f.remote.load = () => load.promise;
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: 'old', dataVersion: 1, payload: '{"title":"Recovered"}', savedAt: '2026-10-27T00:00:00Z' });
  const c = await f.open();
  assert.equal(c.getSnapshot().status, 'loading'); assert.equal(c.getSnapshot().candidate.value.title, 'Recovered');
  c.restore(); c.update({ title: 'Edited' }); await c.persistLocal();
  assert.equal((await c.save()).code, 'remote_not_ready');
  load.resolve(ok(present('r0', 'Server')));
  await new Promise(resolve => { const unsub = c.subscribe(() => { if (c.getSnapshot().remote.kind === 'ready') { unsub(); resolve(); } }); });
  assert.equal(c.getSnapshot().value.title, 'Edited'); assert.equal(c.getSnapshot().dirty, true);
});

test('save A freezes its request; completion never acknowledges newer B or local persistence', async () => {
  const f = fixture(); const gate = deferred(); f.remote.save = r => { f.calls.push(r); return gate.promise; };
  const c = await ready(f); const a = { title: 'A' }; c.update(a); const saving = c.save();
  a.title = 'mutated'; c.update({ title: 'B' }); await c.persistLocal();
  assert.equal(f.calls[0].value.title, 'A'); assert.equal(c.getSnapshot().dirty, true);
  assert.equal((await c.save()).code, 'operation_in_progress');
  assert.equal((await c.discardRemote()).code, 'operation_in_progress');
  gate.resolve(ok(present('r1', 'A'))); await saving;
  assert.equal(c.getSnapshot().value.title, 'B'); assert.equal(c.getSnapshot().dirty, true);
  assert.equal(JSON.parse(f.record().payload).title, 'B');
  f.remote.save = async r => { f.calls.push(r); return ok(present('r2', r.value.title)); };
  await c.save(); assert.equal(c.getSnapshot().dirty, false); assert.equal(f.calls[1].expectedRevision, 'r1');
});

test('unknown results freeze identity through edits and retries and block other mutations', async () => {
  const f = fixture(); let attempt = 0;
  f.remote.save = async r => { f.calls.push(structuredClone(r)); return ++attempt === 1 ? { kind: 'unknown', message: 'Lost response' } : ok(present('r1', 'A')); };
  const c = await ready(f); c.update({ title: 'A' }); await c.save(); c.update({ title: 'B' });
  assert.equal(c.getSnapshot().status, 'unknown');
  for (const action of ['save', 'discardRemote']) assert.equal((await c[action]()).code, 'operation_unresolved');
  assert.equal((await c.reloadRemote()).code, 'operation_in_progress');
  assert.equal((await c.retry()).code, 'retry_not_ready');
  f.advance(250); await c.retry();
  assert.deepEqual(f.calls[1], f.calls[0]); assert.equal(c.getSnapshot().dirty, true);
  assert.equal(c.getSnapshot().value.title, 'B');
});

test('retryable failure honors retryAfterMs and retains local recovery', async () => {
  const f = fixture(); f.remote.save = async r => { f.calls.push(r); return { kind: 'retryable', message: 'Unavailable', retryAfterMs: 2000 }; };
  const c = await ready(f); c.update({ title: 'Offline' }); await c.persistLocal(); await c.save();
  f.advance(1999); assert.equal((await c.retry()).code, 'retry_not_ready');
  f.advance(1); assert.equal((await c.retry()).kind, 'retryable');
  assert.equal(f.calls.length, 2); assert.equal(f.calls[0].operationId, f.calls[1].operationId);
  assert.equal(JSON.parse(f.record().payload).title, 'Offline'); assert.equal(c.getSnapshot().dirty, true);
});

test('expired replay requires explicit reconciliation and a fresh operation ID', async () => {
  const f = fixture(); f.remote.save = async r => { f.calls.push(r); return { kind: 'unknown', message: 'Lost' }; };
  const c = await ready(f); c.update({ title: 'A' }); await c.save();
  assert.equal(c.reconcile(absent('r0'), { title: 'B' }).code, 'invalid_reconciliation_state');
  f.advance(10000); assert.equal((await c.retry()).code, 'replay_window_expired'); assert.equal(f.calls.length, 1);
  assert.equal(c.reconcile(present('r1', 'A'), { title: 'B' }).kind, 'ok');
  await c.save(); assert.equal(f.calls[1].operationId, 'op-2'); assert.equal(f.calls[1].expectedRevision, 'r1');
});

test('conflicts retain input until reconciliation; stale bases can conflict again', async () => {
  const f = fixture(); f.remote.save = async r => { f.calls.push(r); return { kind: 'conflict', current: present('r9', 'Other') }; };
  const c = await ready(f); c.update({ title: 'Mine' }); await c.save();
  assert.equal(c.getSnapshot().status, 'conflict'); assert.equal(c.getSnapshot().value.title, 'Mine');
  assert.equal((await c.save()).code, 'reconciliation_required'); assert.equal((await c.discardRemote()).code, 'reconciliation_required');
  assert.equal((await c.retry()).code, 'no_pending_operation');
  assert.equal(c.reconcile(present('r9', 'Other'), { title: 'Merged' }).kind, 'ok');
  await c.save(); assert.equal(f.calls[1].expectedRevision, 'r9'); assert.equal(c.getSnapshot().status, 'conflict');
});

test('mutation exceptions are unknown, permanent failures permit a fresh save', async () => {
  const f = fixture(); f.remote.save = async () => { throw new Error('private details'); };
  const c = await ready(f); c.update({ title: 'A' }); const result = await c.save();
  assert.equal(result.kind, 'unknown'); assert.equal(result.message.includes('private details'), false);
  f.advance(250); f.remote.save = async () => ({ kind: 'permanent', code: 'forbidden', message: 'Denied' });
  assert.equal((await c.retry()).kind, 'permanent'); assert.equal(c.getSnapshot().status, 'error');
  f.remote.save = async r => ok(present('r1', r.value.title)); await c.save(); assert.equal(c.getSnapshot().dirty, false);
});

test('local errors remain visible after remote success and local persistence can be retried', async () => {
  const f = fixture(); const write = f.storage.write;
  f.storage.write = async () => ({ kind: 'retryable', code: 'storage_quota', message: 'Full' });
  const c = await ready(f); c.update({ title: 'A' }); await c.persistLocal(); await c.save();
  assert.equal(c.getSnapshot().error.code, 'storage_quota'); assert.equal(c.getSnapshot().dirty, false);
  f.storage.write = write; assert.equal((await c.persistLocal()).kind, 'ok'); assert.equal(c.getSnapshot().error, null);
  assert.equal(f.record().baseRevision, 'r1');
});

test('restore during a remote save stays dirty; local discard retains input and remote state', async () => {
  const f = fixture(); const gate = deferred(); f.remote.save = () => gate.promise;
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: null, dataVersion: 1, payload: '{"title":"Recovered"}', savedAt: '2026-10-27T00:00:00Z' });
  const c = await ready(f); const saving = c.save(); c.restore(); await c.persistLocal();
  gate.resolve(ok(present('r1', 'Initial'))); await saving;
  assert.equal(c.getSnapshot().value.title, 'Recovered'); assert.equal(c.getSnapshot().dirty, true);
  const remote = c.getSnapshot().remote; await c.discardLocal();
  assert.equal(f.record(), null); assert.equal(c.getSnapshot().value.title, 'Recovered'); assert.equal(c.getSnapshot().remote, remote);
});

test('remote discard creates a tombstone without clearing input, local recovery or dirty state', async () => {
  const f = fixture(); const c = await ready(f); c.update({ title: 'Keep' }); await c.persistLocal();
  await c.discardRemote(); assert.equal(c.getSnapshot().remote.snapshot.kind, 'absent');
  assert.equal(c.getSnapshot().value.title, 'Keep'); assert.equal(c.getSnapshot().dirty, true); assert.ok(f.record());
  await c.save(); assert.equal(f.calls[1].expectedRevision, 'r2');
});

test('late save after disposal cannot mutate old or new account controllers', async () => {
  const f = fixture(); const gate = deferred(); f.remote.save = () => gate.promise;
  const old = await ready(f); old.update({ title: 'Old' }); await old.persistLocal(); const saving = old.save();
  old.dispose(); const before = old.getSnapshot();
  const next = await ready(fixture({ scope: { ...scope, userId: 'other', documentId: 'other' } })); const current = next.getSnapshot();
  gate.resolve(ok(present('r1', 'Old'))); assert.equal((await saving).code, 'disposed');
  assert.equal(old.getSnapshot(), before); assert.equal(next.getSnapshot(), current);
  for (const action of ['save', 'retry', 'discardRemote', 'discardLocal', 'reloadRemote', 'persistLocal']) assert.equal((await old[action]()).code, 'disposed');
  assert.throws(() => old.update({ title: 'No' })); assert.throws(() => old.restore()); assert.throws(() => old.subscribe(() => {}));
});

test('load failures preserve local editing, and reload establishes a base without overwriting input', async () => {
  const f = fixture(); f.remote.load = async () => { throw new Error('offline'); };
  const c = await ready(f); assert.equal(c.getSnapshot().remote.kind, 'failed'); c.update({ title: 'Edited' }); await c.persistLocal();
  assert.equal((await c.save()).code, 'remote_not_ready'); f.remote.load = async () => ok(present('r3', 'Server'));
  await c.reloadRemote(); assert.equal(c.getSnapshot().value.title, 'Edited'); await c.save(); assert.equal(f.calls[0].expectedRevision, 'r3');
});

test('remote-disabled controllers persist locally and return explicit remote guards', async () => {
  const f = fixture({ remote: undefined }); const c = await f.open(); c.update({ title: 'Local' }); await c.persistLocal();
  assert.equal(JSON.parse(f.record().payload).title, 'Local'); assert.equal(c.getSnapshot().remote.kind, 'disabled');
  for (const action of ['save', 'retry', 'discardRemote', 'reloadRemote']) assert.equal((await c[action]()).code, 'remote_unavailable');
});

function atomicRemote() {
  let current = absent('r0'), revision = 0, writes = 0;
  const results = new Map();
  const apply = (kind, request) => {
    const fingerprint = JSON.stringify({ kind, ...request });
    if (results.has(request.operationId)) {
      const previous = results.get(request.operationId);
      return previous.fingerprint === fingerprint ? previous.result : { kind: 'permanent', code: 'idempotency_mismatch', message: 'Changed request' };
    }
    let result;
    if (request.expectedRevision !== current.revision) result = { kind: 'conflict', current };
    else {
      current = kind === 'save' ? present(`r${++revision}`, request.value.title) : absent(`r${++revision}`);
      writes++; result = ok(current);
    }
    results.set(request.operationId, { fingerprint, result }); return result;
  };
  return { replayWindowMs: 10000, load: async () => ok(current),
    save: async r => apply('save', r), discard: async r => apply('discard', r), current: () => current, writes: () => writes };
}

test('lost success replays once even after another controller advances the revision', async () => {
  const backend = atomicRemote(); const gate = deferred(); let first = true;
  const f = fixture({ remote: { ...backend, async save(request) {
    const result = await backend.save(request);
    if (first) { first = false; await gate.promise; return { kind: 'unknown', message: 'Lost response' }; }
    return result;
  } } });
  const a = await ready(f); a.update({ title: 'A' }); const saving = a.save();
  const b = await ready(fixture({ remote: backend, createOperationId: () => 'other-op' }));
  b.update({ title: 'B' }); await b.save();
  gate.resolve(); await saving; f.advance(250); await a.retry();
  assert.equal(backend.writes(), 2); assert.equal(backend.current().value.title, 'B');
  assert.equal(a.getSnapshot().remote.snapshot.revision, 'r1');
  a.update({ title: 'A2' }); assert.equal((await a.save()).kind, 'conflict');
  assert.equal(backend.current().value.title, 'B');
});

test('delayed save conflicts with a discard tombstone instead of resurrecting a draft', async () => {
  const backend = atomicRemote(); const gate = deferred();
  const a = await ready(fixture({ remote: { ...backend, async save(request) { await gate.promise; return backend.save(request); } } }));
  const b = await ready(fixture({ remote: backend, createOperationId: () => 'delete-op' }));
  a.update({ title: 'Stale' }); const saving = a.save(); await b.discardRemote(); gate.resolve();
  assert.equal((await saving).kind, 'conflict'); assert.equal(backend.current().kind, 'absent');
  assert.equal(a.getSnapshot().value.title, 'Stale'); assert.equal(a.getSnapshot().dirty, true);
});

test('delayed discard conflicts with a newer save and preserves local input', async () => {
  const backend = atomicRemote(); const gate = deferred();
  const a = await ready(fixture({ remote: { ...backend, async discard(request) { await gate.promise; return backend.discard(request); } } }));
  const b = await ready(fixture({ remote: backend, createOperationId: () => 'save-op' }));
  const deleting = a.discardRemote(); b.update({ title: 'New' }); await b.save(); gate.resolve();
  assert.equal((await deleting).kind, 'conflict'); assert.equal(backend.current().value.title, 'New');
});

test('local write queue coalesces pending edits and never clears remote dirty state', async () => {
  const f = fixture(); const gate = deferred(); const write = f.storage.write; const values = []; let first = true;
  f.storage.write = async (...args) => { values.push(JSON.parse(args[1].payload).title); if (first) { first = false; await gate.promise; } return write(...args); };
  const c = await ready(f); c.update({ title: 'A' }); c.update({ title: 'B' }); c.update({ title: 'C' }); const persisted = c.persistLocal();
  gate.resolve(); await persisted;
  assert.deepEqual(values, ['A', 'C']); assert.equal(JSON.parse(f.record().payload).title, 'C'); assert.equal(c.getSnapshot().dirty, true);
});

test('notifications cannot dispatch overlapping mutations or turn success into failure', async () => {
  const f = fixture(); const c = await ready(f); const nested = [];
  c.subscribe(() => { if (c.getSnapshot().status === 'saving') nested.push(c.save()); throw new Error('observer'); });
  c.update({ title: 'A' }); assert.equal((await c.save()).kind, 'ok');
  assert.equal((await nested[0]).code, 'operation_in_progress'); assert.equal(f.calls.length, 1);
});

test('disposing from a saving notification prevents dispatch', async () => {
  const f = fixture(); const c = await ready(f);
  c.subscribe(() => { if (c.getSnapshot().status === 'saving') c.dispose(); });
  assert.equal((await c.save()).code, 'disposed'); assert.equal(f.calls.length, 0);
});

test('late discovery after disposal cannot notify or overwrite a new document', async () => {
  const f = fixture(); const gate = deferred(); f.remote.load = () => gate.promise;
  const c = await f.open(); let notices = 0; c.subscribe(() => notices++); c.dispose(); const before = c.getSnapshot();
  gate.resolve(ok(present('r1', 'Late'))); await gate.promise; await Promise.resolve();
  assert.equal(c.getSnapshot(), before); assert.equal(notices, 0);
});

test('unknown remote discard retries its original kind and never removes local recovery', async () => {
  const f = fixture(); let first = true;
  f.remote.discard = async r => { f.calls.push(structuredClone(r)); if (first) { first = false; throw new Error('timeout'); } return ok(absent('r2')); };
  const c = await ready(f); c.update({ title: 'Keep' }); await c.persistLocal(); await c.discardRemote();
  f.advance(250); await c.retry(); assert.deepEqual(f.calls[0], f.calls[1]);
  assert.equal('value' in f.calls[1], false); assert.ok(f.record()); assert.equal(c.getSnapshot().dirty, true);
});

test('malformed remote successes are unknown rather than acknowledging input', async () => {
  const f = fixture(); f.remote.save = async () => ok(absent('r1'));
  const c = await ready(f); c.update({ title: 'A' }); assert.equal((await c.save()).kind, 'unknown'); assert.equal(c.getSnapshot().dirty, true);
});

test('retry delay grows and stops at the replay safety boundary without dispatch', async () => {
  const f = fixture(); f.remote.replayWindowMs = 1000000;
  f.remote.save = async r => { f.calls.push(r); return { kind: 'unknown', message: 'Lost' }; };
  const c = await ready(f); await c.save();
  for (const delay of [250, 500, 1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    f.advance(delay - 1); assert.equal((await c.retry()).code, 'retry_not_ready');
    f.advance(1); assert.equal((await c.retry()).kind, 'unknown');
  }
  const before = f.calls.length; f.advance(1000000); assert.equal((await c.retry()).code, 'replay_window_expired'); assert.equal(f.calls.length, before);
});

test('invalid dependencies fail creation instead of surfacing as storage runtime errors', async () => {
  for (const bad of [{ storage: {} }, { storage: { read: async () => ok(null) } }, { remote: { replayWindowMs: 0 } }, { now: () => NaN }]) {
    assert.equal((await createRecovery(fixture(bad).options)).code, 'invalid_options');
  }
});

test('scope is captured before asynchronous discovery so caller changes cannot redirect saves', async () => {
  const mutableScope = { ...scope }; const gate = deferred(); const f = fixture({ scope: mutableScope });
  f.storage.read = () => gate.promise; const opening = f.open(); mutableScope.userId = 'other';
  gate.resolve(ok(null)); const c = await opening;
  if (c.getSnapshot().remote.kind !== 'ready') await c.reloadRemote();
  await c.save(); assert.deepEqual(f.calls[0].scope, scope);
});

test('published input is detached and immutable across caller changes', async () => {
  const initial = { title: 'Initial' }; const f = fixture({ initialValue: initial }); const c = await ready(f);
  initial.title = 'Changed'; assert.equal(c.getSnapshot().value.title, 'Initial');
  const value = { title: 'A' }; c.update(value); value.title = 'Changed';
  assert.equal(c.getSnapshot().value.title, 'A'); assert.throws(() => { c.getSnapshot().value.title = 'Changed'; });
  await c.save(); assert.equal(f.calls[0].value.title, 'A');
});

test('guard failures preserve the exact snapshot and pending request', async () => {
  const f = fixture(); const gate = deferred(); f.remote.save = () => gate.promise;
  const c = await ready(f); const saving = c.save(); const before = c.getSnapshot();
  for (const action of ['save', 'discardRemote', 'retry', 'reloadRemote']) {
    assert.equal((await c[action]()).code, 'operation_in_progress'); assert.equal(c.getSnapshot(), before);
  }
  gate.resolve({ kind: 'unknown', message: 'Lost' }); await saving;
  const unknown = c.getSnapshot(); assert.equal((await c.save()).code, 'operation_unresolved'); assert.equal(c.getSnapshot(), unknown);
});

test('serialization failure keeps editable input and never dispatches a mutation', async () => {
  const f = fixture({ codec: { ...codec, encode: () => ({ kind: 'permanent', code: 'invalid_data', message: 'Invalid' }) } });
  const c = await ready(f); c.update({ title: 'Fix me' }); await c.persistLocal();
  assert.equal((await c.save()).code, 'invalid_data'); assert.equal(f.calls.length, 0);
  assert.equal(c.getSnapshot().value.title, 'Fix me'); assert.equal(c.getSnapshot().dirty, true);
});

test('failed remote discard never clears the recovery record', async () => {
  const f = fixture(); f.remote.discard = async () => ({ kind: 'permanent', code: 'forbidden', message: 'Denied' });
  const c = await ready(f); c.update({ title: 'Keep' }); await c.persistLocal(); const before = f.record();
  await c.discardRemote(); assert.deepEqual(f.record(), before); assert.equal(c.getSnapshot().value.title, 'Keep');
});

test('nullable local candidates can be restored and saved remotely', async () => {
  const nullableCodec = { version: 1, encode: value => ok(JSON.stringify(value)), decode: payload => ok(JSON.parse(payload)) };
  const f = fixture({ codec: nullableCodec, initialValue: 'Initial' });
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: null, dataVersion: 1, payload: 'null', savedAt: '2026-10-27T00:00:00Z' });
  f.remote.save = async request => ok({ kind: 'present', revision: 'r1', value: request.value });
  const c = await ready(f); assert.equal(c.getSnapshot().candidate.kind, 'available'); c.restore(); await c.persistLocal();
  assert.equal((await c.save()).code, 'reconciliation_required');
  assert.equal(c.reconcile(absent('r0'), null).kind, 'ok');
  await c.save(); assert.equal(c.getSnapshot().value, null); assert.equal(c.getSnapshot().dirty, false);
});

test('a failed clock permanently disables replay safety rather than recovering after a rollback', async () => {
  let clock = 0;
  const f = fixture({ now: () => clock }); f.remote.save = async () => ({ kind: 'unknown', message: 'Lost' });
  const c = await ready(f); await c.save(); clock = 500; await c.retry();
  clock = 100; assert.equal((await c.retry()).code, 'replay_window_expired');
  clock = 1000; assert.equal((await c.retry()).code, 'replay_window_expired');
});

test('retry checks its deadline and delay with one clock reading before dispatch', async () => {
  let samples = [];
  const f = fixture({ now: () => samples.length ? samples.shift() : 0 });
  f.remote.save = async r => { f.calls.push(r); return { kind: 'unknown', message: 'Lost' }; };
  const c = await ready(f); await c.save();
  samples = [249, NaN];
  // A second clock read must not bypass the delay after the first read is too early.
  assert.equal((await c.retry()).code, 'retry_not_ready');
  const before = f.calls.length; assert.equal((await c.retry()).code, 'replay_window_expired'); assert.equal(f.calls.length, before);
});

test('a mutation validation failure returns its own result when an observer starts another save', async () => {
  let id = 0; const f = fixture({ createOperationId: () => ++id === 1 ? '' : 'valid-id' });
  const c = await ready(f); let next;
  c.subscribe(() => { if (c.getSnapshot().error?.code === 'invalid_operation_id' && !next) next = c.save(); });
  const first = await c.save(); assert.equal(first?.code, 'invalid_operation_id'); assert.equal((await next).kind, 'ok');
});

test('codec callbacks during update cannot acknowledge an unpublished input generation', async () => {
  let controller, nested, enter = true;
  const f = fixture({ codec: { ...codec, encode(value) {
    if (controller && value.title === 'B' && enter) { enter = false; nested = controller.save(); }
    return codec.encode(value);
  } } });
  controller = await ready(f); controller.update({ title: 'B' }); await nested;
  assert.equal(controller.getSnapshot().value.title, 'B');
  assert.equal(controller.getSnapshot().dirty, true);
});

test('restored stale drafts retain their base revision and conflict with newer remote data', async () => {
  const f = fixture(); f.remote.load = async () => ok(present('r3', 'Newer'));
  f.remote.save = async request => { f.calls.push(request); return request.expectedRevision === 'r3' ? ok(present('r4', request.value.title)) : { kind: 'conflict', current: present('r3', 'Newer') }; };
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: 'r1', dataVersion: 1, payload: '{"title":"Stale"}', savedAt: '2026-10-27T00:00:00Z' });
  const c = await ready(f); c.restore(); await c.persistLocal();
  assert.equal(f.record().baseRevision, 'r1');
  assert.equal((await c.save()).kind, 'conflict'); assert.equal(f.calls[0].expectedRevision, 'r1');
  c.update({ title: 'Still based on stale input' }); await c.persistLocal(); assert.equal(f.record().baseRevision, 'r1');
});

test('edits during local discard are persisted after removal completes', async () => {
  const f = fixture(); const gate = deferred(); const written = deferred(); const remove = f.storage.remove; const write = f.storage.write;
  f.storage.remove = async () => { await gate.promise; return remove(); };
  const c = await ready(f); c.update({ title: 'Before' }); await c.persistLocal();
  f.storage.write = async (...args) => { const result = await write(...args); written.resolve(); return result; };
  const removing = c.discardLocal(); c.update({ title: 'During removal' });
  // Explicit flush must also wait, rather than return operation_in_progress.
  const flushing = c.persistLocal(); gate.resolve(); await removing;
  assert.equal((await flushing).kind, 'ok'); await written.promise;
  assert.equal(JSON.parse(f.record().payload).title, 'During removal');
});

test('remote reload while dirty observes newer data without rebasing the next save', async () => {
  const f = fixture(); const c = await ready(f); c.update({ title: 'Mine' }); await c.persistLocal();
  f.remote.load = async () => ok(present('r3', 'Other writer')); await c.reloadRemote();
  await c.persistLocal(); assert.equal(f.record().baseRevision, 'r0');
  await c.save(); assert.equal(f.calls[0].expectedRevision, 'r0');
});

test('editing during a remote reload retains the pre-load base revision', async () => {
  const f = fixture(); const c = await ready(f); const gate = deferred(); f.remote.load = () => gate.promise;
  const loading = c.reloadRemote(); c.update({ title: 'Edited during load' });
  gate.resolve(ok(present('r3', 'Other writer'))); await loading;
  await c.save(); assert.equal(f.calls[0].expectedRevision, 'r0');
});

test('save completion cannot rebase a stale draft restored while it was pending', async () => {
  const f = fixture(); const gate = deferred(); f.remote.save = request => { f.calls.push(request); return gate.promise; };
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: 'old', dataVersion: 1, payload: '{"title":"Stale"}', savedAt: '2026-10-27T00:00:00Z' });
  const c = await ready(f); const saving = c.save(); c.restore(); await c.persistLocal();
  gate.resolve(ok(present('r1', 'Initial'))); await saving;
  await c.persistLocal(); assert.equal(f.record().baseRevision, 'old');
  await c.save(); assert.equal(f.calls[1].expectedRevision, 'old');
});

test('automatic local persistence resumes after discard without an explicit flush', async () => {
  const f = fixture(); const gate = deferred(); const written = deferred(); const remove = f.storage.remove; const write = f.storage.write;
  f.storage.remove = async () => { await gate.promise; return remove(); };
  const c = await ready(f);
  f.storage.write = async (...args) => { const result = await write(...args); written.resolve(); return result; };
  const removing = c.discardLocal(); c.update({ title: 'Automatic' }); gate.resolve();
  await removing; await written.promise;
  assert.equal(JSON.parse(f.record().payload).title, 'Automatic');
});

test('restoring an unknown-base draft before discovery requires explicit reconciliation', async () => {
  const f = fixture(); const load = deferred(); f.remote.load = () => load.promise;
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: null, dataVersion: 1, payload: '{"title":"Unknown ancestry"}', savedAt: '2026-10-27T00:00:00Z' });
  const c = await f.open(); c.restore(); await c.persistLocal();
  const loaded = new Promise(resolve => { const unsubscribe = c.subscribe(() => { if (c.getSnapshot().remote.kind === 'ready') { unsubscribe(); resolve(); } }); });
  load.resolve(ok(present('r3', 'Other writer'))); await loaded;
  assert.equal((await c.save()).code, 'reconciliation_required'); assert.equal(f.calls.length, 0);
  assert.equal(f.record().baseRevision, null);
  assert.equal(c.reconcile(present('r3', 'Other writer'), { title: 'Chosen merge' }).kind, 'ok');
  await c.persistLocal(); assert.equal(f.record().baseRevision, 'r3');
  await c.save(); assert.equal(f.calls[0].expectedRevision, 'r3');
});

test('unknown-base restoration cannot enable remote reconciliation without an adapter', async () => {
  const f = fixture({ remote: undefined });
  await f.storage.write(scope, { formatVersion: 1, scope, baseRevision: null, dataVersion: 1, payload: '{"title":"Local"}', savedAt: '2026-10-27T00:00:00Z' });
  const c = await f.open(); c.restore();
  assert.equal(c.reconcile(absent('r0'), { title: 'Chosen' }).code, 'invalid_reconciliation_state');
  assert.equal(c.getSnapshot().remote.kind, 'disabled');
});

test('local revalidation recognizes own persisted text but protects changes and removals', async () => {
  const f = fixture({ remote: undefined }); const c = await f.open();
  c.update({ title: 'mine' }); await c.persistLocal();
  await c.refreshLocal();
  assert.equal(c.getSnapshot().candidate.kind, 'none');
  assert.equal((await c.persistLocal()).kind, 'ok');
  await f.storage.write(f.options.scope, { ...f.record(), payload: '{"title":"theirs"}' });
  await c.refreshLocal();
  assert.equal(c.getSnapshot().value.title, 'mine');
  assert.equal(c.getSnapshot().candidate.value.title, 'theirs');
  assert.equal((await c.persistLocal()).code, 'recovery_pending');
  await c.discardLocal();
  c.update({ title: 'new mine' }); await c.persistLocal();
  await f.storage.remove(f.options.scope);
  await c.refreshLocal();
  assert.equal(c.getSnapshot().candidate.kind, 'none');
  assert.equal((await c.persistLocal()).code, 'recovery_pending');
  c.dispose();
});

test('local revalidation drains in-flight writes and retains storage read failures', async () => {
  const f = fixture({ remote: undefined }); const c = await f.open();
  const gate = deferred(); const write = f.storage.write;
  f.storage.write = async (...args) => { await gate.promise; return write(...args); };
  c.update({ title: 'pending' });
  const refreshing = c.refreshLocal(); gate.resolve();
  assert.equal((await refreshing).kind, 'ok');
  assert.equal(c.getSnapshot().value.title, 'pending');
  assert.equal(c.getSnapshot().candidate.kind, 'none');
  f.storage.read = async () => ({ kind: 'retryable', code: 'offline', message: 'Unavailable' });
  assert.equal((await c.refreshLocal()).code, 'offline');
  assert.equal(c.getSnapshot().error.code, 'offline');
  assert.equal(c.getSnapshot().value.title, 'pending');
  c.dispose(); assert.equal((await c.refreshLocal()).code, 'disposed');
});
