import test from 'node:test';
import assert from 'node:assert/strict';
import { readRegistryMetadata, retryRegistryOperation } from '../scripts/registry-retry.mjs';

const failure = code => Object.assign(new Error(code), { stdout: JSON.stringify({ error: { code } }) });
test('registry verification tolerates publication propagation then returns metadata', async () => {
  let calls = 0;
  const delays = [];
  const metadata = await readRegistryMetadata(() => {
    if (++calls < 3) throw failure('E404');
    return { version: '0.1.0-beta.1' };
  }, { wait: async delay => delays.push(delay) });
  assert.equal(metadata.version, '0.1.0-beta.1');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10000, 10000]);
});
test('registry verification bounds missing-version retries', async () => {
  let calls = 0;
  const error = failure('E404');
  await assert.rejects(readRegistryMetadata(() => { calls++; throw error; }, {
    attempts: 3, wait: async () => {},
  }), candidate => candidate === error);
  assert.equal(calls, 3);
});
test('registry verification does not retry authentication or malformed errors', async () => {
  for (const error of [failure('E401'), new Error('invalid response')]) {
    await assert.rejects(readRegistryMetadata(() => { throw error; }, {
      wait: async () => assert.fail('must not retry'),
    }), candidate => candidate === error);
  }
});

test('registry signature verification retries E404 reported on stderr', async () => {
  let calls = 0;
  const delays = [];
  const result = await retryRegistryOperation(() => {
    if (++calls < 3) throw Object.assign(new Error('not propagated'), { stderr: 'npm error code E404' });
    return 'verified';
  }, { wait: async delay => delays.push(delay) });
  assert.equal(result, 'verified');
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10000, 10000]);
});

test('registry signature verification does not retry non-404 stderr errors', async () => {
  const error = Object.assign(new Error('unauthorized'), { stderr: 'npm error code E401' });
  await assert.rejects(retryRegistryOperation(() => { throw error; }, {
    wait: async () => assert.fail('must not retry'),
  }), candidate => candidate === error);
});
