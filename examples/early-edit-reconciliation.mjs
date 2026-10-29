// Run from the repository with Node.js 24:
// node examples/early-edit-reconciliation.mjs
import { createInterface } from 'node:readline';
import { createRecovery } from '../src/recovery-engine.ts';
import { createReferenceBackend } from '../contracts/reference-remote-adapter.ts';
import { reconcileEarlyInput } from '../contracts/early-edit-reconciliation-example.ts';

const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
const lines = input[Symbol.asyncIterator]();
async function ask(prompt) {
  process.stdout.write(prompt);
  const line = await lines.next();
  return line.done ? '' : line.value;
}
const ok = value => ({ kind: 'ok', value });
const scope = { userId: 'demo', documentId: 'article', editorId: 'body' };
const backend = createReferenceBackend({ authorize: () => true, validate: value => typeof value === 'string' }).adapterFor('demo');
let release;
const discovery = new Promise(resolve => { release = resolve; });
let first = true;
const remote = { ...backend, load: s => first ? (first = false, discovery) : backend.load(s) };
// In-memory only for this demo. Use createLocalStorageAdapter() in a browser.
let record = null;
const storage = {
  read: async () => ok(record),
  write: async (s, next) => { record = next; return ok(); },
  remove: async () => { record = null; return ok(); },
};
const opened = await createRecovery({ scope, initialValue: '', storage, remote, codec: { version: 1, encode: ok, decode: ok } });
if (opened.kind !== 'ok') throw new Error(opened.message);
const recovery = opened.value;
try {
  recovery.update(await ask('Remote discovery is pending. Type your draft: '));
  await recovery.persistLocal();
  const settled = new Promise(resolve => {
    const off = recovery.subscribe(() => {
      if (recovery.getSnapshot().remote.kind !== 'loading') { off(); resolve(); }
    });
  });
  release(await backend.load(scope));
  await settled;
  console.log('State:', recovery.getSnapshot().error?.code);
  const result = await reconcileEarlyInput(recovery, remote, scope, async ({ local, current }) => {
    console.log('Your input:', local);
    console.log('Fresh remote snapshot:', current);
    const answer = await ask('Save your input against this revision? Type save, merge, or cancel: ');
    if (answer === 'save') return { kind: 'save', value: local };
    if (answer === 'merge') return { kind: 'save', value: await ask('Enter the complete merged draft: ') };
    return { kind: 'cancel' };
  });
  console.log('Result:', result);
  console.log('Retained local recovery:', record);
  console.log('Remote:', (await backend.load(scope)).value);
} finally {
  recovery.dispose();
  input.close();
}
