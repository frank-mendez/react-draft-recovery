import test from 'node:test';
import assert from 'node:assert/strict';
import { registryInstallations } from '../scripts/release-policy.mjs';

test('beta verification checks pinned, beta and default consumers independently', () => {
  assert.deepEqual(registryInstallations('0.1.0-beta.1', { beta: '0.1.0-beta.1', latest: '0.1.0-beta.0' }), [
    { selector: '@0.1.0-beta.1', version: '0.1.0-beta.1' },
    { selector: '@beta', version: '0.1.0-beta.1' },
    { selector: '', version: '0.1.0-beta.0' },
  ]);
});
test('rejects stale beta tags and accidental prerelease promotion', () => {
  assert.throws(() => registryInstallations('0.1.0-beta.2', { beta: '0.1.0-beta.1', latest: '0.1.0-beta.0' }));
  assert.throws(() => registryInstallations('0.1.0-beta.1', { beta: '0.1.0-beta.1', latest: '0.1.0-beta.1' }));
  assert.throws(() => registryInstallations('0.1.0-beta.1', { beta: '0.1.0-beta.1' }));
});
test('stable verification requires latest and leaves beta independent', () => {
  assert.deepEqual(registryInstallations('0.1.0', { latest: '0.1.0', beta: '0.1.0-beta.6' }), [
    { selector: '@0.1.0', version: '0.1.0' },
    { selector: '', version: '0.1.0' },
  ]);
  assert.throws(() => registryInstallations('0.1.0', { latest: '0.1.0-beta.0' }));
});
test('beta releases after stable preserve a stable default install', () => {
  assert.equal(registryInstallations('0.2.0-beta.1', { beta: '0.2.0-beta.1', latest: '0.1.0' })[2].version, '0.1.0');
});
