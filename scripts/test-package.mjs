import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const root = resolve('.');
const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const temp = mkdtempSync(join(tmpdir(), 'draft-package-'));
const run = (cmd, args, cwd) => {
  try { return execFileSync(cmd, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] }); }
  catch (error) { if (error.stdout) console.error(error.stdout); throw error; }
};
const write = (dir, file, value) => writeFileSync(join(dir, file), value);
try {
  const [packed] = JSON.parse(run('npm', ['pack', '--json', '--pack-destination', temp], root));
  const paths = packed.files.map(file => file.path);
  for (const file of ['LICENSE', 'README.md', 'package.json', 'dist/react/index.js', 'dist/react/index.d.ts', 'dist/src/core.js', 'dist/src/core.d.ts']) assert(paths.includes(file), `Missing ${file}`);
  assert(paths.every(path => ['LICENSE', 'README.md', 'package.json'].includes(path) || /^dist\/.+\.(js|d\.ts)$/.test(path)), `Unexpected package files: ${paths}`);
  const archive = join(temp, packed.filename);
  run('tar', ['-xzf', archive, '-C', temp], temp);
  assert.equal(readFileSync(join(temp, 'package/LICENSE'), 'utf8'), readFileSync('LICENSE', 'utf8'));
  const builtHook = readFileSync(join(temp, 'package/dist/react/index.js'), 'utf8');
  assert.match(builtHook, /^['"]use client['"]/);
  assert.match(builtHook, /from ['"]react['"]/);
  const core = `import assert from 'node:assert/strict';
import { createRecovery, storageKey } from '${pkg.name}/core';
assert.equal(typeof window, 'undefined');
assert.equal(typeof document, 'undefined');
const options = { scope: { userId: 'u', documentId: 'd', editorId: 'e' }, initialValue: 'draft',
codec: { version: 1, encode: value => ({ kind: 'ok', value }), decode: value => ({ kind: 'ok', value }) },
storage: { read: async () => ({ kind: 'ok', value: null }), write: async () => ({ kind: 'ok', value: undefined }), remove: async () => ({ kind: 'ok', value: undefined }) } };
assert.match(storageKey(options.scope), /^react-draft-recovery:/);
const result = await createRecovery(options);
assert.equal(result.kind, 'ok');
assert.equal(result.value.getSnapshot().value, 'draft');
result.value.dispose();
export { options };`;
  for (const manager of ['npm', 'pnpm']) {
    const dir = join(temp, `${manager}-core`); mkdirSync(dir);
    write(dir, 'package.json', JSON.stringify({ private: true, type: 'module' }));
    run(manager, ['install', '--ignore-scripts', archive], dir);
    write(dir, 'core.mjs', core + `\nassert.throws(() => import.meta.resolve('react'), { code: 'ERR_MODULE_NOT_FOUND' });`);
    run('node', ['core.mjs'], dir);
    for (const version of ['18.3.1', '19.2.0']) {
      const app = join(temp, `${manager}-${version}`); mkdirSync(app);
      write(app, 'package.json', JSON.stringify({ private: true, type: 'module' }));
      run(manager, ['install', '--ignore-scripts', archive, `react@${version}`, `react-dom@${version}`, `@types/react@${version.startsWith('18') ? '18.3.12' : '19.2.2'}`, `@types/react-dom@${version.startsWith('18') ? '18.3.1' : '19.2.2'}`, 'typescript@5.9.3'], app);
      write(app, 'core.mjs', core);
      write(app, 'render.mjs', `import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { useDraftRecovery } from '${pkg.name}';
import { useDraftRecovery as hook } from '${pkg.name}/react';
import { options } from './core.mjs';
assert.equal(hook, useDraftRecovery);
function Editor() { const recovery = hook(options); return createElement('p', null, recovery.state.value); }
assert.equal(renderToString(createElement(Editor)), '<p>draft</p>');`);
      write(app, 'consumer.ts', `import { useDraftRecovery } from '${pkg.name}';
import { useDraftRecovery as hook } from '${pkg.name}/react';
import { createRecovery, type RecoveryEngineOptions, type Codec } from '${pkg.name}/core';
declare const options: RecoveryEngineOptions<{ title: string }>;
const codec: Codec<{ title: string }> = options.codec;
const result = useDraftRecovery(options);
hook(options); createRecovery(options); void codec;
const title: string = result.state.value.title;
if (result.ready) {
 result.actions.update({ title });
 // @ts-expect-error draft shape must remain typed
 result.actions.update({ title: 123 });
}
`);
      for (const resolution of ['NodeNext', 'Bundler']) {
        run('node', ['node_modules/typescript/bin/tsc', '--noEmit', '--strict', '--target', 'ES2022', '--module', resolution === 'NodeNext' ? 'NodeNext' : 'ESNext', '--moduleResolution', resolution, 'consumer.ts'], app);
      }
      run('node', ['render.mjs'], app);
      console.log(`${manager}: React ${version}, TypeScript NodeNext/Bundler, SSR passed`);
    }
    console.log(`${manager}: core without React passed`);
  }
  console.log(`Verified ${packed.filename}: ${paths.length} files, license and exports checked`);
} finally {
  rmSync(temp, { recursive: true, force: true });
}
