import assert from 'node:assert/strict';

/**
 * Source-level conformance tooling (Node 24+), not a runtime package export.
 * createFixture() returns a fresh isolated backend with:
 * - adapterFor(principal): RemoteAdapter<{title: string, body: string}>
 *   Bind a trusted test identity, never derive identity from request.scope.
 * - setAuthorized(principal, allowed): revoke/restore all access for that identity
 * - setValidationAllowed(allowed): toggle a permanent save policy rejection
 * - advanceTime(ms): advance a FROZEN backend receipt clock, including expiry/GC
 *   Time must not otherwise elapse during calls; boundary tests use the full window.
 * - dispose?(): release resources
 * Controls may be asynchronous. See docs/remote-adapters.md for backend integration.
 */
export async function runRemoteAdapterConformance(test, createFixture) {
  for (const [name, check] of Object.entries(remoteAdapterCases)) {
    await test(name, async () => {
      const fixture = await createFixture();
      try { await check(fixture); }
      finally { await fixture.dispose?.(); }
    });
  }
}

const scope = { userId: 'alice', documentId: 'document', editorId: 'editor' };
const value = { title: 'First draft', body: 'Text' };
const later = { title: 'Later draft', body: 'New text' };
const request = (revision, operationId, overrides = {}) => ({
  scope, expectedRevision: revision, operationId, value, ...overrides,
});
function snapshot(result) {
  assert.equal(result.kind, 'ok');
  assert.ok(typeof result.value.revision === 'string' && result.value.revision.length > 0);
  assert.ok(['present', 'absent'].includes(result.value.kind));
  return result.value;
}
async function initial(adapter, target = scope) { return snapshot(await adapter.load(target)); }
function denied(result) { assert.equal(result.kind, 'permanent'); }

