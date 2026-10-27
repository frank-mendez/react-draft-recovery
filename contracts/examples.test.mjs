import assert from 'node:assert/strict';
import test from 'node:test';
import { codec, readCandidate } from './examples.ts';

const scope = { userId: 'u', documentId: 'd', editorId: 'e' };
test('candidate reads preserve storage failures and failure-shaped raw records distinctly', async () => {
  const failure = { kind: 'permanent', code: 'denied', message: 'Storage denied' };
  const failedStorage = { read: async () => failure };
  const rawStorage = { read: async () => ({ kind: 'ok', value: failure }) };
  assert.deepEqual(await readCandidate(failedStorage, scope), failure);
  assert.deepEqual(await readCandidate(rawStorage, scope), { kind: 'ok', value: failure });
});

test('codec validates JSON and schema version before accepting application data', () => {
  assert.deepEqual(codec.decode('{"title":"Draft"}', 1), { kind: 'ok', value: { title: 'Draft' } });
  for (const [payload, version] of [['{', 1], ['null', 1], ['{"title":1}', 1], ['{"title":"Draft"}', 2]]) {
    assert.equal(codec.decode(payload, version).kind, 'permanent');
  }
});
