import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tag = process.argv[2];
assert.match(tag ?? '', /^v\d+\.\d+\.\d+(-beta\.\d+)?$/, 'Supply a release tag');
const version = tag.slice(1);
const name = 'react-draft-recovery';
const run = (command, args, cwd) => execFileSync(command, args, {
  cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
});
const metadata = JSON.parse(run('npm', ['view', `${name}@${version}`, '--json']));
assert.equal(metadata.version, version);
const channel = version.includes('-beta.') ? 'beta' : 'latest';
assert.equal(metadata['dist-tags'][channel], version, `Unexpected ${channel} dist-tag`);
assert(metadata.maintainers.some(owner => (typeof owner === 'string' ? owner.split(' ')[0] : owner.name) === 'frankmendez8'), 'Expected package owner');
if (process.argv.includes('--require-provenance')) {
  assert(metadata.dist.attestations?.provenance?.predicateType, 'Missing provenance attestation');
}
const temp = mkdtempSync(join(tmpdir(), 'draft-registry-'));
try {
  for (const manager of ['npm', 'pnpm']) {
    const dir = join(temp, manager);
    mkdirSync(dir);
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
    run(manager, ['install', '--ignore-scripts', `${name}@${version}`, 'react@19.2.0', 'react-dom@19.2.0'], dir);
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
    if (process.argv.includes('--require-provenance') && manager === 'npm') {
      run('npm', ['audit', 'signatures'], dir);
    }
    console.log(`${manager}: registry installation and runtime checks passed`);
  }
} finally {
  rmSync(temp, { recursive: true, force: true });
}
console.log(`${tag}: ${channel} dist-tag and registry verification passed`);
