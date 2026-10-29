import assert from 'node:assert/strict';
import test from 'node:test';
import { createRecovery } from '../src/recovery-engine.ts';
import { codec } from '../contracts/examples.ts';

const ok = value => ({ kind: 'ok', value });
const saved = (id = 'doc-1', version = 'v2') => ok({ id, version });
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
async function fixture() {
  let record = null, clock = 0, sequence = 0;
  const calls = [];
  const scope = { userId: 'u', documentId: 'creation-key', editorId: 'writer' };
  const remote = {
    replayWindowMs: 10000,
    async load() { return ok({ kind: 'absent', revision: 'r0' }); },
    async save(request) { calls.push(request); return ok({ kind: 'present', revision: `r${++sequence}`, value: request.value }); },
    async discard(request) { calls.push(request); return ok({ kind: 'absent', revision: `r${++sequence}` }); },
  };
  const storage = {
    async read() { return ok(record); },
    async write(_scope, value) { record = structuredClone(value); return ok(); },
    async remove() { record = null; return ok(); },
  };
  const result = await createRecovery({ scope, initialValue: { title: 'Initial' }, document: { id: null, version: null },
    codec, storage, remote, now: () => clock, createOperationId: () => `op-${++sequence}` });
  assert.equal(result.kind, 'ok');
  const c = result.value;
  if (c.getSnapshot().remote.kind === 'loading') await new Promise(resolve => {
    const stop = c.subscribe(() => { if (c.getSnapshot().remote.kind !== 'loading') { stop(); resolve(); } });
  });
  return { c, remote, storage, calls, record: () => record, advance: ms => { clock += ms; } };
}

test('save A/type B acknowledges only A and preserves B locally across creation', async () => {
  const f = await fixture(); const { c } = f; const gate = deferred(), entered = deferred();
  c.update({ title: 'A' });
  const saving = c.saveDocument(request => { entered.resolve(request); return gate.promise; });
  const request = await entered.promise;
  assert.deepEqual(request, { value: { title: 'A' }, document: { id: null, version: null } });
  c.update({ title: 'B' }); await c.persistLocal();
  assert.equal((await c.save()).code, 'document_save_in_progress');
  gate.resolve(saved()); assert.equal((await saving).kind, 'ok');
  assert.equal(c.getSnapshot().document.dirty, true);
  assert.deepEqual(c.getSnapshot().document.reference, { id: 'doc-1', version: 'v2' });
  assert.equal(c.getSnapshot().document.saving, false);
  assert.equal(JSON.parse(f.record().payload).title, 'B');
  assert.equal(f.record().scope.documentId, 'creation-key');
  assert.equal(f.calls.length, 0);
  let second;
  await c.saveDocument(async request => { second = request; return saved('doc-1', 'v3'); });
  assert.equal(second.value.title, 'B'); assert.equal(second.document.version, 'v2');
  assert.equal(c.getSnapshot().document.dirty, false);
  await c.save(); assert.equal(f.calls[0].expectedRevision, 'r0');
});

test('document save pauses immediately and drains pending recovery before submitting captured input', async () => {
  const f = await fixture(); const gate = deferred();
  f.remote.save = async request => { f.calls.push(request); return gate.promise; };
  f.c.update({ title: 'A' }); const auto = f.c.save(); let submitted = false;
  const saving = f.c.saveDocument(async request => { submitted = true; assert.equal(request.value.title, 'A'); return saved(); });
  f.c.update({ title: 'B' });
  assert.equal(submitted, false);
  assert.equal((await f.c.discardRemote()).code, 'document_save_in_progress');
  gate.resolve(ok({ kind: 'present', revision: 'r1', value: { title: 'A' } }));
  await auto; await saving;
  assert.equal(submitted, true); assert.equal(f.c.getSnapshot().document.dirty, true);
  assert.equal(f.calls.length, 1);
});

test('publication failures and throws resume scheduling without clearing local recovery', async () => {
  const f = await fixture(); f.c.update({ title: 'A' });
  const denied = { kind: 'permanent', code: 'approval_required', message: 'Approval required' };
  assert.deepEqual(await f.c.saveDocument(async () => denied), denied);
  assert.equal(f.c.getSnapshot().document.dirty, true);
  assert.equal(f.c.getSnapshot().document.saving, false);
  assert.equal(JSON.parse(f.record().payload).title, 'A');
  assert.equal((await f.c.saveDocument(async () => { throw new Error('private'); })).kind, 'unknown');
  assert.equal(f.c.getSnapshot().document.saving, false);
  assert.equal((await f.c.save()).kind, 'ok');
  assert.equal(f.c.getSnapshot().document.dirty, true);
});

