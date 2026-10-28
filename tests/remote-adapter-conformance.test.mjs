import assert from 'node:assert/strict';
import test from 'node:test';
import { runRemoteAdapterConformance, remoteAdapterCases } from '../contracts/remote-adapter-conformance.mjs';
import { createReferenceBackend } from '../contracts/reference-remote-adapter.ts';
import { createNaiveFixture } from './fixtures/naive-remote-adapter.mjs';

function createFixture() {
  let clock = 0;
  let validationAllowed = true;
  const revoked = new Set();
  const backend = createReferenceBackend({
    now: () => clock,
    authorize: (principal, scope) => principal === scope.userId && !revoked.has(principal),
    validate: value => validationAllowed && value !== null && typeof value === 'object'
      && typeof value.title === 'string' && typeof value.body === 'string',
  });
  return {
    ...backend,
    advanceTime(ms) { clock += ms; },
    setAuthorized(principal, allowed) { allowed ? revoked.delete(principal) : revoked.add(principal); },
    setValidationAllowed(allowed) { validationAllowed = allowed; },
  };
}

await runRemoteAdapterConformance(test, createFixture);

// These are expected assertion failures, not skipped/todo tests or swallowed errors.
const naiveFailures = [
  'competing discards atomically compare revisions even for absence',
  'absence is stable and every save/discard advances a revision without ABA',
  'save receipts replay after later mutations through the advertised window',
  'discard receipts replay after recreation through the advertised window',
  'operation IDs bind payload, revision and mutation kind',
  'concurrent changed-payload key reuse commits only one request',
  'conflict receipts retain the original snapshot after later mutations',
  'permanent policy rejections remain terminal even when policy changes',
];
for (const name of naiveFailures) {
  test(`naive conditional-write adapter fails: ${name}`, async () => {
    await assert.rejects(() => remoteAdapterCases[name](createNaiveFixture()), { code: 'ERR_ASSERTION' });
  });
}

const scope = { userId: 'alice', documentId: 'document', editorId: 'editor' };
test('reference snapshots and receipts are detached from inputs and outputs', async () => {
  const a = createFixture().adapterFor('alice');
  const req = { scope, operationId: 'save', expectedRevision: (await a.load(scope)).value.revision,
    value: { title: 'Original', body: 'Text' } };
  const frozen = structuredClone(req);
  const saved = await a.save(req);
  const expected = structuredClone(saved);
  req.value.title = 'Mutated input';
  saved.value.value.title = 'Mutated result';
  const loaded = await a.load(scope);
  assert.deepEqual(loaded, expected);
  loaded.value.value.title = 'Mutated load';
  assert.deepEqual(await a.save(frozen), expected);
  assert.deepEqual(await a.load(scope), expected);
});

test('reference fingerprints canonicalize object keys without losing payload identity', async () => {
  const a = createFixture().adapterFor('alice');
  const req = { scope, operationId: 'canonical', expectedRevision: (await a.load(scope)).value.revision,
    value: { title: 'Title', body: 'Body' } };
  const saved = await a.save(req);
  assert.equal(saved.kind, 'ok');
  assert.deepEqual(await a.save({ ...req, value: { body: 'Body', title: 'Title' } }), saved);
  assert.equal((await a.save({ ...req, value: { body: 'Changed', title: 'Title' } })).code, 'idempotency_mismatch');
});

test('reference rejects non-JSON data and invalid retention settings', async () => {
  const a = createFixture().adapterFor('alice');
  const base = await a.load(scope);
  const cycle = {}; cycle.self = cycle;
  class CustomValue { field = "value"; }
  for (const extra of [undefined, NaN, Infinity, 1n, new Date(), cycle, Array(1), new CustomValue(), () => {}, { [Symbol("hidden")]: 1 }]) {
    const result = await a.save({ scope, operationId: 'invalid', expectedRevision: base.value.revision,
      value: { title: 'Title', body: 'Body', extra } });
    assert.equal(result.code, 'invalid_json');
    assert.deepEqual(await a.load(scope), base);
  }
  for (const replayWindowMs of [0, -1, NaN, Infinity]) {
    assert.throws(() => createReferenceBackend({ replayWindowMs }), /Invalid replay window/);
  }
});

test('receipt cleanup preserves the inclusive deadline and stream revisions after expiry', async () => {
  const f = createFixture();
  const a = f.adapterFor('alice');
  const req = { scope, operationId: 'retained', expectedRevision: (await a.load(scope)).value.revision,
    value: { title: 'First', body: 'Text' } };
  const saved = await a.save(req);
  f.advanceTime(a.replayWindowMs);
  const deleted = await a.discard({ ...req, operationId: 'at-boundary', expectedRevision: saved.value.revision });
  assert.deepEqual(await a.save(req), saved);
  f.advanceTime(1);
  const recreated = await a.save({ ...req, operationId: 'after-boundary', expectedRevision: deleted.value.revision });
  assert.equal(recreated.kind, 'ok');
  assert.notEqual(recreated.value.revision, saved.value.revision);
  assert.deepEqual(await a.save(req), { kind: 'conflict', current: recreated.value });
  assert.deepEqual(await a.discard({ ...req, operationId: 'at-boundary', expectedRevision: saved.value.revision }), deleted);
  assert.deepEqual(await a.load(scope), recreated);
});
