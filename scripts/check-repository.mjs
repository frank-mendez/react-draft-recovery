import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const read = (path) => readFileSync(path, 'utf8');
for (const path of ['README.md', 'CHANGELOG.md', 'docs/publishing.md']) {
  assert(read(path).trim(), `${path} must not be empty`);
}
JSON.parse(read('release-please-config.json'));
JSON.parse(read('.release-please-manifest.json'));
if (!existsSync('package.json')) {
  assert(!process.argv.includes('--require-package'), 'Release blocked: package.json is missing');
  console.log('Repository checks passed; no publishable package exists. Run the contracts tooling for typechecks and local recovery tests.');
  process.exit(0);
}
const pkg = JSON.parse(read('package.json'));
assert(/^pnpm@\d+\.\d+\.\d+(\+sha\d+\..+)?$/.test(pkg.packageManager), 'Pin an exact pnpm version in packageManager');
assert(existsSync('pnpm-lock.yaml'), 'Commit pnpm-lock.yaml');
for (const script of ['lint', 'typecheck', 'test', 'build', 'test:package']) {
  assert(pkg.scripts?.[script]?.trim(), `Missing required script: ${script}`);
}
if (process.argv.includes('--require-package')) {
  assert(pkg.name && pkg.version && pkg.private !== true, 'Package must have a name/version and be publishable');
  assert(pkg.license && existsSync('LICENSE'), 'Choose a license and include LICENSE');
  assert(pkg.exports && pkg.types && pkg.files?.length, 'Define exports, types and files');
  assert(pkg.peerDependencies?.react, 'Declare supported React peer versions');
  assert(!pkg.dependencies?.react, 'React must not be a runtime dependency');
  assert(pkg.publishConfig?.access === 'public', 'Set publishConfig.access to public');
  assert(!pkg.publishConfig?.registry || pkg.publishConfig.registry === 'https://registry.npmjs.org/', 'Release must target npm');
  assert(`v${pkg.version}` === process.env.RELEASE_TAG, 'Release tag must match package.json version');
}
console.log('Repository/package metadata checks passed.');