export const remoteAdapterCases = {
  async 'absence is stable and every save/discard advances a revision without ABA'(f) {
    const a = f.adapterFor('alice');
    const first = await initial(a);
    assert.equal(first.kind, 'absent');
    assert.deepEqual(await initial(a), first);
    const created = snapshot(await a.save(request(first.revision, 'create')));
    assert.equal(created.kind, 'present');
    assert.deepEqual(created.value, value);
    const deleted = snapshot(await a.discard(request(created.revision, 'delete')));
    assert.equal(deleted.kind, 'absent');
    const deletedAgain = snapshot(await a.discard(request(deleted.revision, 'delete-again')));
    assert.equal(deletedAgain.kind, 'absent');
    const recreated = snapshot(await a.save(request(deletedAgain.revision, 'recreate')));
    assert.equal(recreated.kind, 'present');
    assert.equal(new Set([first, created, deleted, deletedAgain, recreated].map(s => s.revision)).size, 5);
    assert.equal((await a.save(request(first.revision, 'stale-create'))).kind, 'conflict');
    assert.equal((await a.discard(request(created.revision, 'stale-delete'))).kind, 'conflict');
    assert.deepEqual(await initial(a), recreated);
  },
  async 'competing saves atomically compare revisions'(f) {
    const a = f.adapterFor('alice');
    const b = f.adapterFor('alice');
    const base = await initial(a);
    const results = await Promise.all([
      a.save(request(base.revision, 'one')),
      b.save(request(base.revision, 'two', { value: later })),
    ]);
    assert.deepEqual(results.map(r => r.kind).sort(), ['conflict', 'ok']);
    const committed = snapshot(results.find(r => r.kind === 'ok'));
    assert.deepEqual(results.find(r => r.kind === 'conflict').current, committed);
    assert.deepEqual(await initial(a), committed);
  },
  async 'save and discard atomically compete on the same revision'(f) {
    const a = f.adapterFor('alice');
    const base = snapshot(await a.save(request((await initial(a)).revision, 'seed')));
    const results = await Promise.all([
      a.save(request(base.revision, 'save')),
      f.adapterFor('alice').discard(request(base.revision, 'discard')),
    ]);
    assert.deepEqual(results.map(r => r.kind).sort(), ['conflict', 'ok']);
    const committed = snapshot(results.find(r => r.kind === 'ok'));
    assert.deepEqual(results.find(r => r.kind === 'conflict').current, committed);
    assert.deepEqual(await initial(a), committed);
  },
  async 'competing discards atomically compare revisions even for absence'(f) {
    const a = f.adapterFor('alice');
    const base = await initial(a);
    const results = await Promise.all([
      a.discard(request(base.revision, 'one')),
      f.adapterFor('alice').discard(request(base.revision, 'two')),
    ]);
    assert.deepEqual(results.map(r => r.kind).sort(), ['conflict', 'ok']);
    const committed = snapshot(results.find(r => r.kind === 'ok'));
    assert.equal(committed.kind, 'absent');
    assert.notEqual(committed.revision, base.revision);
    assert.deepEqual(results.find(r => r.kind === 'conflict').current, committed);
    assert.deepEqual(await initial(a), committed);
  },
  async 'a stale save cannot resurrect a discarded draft'(f) {
    const a = f.adapterFor('alice');
    const base = snapshot(await a.save(request((await initial(a)).revision, 'seed')));
    const tombstone = snapshot(await a.discard(request(base.revision, 'discard')));
    assert.deepEqual(await a.save(request(base.revision, 'late-save')), { kind: 'conflict', current: tombstone });
    assert.deepEqual(await initial(a), tombstone);
  },
  async 'a stale discard cannot delete a newer save'(f) {
    const a = f.adapterFor('alice');
    const base = await initial(a);
    const saved = snapshot(await a.save(request(base.revision, 'save')));
    assert.deepEqual(await a.discard(request(base.revision, 'late-discard')), { kind: 'conflict', current: saved });
    assert.deepEqual(await initial(a), saved);
  },
  async 'save receipts replay after later mutations through the advertised window'(f) {
    const a = f.adapterFor('alice');
    assert.ok(Number.isFinite(a.replayWindowMs) && a.replayWindowMs > 0);
    const req = request((await initial(a)).revision, 'save');
    const original = await a.save(req);
    const deleted = snapshot(await a.discard(request(snapshot(original).revision, 'discard')));
    const current = snapshot(await a.save(request(deleted.revision, 'later', { value: later })));
    await f.advanceTime(a.replayWindowMs / 2);
    assert.deepEqual(await a.save(req), original);
    await f.advanceTime(a.replayWindowMs / 2);
    assert.deepEqual(await f.adapterFor('alice').save(req), original);
    assert.deepEqual(await initial(a), current);
  },
  async 'discard receipts replay after recreation through the advertised window'(f) {
    const a = f.adapterFor('alice');
    const req = request((await initial(a)).revision, 'discard');
    const original = await a.discard(req);
    assert.equal(snapshot(original).kind, 'absent');
    const current = snapshot(await a.save(request(original.value.revision, 'later')));
    await f.advanceTime(a.replayWindowMs);
    assert.deepEqual(await a.discard(req), original);
    assert.deepEqual(await initial(a), current);
  },
  async 'concurrent identical saves execute once and replay one result'(f) {
    const a = f.adapterFor('alice');
    const req = request((await initial(a)).revision, 'same');
    const results = await Promise.all(Array.from({ length: 8 }, () => f.adapterFor('alice').save(structuredClone(req))));
    const committed = snapshot(results[0]);
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(await initial(a), committed);
  },
  async 'concurrent identical discards execute once and replay one tombstone'(f) {
    const a = f.adapterFor('alice');
    const req = request((await initial(a)).revision, 'same');
    const results = await Promise.all(Array.from({ length: 8 }, () => f.adapterFor('alice').discard(structuredClone(req))));
    const committed = snapshot(results[0]);
    assert.equal(committed.kind, 'absent');
    for (const result of results) assert.deepEqual(result, results[0]);
    assert.deepEqual(await initial(a), committed);
  },
  async 'operation IDs bind payload, revision and mutation kind'(f) {
    const a = f.adapterFor('alice');
    const req = request((await initial(a)).revision, 'bound');
    const original = await a.save(req);
    const current = snapshot(original);
    for (const result of [
      await a.save({ ...req, value: later }),
      await a.save({ ...req, expectedRevision: current.revision }),
      await a.discard(req),
    ]) {
      assert.equal(result.kind, 'permanent');
      assert.equal(result.code, 'idempotency_mismatch');
    }
    assert.deepEqual(await a.save(req), original);
    assert.deepEqual(await initial(a), current);
  },
  async 'concurrent changed-payload key reuse commits only one request'(f) {
    const a = f.adapterFor('alice');
    const req = request((await initial(a)).revision, 'bound');
    const results = await Promise.all([a.save(req), f.adapterFor('alice').save({ ...req, value: later })]);
    assert.deepEqual(results.map(r => r.kind).sort(), ['ok', 'permanent']);
    assert.equal(results.find(r => r.kind === 'permanent').code, 'idempotency_mismatch');
    assert.deepEqual(await initial(a), snapshot(results.find(r => r.kind === 'ok')));
  },
  async 'conflict receipts retain the original snapshot after later mutations'(f) {
    const a = f.adapterFor('alice');
    const base = await initial(a);
    const saved = snapshot(await a.save(request(base.revision, 'save')));
    const save = request(base.revision, 'conflicted-save');
    const discard = request(base.revision, 'conflicted-discard');
    const saveResult = await a.save(save);
    const discardResult = await a.discard(discard);
    assert.deepEqual(saveResult, { kind: 'conflict', current: saved });
    assert.deepEqual(discardResult, saveResult);
    const current = snapshot(await a.discard(request(saved.revision, 'later')));
    await f.advanceTime(a.replayWindowMs);
    assert.deepEqual(await a.save(save), saveResult);
    assert.deepEqual(await a.discard(discard), discardResult);
    assert.deepEqual(await initial(a), current);
  },
  async 'permanent policy rejections remain terminal even when policy changes'(f) {
    const a = f.adapterFor('alice');
    const req = request((await initial(a)).revision, 'rejected');
    await f.setValidationAllowed(false);
    const rejected = await a.save(req);
    denied(rejected);
    await f.setValidationAllowed(true);
    const current = snapshot(await a.save({ ...req, operationId: 'accepted', value: later }));
    await f.advanceTime(a.replayWindowMs);
    assert.deepEqual(await a.save(req), rejected);
    assert.deepEqual(await initial(a), current);
  },
  async 'every call and replay reauthorizes before exposing state or receipts'(f) {
    const a = f.adapterFor('alice');
    const save = request((await initial(a)).revision, 'save');
    const saved = await a.save(save);
    const discard = request(snapshot(saved).revision, 'discard');
    const discarded = await a.discard(discard);
    snapshot(discarded);
    await f.setAuthorized('alice', false);
    denied(await a.load(scope));
    denied(await a.save(save));
    denied(await a.discard(discard));
    denied(await a.save(request(discarded.value.revision, 'new-save')));
    denied(await a.discard(request(discarded.value.revision, 'new-discard')));
    await f.setAuthorized('alice', true);
    assert.deepEqual(await a.save(save), saved);
    assert.deepEqual(await a.discard(discard), discarded);
    assert.deepEqual(await initial(a), discarded.value);
  },
  async 'client scope cannot impersonate an authenticated principal'(f) {
    const alice = f.adapterFor('alice');
    const req = request((await initial(alice)).revision, 'secret');
    const result = await alice.save(req);
    snapshot(result);
    const bob = f.adapterFor('bob');
    denied(await bob.load(scope));
    denied(await bob.save(req));
    denied(await bob.discard(req));
    const ownScope = { ...scope, userId: 'bob' };
    const own = await initial(bob, ownScope);
    const saved = snapshot(await bob.save(request(own.revision, 'secret', { scope: ownScope, value: later })));
    assert.deepEqual(saved.value, later);
    assert.deepEqual(await initial(alice), result.value);
  },
  async 'editor and document streams isolate revisions and operation IDs'(f) {
    const a = f.adapterFor('alice');
    const scopes = [scope, { ...scope, editorId: 'other' }, { ...scope, documentId: 'other' },
      { ...scope, documentId: 'a:b', editorId: 'c' }, { ...scope, documentId: 'a', editorId: 'b:c' }];
    const saved = [];
    for (const [index, target] of scopes.entries()) {
      const base = await initial(a, target);
      assert.equal(base.kind, 'absent');
      saved.push(snapshot(await a.save(request(base.revision, 'same-id', {
        scope: target, value: { title: String(index), body: 'isolated' },
      }))));
    }
    for (const [index, target] of scopes.entries()) assert.deepEqual(await initial(a, target), saved[index]);
  },
};