for (const kind of ['unknown', 'retryable']) test(`${kind} autosave blocks external submission until exact retry resolves`, async () => {
  const f = await fixture(); f.remote.save = async () => ({ kind, message: 'Lost' });
  f.c.update({ title: 'A' }); await f.c.save();
  assert.equal((await f.c.saveDocument(async () => { assert.fail('must not submit'); })).code, 'operation_unresolved');
  assert.equal(f.c.getSnapshot().document.saving, false);
  f.advance(250); f.remote.save = async request => ok({ kind: 'present', revision: 'r1', value: request.value });
  await f.c.retry();
  assert.equal((await f.c.saveDocument(async () => saved())).kind, 'ok');
});

test('permanent autosave failure permits publication; failed cleanup does not undo acknowledgement', async () => {
  const f = await fixture(); f.c.update({ title: 'A' });
  f.remote.save = async () => ({ kind: 'permanent', code: 'denied', message: 'Denied' });
  await f.c.save(); assert.equal((await f.c.saveDocument(async () => saved())).kind, 'ok');
  f.remote.save = async request => ok({ kind: 'present', revision: 'r1', value: request.value });
  await f.c.save();
  f.remote.discard = async request => { f.calls.push(request); return { kind: 'retryable', message: 'Offline' }; };
  const result = await f.c.saveDocument(async () => saved('doc-1', 'v3'));
  assert.equal(result.kind, 'ok'); assert.equal(result.value.cleanup.kind, 'retryable');
  assert.equal(f.calls[0].expectedRevision, 'r1');
  assert.equal(f.c.getSnapshot().document.dirty, false);
  assert.equal(JSON.parse(f.record().payload).title, 'A');
  f.c.update({ title: 'B' }); await f.c.persistLocal();
  assert.equal(JSON.parse(f.record().payload).title, 'B');
  assert.equal((await f.c.save()).code, 'operation_unresolved');
});

test('cleanup conflicts preserve newer remote copies and never remove local candidates', async () => {
  const f = await fixture(); f.c.update({ title: 'A' }); await f.c.save();
  const newer = { kind: 'present', revision: 'r-newer', value: { title: 'Other writer' } };
  f.remote.discard = async () => ({ kind: 'conflict', current: newer });
  const result = await f.c.saveDocument(async () => saved());
  assert.equal(result.value.cleanup.kind, 'conflict');
  assert.deepEqual(f.c.getSnapshot().remote.snapshot, newer);
  assert.equal(JSON.parse(f.record().payload).title, 'A');
});

test('unknown outcome arriving during drain blocks publication', async () => {
  const f = await fixture(), gate = deferred(); f.remote.save = () => gate.promise;
  f.c.update({ title: 'A' }); const auto = f.c.save();
  const publishing = f.c.saveDocument(async () => { assert.fail('must not submit'); });
  gate.resolve({ kind: 'unknown', message: 'Lost response' }); await auto;
  assert.equal((await publishing).code, 'operation_unresolved');
  assert.equal(f.c.getSnapshot().document.saving, false);
});

test('edits during cleanup survive and can autosave against the cleanup revision', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred();
  f.c.update({ title: 'A' }); await f.c.save();
  f.remote.discard = request => { entered.resolve(request); return gate.promise; };
  const publishing = f.c.saveDocument(async () => saved()); await entered.promise;
  f.c.update({ title: 'B' }); await f.c.persistLocal();
  gate.resolve(ok({ kind: 'absent', revision: 'deleted-r' })); await publishing;
  assert.equal(f.c.getSnapshot().document.dirty, true);
  assert.equal(JSON.parse(f.record().payload).title, 'B');
  assert.equal(f.record().baseRevision, 'deleted-r');
  f.c.dispose();
  const reopened = await createRecovery({ scope: f.record().scope, initialValue: { title: 'A' }, codec,
    storage: f.storage, remote: {
      ...f.remote,
      async load() { return ok({ kind: 'absent', revision: 'deleted-r' }); },
      async save(request) {
        return request.expectedRevision === 'deleted-r'
          ? ok({ kind: 'present', revision: 'after-reopen', value: request.value })
          : { kind: 'conflict', current: { kind: 'absent', revision: 'deleted-r' } };
      },
    } });
  reopened.value.restore(); await reopened.value.persistLocal();
  assert.equal((await reopened.value.save()).kind, 'ok');
  assert.equal(reopened.value.getSnapshot().value.title, 'B');
});

