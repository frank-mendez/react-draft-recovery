import assert from 'node:assert/strict';

export function registryInstallations(version, tags) {
  const beta = version.includes('-beta.');
  assert.equal(tags[beta ? 'beta' : 'latest'], version, 'Release must match its dist-tag');
  assert(
    /^\d+\.\d+\.\d+$/.test(tags.latest ?? '') || tags.latest === '0.1.0-beta.0',
    'latest must remain the bootstrap beta.0 until an explicit stable release',
  );
  return [
    { selector: `@${version}`, version },
    ...(beta ? [{ selector: '@beta', version }] : []),
    { selector: '', version: tags.latest },
  ];
}
