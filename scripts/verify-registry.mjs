import assert from 'node:assert/strict';
import { registryInstallations } from './release-policy.mjs';
import { readRegistryMetadata, retryRegistryOperation } from './registry-retry.mjs';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tag = process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+(-beta\.\d+)?$/, 'Supply a release tag');
const version = tag.slice(1);
const name = 'react-draft-recovery';
// Only fixed executables and the exact verification operations may run.
const run = (command, args, cwd) => {
  const allowed = (
    command === 'npm' && args.length === 3 && args[0] === 'view' &&
    /^react-draft-recovery@\d+\.\d+\.\d+(-beta\.\d+)?$/.test(args[1]) && args[2] === '--json'
  ) || (
    ['npm', 'pnpm'].includes(command) && args.length === 5 &&
    args[0] === 'install' && args[1] === '--ignore-scripts' &&
    /^react-draft-recovery(@(beta|\d+\.\d+\.\d+(-beta\.\d+)?))?$/.test(args[2]) &&
    args[3] === 'react@19.2.0' && args[4] === 'react-dom@19.2.0'
  ) || (
    command === 'node' && args.length === 1 && args[0] === 'smoke.mjs'
  ) || (
    command === 'npm' && args.length === 2 && args[0] === 'audit' && args[1] === 'signatures'
  );
  if (!allowed) throw new Error('Unsupported registry verification command');
  // npm reports audit-signature 404s on stderr; capture them so only E404 is retried.
  const captureStderr = command === 'npm' && args[0] === 'audit' && args[1] === 'signatures';
  try {
    return execFileSync(command, args, {
      cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', captureStderr ? 'pipe' : 'inherit'], shell: false,
    });
  } catch (error) {
    if (captureStderr && error.stderr) process.stderr.write(error.stderr);
    throw error;
  }
};
const metadata = await readRegistryMetadata(() => JSON.parse(run('npm', ['view', `${name}@${version}`, '--json'])));
assert.equal(metadata.version, version);
const channel = version.includes('-beta.') ? 'beta' : 'latest';
const installations = registryInstallations(version, metadata['dist-tags']);
assert(metadata.maintainers.some(owner => (typeof owner === 'string' ? owner.split(' ')[0] : owner.name) === 'frankmendez8'), 'Expected package owner');
if (process.argv.includes('--require-provenance')) {
  assert(metadata.dist.attestations?.provenance?.predicateType, 'Missing provenance attestation');
}
const temp = mkdtempSync(join(tmpdir(), 'draft-registry-'));
try {
  for (const manager of ['npm', 'pnpm']) {
    for (const [index, installation] of installations.entries()) {
      const dir = join(temp, `${manager}-${index}`);
      mkdirSync(dir);
      writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
      run(manager, ['install', '--ignore-scripts', `${name}${installation.selector}`, 'react@19.2.0', 'react-dom@19.2.0'], dir);
      const installed = JSON.parse(readFileSync(join(dir, 'node_modules', name, 'package.json'), 'utf8'));
      assert.equal(installed.version, installation.version, `Unexpected installed version for ${manager} ${name}${installation.selector}`);
      writeFileSync(join(dir, 'smoke.mjs'), `
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createRecovery } from 'react-draft-recovery/core';
import { useDraftRecovery } from 'react-draft-recovery';
const options = {
  scope: { userId: 'release', documentId: 'check', editorId: 'editor' }, initialValue: 'published',
  codec: { version: 1, encode: value => ({ kind: 'ok', value }), decode: value => ({ kind: 'ok', value }) },
  storage: { read: async () => ({ kind: 'ok', value: null }), write: async () => ({ kind: 'ok' }), remove: async () => ({ kind: 'ok' }) }
};
const result = await createRecovery(options);
assert.equal(result.kind, 'ok');
assert.equal(result.value.getSnapshot().value, 'published');
result.value.dispose();
function Editor() { const draft = useDraftRecovery(options); return createElement('p', null, draft.state.value); }
assert.equal(renderToString(createElement(Editor)), '<p>published</p>');
`);
      run('node', ['smoke.mjs'], dir);
      if (process.argv.includes('--require-provenance') && manager === 'npm' && index === 0) {
        await retryRegistryOperation(() => run('npm', ['audit', 'signatures'], dir));
      }
      console.log(`${manager}: ${name}${installation.selector} resolved ${installed.version}; runtime checks passed`);
    }
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`${tag}: ${channel} dist-tag and registry verification passed`);
