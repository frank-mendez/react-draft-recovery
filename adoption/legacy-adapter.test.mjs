import assert from 'node:assert/strict';
import test from 'node:test';
import { createLegacyAdapter, legacyStorageKey, normalizeLegacyRecord } from './consumer/legacy-adapter.mjs';

const query = { userId: 'alice', documentId: 'article-7' };
const source = {
  version: 1,
  userId: 'alice',
  documentId: 'article-7',
  writerId: 'old-editor',
  body: 'Recovered text',
  savedAt: '2026-10-30T12:00:00.000Z',
  approvalStatus: 'approved',
};

test('legacy normalization keeps only draft content, never approval fields', () => {
  const raw = JSON.stringify(source);
  const entry = normalizeLegacyRecord(raw, legacyStorageKey({ userId: 'alice', documentId: 'article-7', writerId: 'old-editor' }), query);

  assert.equal(entry.revision, raw);
  assert.deepEqual(entry.record.scope, { userId: 'alice', documentId: 'article-7', editorId: 'old-editor' });
  assert.deepEqual(JSON.parse(entry.record.payload), { body: 'Recovered text' });
  assert.equal(JSON.parse(entry.record.payload).approvalStatus, undefined);
  assert.equal(normalizeLegacyRecord(raw, 'legacy:v1:bob:article-7:old-editor', query), null);
});

test('legacy adapter rejects other accounts, validates cleanup revision, and preserves source on cleanup failure', async () => {
  const key = legacyStorageKey({ userId: 'alice', documentId: 'article-7', writerId: 'old-editor' });
  const entries = new Map([[key, JSON.stringify(source)]]);
  let rejectCleanup = false;
  const storage = {
    get length() { return entries.size; },
    key(index) { return [...entries.keys()][index] ?? null; },
    getItem(id) { return entries.get(id) ?? null; },
    removeItem(id) {
      if (rejectCleanup) throw new Error('storage blocked');
      entries.delete(id);
    },
  };
  const adapter = createLegacyAdapter(() => storage);

  assert.deepEqual((await adapter.list({ ...query, userId: 'bob' })).value, []);
  const listed = await adapter.list(query);
  assert.equal(listed.kind, 'ok');
  assert.equal(listed.value.length, 1);
  const entry = listed.value[0];

  const stale = await adapter.remove(query, entry.id, 'older-revision');
  assert.equal(stale.code, 'candidate_changed');
  assert.equal(entries.has(key), true);

  rejectCleanup = true;
  const failed = await adapter.remove(query, entry.id, entry.revision);
  assert.equal(failed.kind, 'retryable');
  assert.equal(entries.has(key), true);
});