test('creation identity survives reconnect using the stable recovery scope', async () => {
  const f = await fixture(); f.c.update({ title: 'A' });
  await f.c.saveDocument(async () => { f.c.update({ title: 'B' }); return saved(); });
  f.c.dispose();
  const reopened = await createRecovery({ scope: f.record().scope, document: { id: 'doc-1', version: 'v2' },
    initialValue: { title: 'A' }, codec, storage: f.storage });
  const c = reopened.value;
  assert.equal(c.getSnapshot().candidate.value.title, 'B');
  assert.equal((await c.saveDocument(async () => { assert.fail('candidate is unreviewed'); })).code, 'recovery_pending');
  assert.equal(JSON.parse(f.record().payload).title, 'B');
  c.restore();
  assert.equal((await c.saveDocument(async request => { assert.equal(request.value.title, 'B'); return saved(); })).kind, 'ok');
  assert.equal(c.getSnapshot().document.dirty, false);
  assert.equal(JSON.parse(f.record().payload).title, 'B');
});

test('local persistence failure prevents submission and resumes recovery', async () => {
  const f = await fixture(); const write = f.storage.write;
  f.storage.write = async () => ({ kind: 'retryable', code: 'storage_quota', message: 'Full' });
  f.c.update({ title: 'A' });
  assert.equal((await f.c.saveDocument(async () => { assert.fail('not durable'); })).code, 'storage_quota');
  assert.equal(f.c.getSnapshot().document.saving, false);
  f.storage.write = write;
  assert.equal((await f.c.saveDocument(async () => saved())).kind, 'ok');
});

test('concurrent document saves are refused and malformed acknowledgements never mark input clean', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); f.c.update({ title: 'A' });
  const publishing = f.c.saveDocument(() => { entered.resolve(); return gate.promise; }); await entered.promise;
  assert.equal((await f.c.saveDocument(async () => saved())).code, 'document_save_in_progress');
  gate.resolve(ok({ id: '', version: '' })); assert.equal((await publishing).kind, 'unknown');
  assert.equal(f.c.getSnapshot().document.dirty, true);
  assert.deepEqual(f.c.getSnapshot().document.reference, { id: null, version: null });
  await f.c.saveDocument(async () => saved());
  assert.equal((await f.c.saveDocument(async () => saved('different-document'))).kind, 'unknown');
  assert.equal(f.c.getSnapshot().document.reference.id, 'doc-1');
});

test('disposal during publication prevents late acknowledgement and cleanup', async () => {
  const f = await fixture(), gate = deferred(), entered = deferred(); f.c.update({ title: 'A' }); await f.c.save();
  const publishing = f.c.saveDocument(() => { entered.resolve(); return gate.promise; }); await entered.promise;
  f.c.dispose(); gate.resolve(saved());
  assert.equal((await publishing).code, 'disposed');
  assert.equal(f.calls.length, 1);
  assert.equal(JSON.parse(f.record().payload).title, 'A');
});

test('a recovery save started by an observer is also drained before publication', async () => {
  const f = await fixture(), gate = deferred(), started = deferred(); f.c.update({ title: 'A' });
  let nested, once = false;
  const stop = f.c.subscribe(() => {
    if (!once && f.c.getSnapshot().status === 'idle' && !f.c.getSnapshot().dirty) {
      once = true; f.c.update({ title: 'B' });
      f.remote.save = () => { started.resolve(); return gate.promise; };
      nested = f.c.save();
    }
  });
  await f.c.save(); await started.promise; let submitted = false;
  const publishing = f.c.saveDocument(async () => { submitted = true; return saved(); });
  assert.equal(submitted, false);
  gate.resolve(ok({ kind: 'present', revision: 'r2', value: { title: 'B' } }));
  await nested; const result = await publishing; stop();
  assert.equal(result.kind, 'ok'); assert.equal(submitted, true);
});

