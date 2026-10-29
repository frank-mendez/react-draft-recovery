import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecovery } from '../src/recovery-engine.ts';
import { createReferenceBackend } from './reference-remote-adapter.ts';
import { reconcileEarlyInput } from './early-edit-reconciliation-example.ts';

const ok = value => ({ kind: 'ok', value });
const scope = { userId: 'u', documentId: 'd', editorId: 'e' };
const codec = { version: 1, encode: ok, decode: ok };
const failure = { kind: 'retryable', code: 'offline', message: 'Offline' };
async function fixture(t) {
  const backend = createReferenceBackend({ authorize: () => true, validate: value => typeof value === 'string' }).adapterFor('u');
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let first = true;
  const remote = { ...backend, load: s => first ? (first = false, pending) : backend.load(s) };
  let record = null;
  const storage = { read: async () => ok(record), write: async (s, next) => { record = next; return ok(); }, remove: async () => { record = null; return ok(); } };
  const recovery = (await createRecovery({ scope, initialValue: '', codec, storage, remote })).value;
  t.after(() => recovery.dispose());
  recovery.update('early input');
  await recovery.persistLocal();
  const discover = async (result) => {
    const settled = new Promise(resolve => {
      const off = recovery.subscribe(() => { if (recovery.getSnapshot().remote.kind !== 'loading') { off(); resolve(); } });
    });
    release(result ?? await backend.load(scope)); await settled;
  };
  const changeRemote = async value => backend.save({ scope, value, expectedRevision: (await backend.load(scope)).value.revision, operationId: crypto.randomUUID() });
  return { recovery, remote, backend, discover, changeRemote, record: () => record };
}

test('delayed discovery exposes reconciliation before save and preserves early local input', async t => {
  const f = await fixture(t);
  assert.equal(f.recovery.getSnapshot().remote.kind, 'loading');
  assert.equal(f.record().payload, 'early input');
  assert.equal(f.record().baseRevision, null);
  await f.discover();
  assert.equal(f.recovery.getSnapshot().error.code, 'reconciliation_required');
  assert.equal((await f.backend.load(scope)).value.kind, 'absent');
  const result = await reconcileEarlyInput(f.recovery, f.remote, scope, async ({ local, current }) => {
    assert.equal(local, 'early input'); assert.equal(current.kind, 'absent');
    return { kind: 'save', value: local };
  });
  assert.equal(result.kind, 'ok');
  assert.equal((await f.backend.load(scope)).value.value, 'early input');
  assert.equal(f.record().payload, 'early input');
});

test('failed discovery can be explicitly retried without adopting its revision', async t => {
  const f = await fixture(t); await f.discover(failure);
  assert.equal(f.recovery.getSnapshot().remote.kind, 'failed');
  await f.recovery.reloadRemote();
  assert.equal(f.recovery.getSnapshot().error.code, 'reconciliation_required');
  assert.equal((await reconcileEarlyInput(f.recovery, f.remote, scope, async ({ local }) => ({ kind: 'save', value: local }))).kind, 'ok');
});

test('decision sees freshly changed remote data and can explicitly merge', async t => {
  const f = await fixture(t); await f.discover(); await f.changeRemote('other writer');
  const result = await reconcileEarlyInput(f.recovery, f.remote, scope, async ({ local, current }) => {
    assert.equal(current.value, 'other writer');
    return { kind: 'save', value: `${local} + ${current.value}` };
  });
  assert.equal(result.kind, 'ok');
  assert.equal((await f.backend.load(scope)).value.value, 'early input + other writer');
});

test('cancellation preserves unknown ancestry and both copies', async t => {
  const f = await fixture(t); await f.discover(); await f.changeRemote('other writer');
  assert.equal((await reconcileEarlyInput(f.recovery, f.remote, scope, async () => ({ kind: 'cancel' }))).kind, 'cancelled');
  assert.equal(f.recovery.getSnapshot().value, 'early input');
  assert.equal(f.recovery.getSnapshot().error.code, 'reconciliation_required');
  assert.equal(f.record().baseRevision, null);
  assert.equal((await f.backend.load(scope)).value.value, 'other writer');
});

test('a competing write after fresh load remains a conflict, with local recovery retained', async t => {
  const f = await fixture(t); await f.discover();
  const result = await reconcileEarlyInput(f.recovery, f.remote, scope, async ({ local }) => {
    await f.changeRemote('racing writer'); return { kind: 'save', value: local };
  });
  assert.equal(result.kind, 'conflict');
  assert.equal(f.recovery.getSnapshot().status, 'conflict');
  assert.equal(f.record().payload, 'early input');
  assert.equal((await f.backend.load(scope)).value.value, 'racing writer');
});

test('typing during the decision invalidates approval instead of overwriting newer input', async t => {
  const f = await fixture(t); await f.discover();
  const result = await reconcileEarlyInput(f.recovery, f.remote, scope, async ({ local }) => {
    f.recovery.update('newer input'); return { kind: 'save', value: local };
  });
  assert.equal(result.code, 'input_changed');
  await f.recovery.persistLocal();
  assert.equal(f.record().payload, 'newer input');
  assert.equal((await f.backend.load(scope)).value.kind, 'absent');
});

for (const throws of [false, true]) test(`fresh load failure retains input (throws=${throws})`, async t => {
  const f = await fixture(t); await f.discover();
  const remote = { ...f.remote, load: async () => { if (throws) throw new Error('Offline'); return failure; } };
  const result = await reconcileEarlyInput(f.recovery, remote, scope, () => assert.fail('Must not prompt without fresh state'));
  assert.equal(result.kind, 'retryable');
  assert.equal(f.record().payload, 'early input');
  assert.equal((await f.backend.load(scope)).value.kind, 'absent');
});