test('publishing example validates and approves the submitted snapshot while newer input stays editable', async () => {
  const { publishArticle } = await import('../contracts/document-save-example.ts');
  const f = await fixture(); f.c.update({ title: '' });
  assert.equal((await publishArticle(f.c, async () => { assert.fail('invalid'); }, async () => { assert.fail('invalid'); })).code, 'validation_failed');
  f.c.update({ title: 'A' });
  assert.equal((await publishArticle(f.c, async () => false, async () => { assert.fail('not approved'); })).code, 'approval_required');
  const result = await publishArticle(f.c, async article => {
    assert.equal(article.title, 'A'); f.c.update({ title: 'B' }); return true;
  }, async request => { assert.equal(request.value.title, 'A'); return saved(); });
  assert.equal(result.kind, 'ok'); assert.equal(f.c.getSnapshot().document.dirty, true);
  assert.equal(JSON.parse(f.record().payload).title, 'B');
});

test('invalid scope still returns a structured options error', async () => {
  const f = await fixture();
  const result = await createRecovery({ scope: null, initialValue: { title: 'A' }, codec, storage: f.storage });
  assert.equal(result.kind, 'permanent'); assert.equal(result.code, 'invalid_options');
});

test('missing document response is unknown and leaves input unacknowledged', async () => {
  const f = await fixture(); f.c.update({ title: 'A' });
  assert.equal((await f.c.saveDocument(async () => null)).kind, 'unknown');
  assert.equal(f.c.getSnapshot().document.dirty, true);
  assert.equal(f.c.getSnapshot().document.saving, false);
});

test('omitted document reference accepts a server ID independent of the recovery key', async () => {
  const f = await fixture();
  const opened = await createRecovery({ scope: { userId: 'u', documentId: 'draft-key-1', editorId: 'e' },
    initialValue: { title: 'Initial' }, codec, storage: f.storage });
  const c = opened.value;
  assert.deepEqual(c.getSnapshot().document.reference, { id: null, version: null });
  c.update({ title: 'A' });
  const result = await c.saveDocument(async request => {
    assert.deepEqual(request.document, { id: null, version: null });
    return saved('server-42', 'v1');
  });
  assert.equal(result.kind, 'ok'); assert.equal(c.getSnapshot().document.dirty, false);
  assert.equal(c.getSnapshot().document.reference.id, 'server-42');
  assert.equal(f.record().scope.documentId, 'draft-key-1');
  assert.equal((await c.saveDocument(async () => saved('different-server-id'))).kind, 'unknown');
});

test('reconciling cleanup with the current acknowledged snapshot preserves document cleanliness', async () => {
  const f = await fixture(); f.c.update({ title: 'A' }); await f.c.save();
  const newer = { kind: 'present', revision: 'other', value: { title: 'Other writer' } };
  f.remote.discard = async () => ({ kind: 'conflict', current: newer });
  await f.c.saveDocument(async () => saved());
  assert.equal((await f.c.saveDocument(async () => { assert.fail('unresolved recovery conflict'); })).code, 'reconciliation_required');
  const notifications = [];
  const stop = f.c.subscribe(() => notifications.push(f.c.getSnapshot().document.dirty));
  assert.equal(f.c.reconcile(newer, f.c.getSnapshot().value).kind, 'ok');
  await f.c.persistLocal(); stop();
  assert.equal(f.c.getSnapshot().document.dirty, false);
  assert.equal(notifications.includes(true), false);
  assert.equal(f.c.getSnapshot().dirty, true);
  assert.equal(f.record().baseRevision, 'other');
  assert.equal((await f.c.saveDocument(async () => saved('doc-1', 'v3'))).kind, 'ok');
});

for (const edited of [false, true]) test(`reconciliation does not acknowledge ${edited ? 'existing edits' : 'a merged value'}`, async () => {
  const f = await fixture(); f.c.update({ title: 'A' }); await f.c.save();
  const newer = { kind: 'present', revision: 'other', value: { title: 'Other writer' } };
  f.remote.discard = async () => ({ kind: 'conflict', current: newer });
  await f.c.saveDocument(async () => saved());
  if (edited) f.c.update({ title: 'B' });
  const value = edited ? f.c.getSnapshot().value : { title: 'Merged' };
  assert.equal(f.c.reconcile(newer, value).kind, 'ok');
  assert.equal(f.c.getSnapshot().document.dirty, true);
});
