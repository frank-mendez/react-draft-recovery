import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { useDraftRecovery } from '../index.ts';
import { createLocalStorageAdapter } from '../../src/local-recovery.ts';
import type { Codec, RemoteAdapter, Snapshot, MutationResult } from '../../contracts/index.ts';

const codec: Codec<string> = {
  version: 1,
  encode: value => ({ kind: 'ok', value: JSON.stringify(value) }),
  decode(payload, version) {
    try {
      const value: unknown = JSON.parse(payload);
      if (version === 1 && typeof value === 'string') return { kind: 'ok', value };
    } catch { /* Invalid drafts are reported, never restored. */ }
    return { kind: 'permanent', code: 'invalid_text', message: 'Unsupported draft data.' };
  },
};
const storage = createLocalStorageAdapter();
// In-memory teaching backend. Reload resets the server; local recovery survives.
// A production backend must enforce revisions and durable idempotency atomically.
let revision = 0;
let server: Snapshot<string> = { kind: 'absent', revision: '0' };
let loseNextResponse = false;
const results = new Map<string, MutationResult<string>>();
const remote: RemoteAdapter<string> = {
  replayWindowMs: 60000,
  async load() { return { kind: 'ok', value: server }; },
  async save(request) {
    const prior = results.get(request.operationId); if (prior) return prior;
    if (request.expectedRevision !== server.revision) return { kind: 'conflict', current: server };
    server = { kind: 'present', revision: String(++revision), value: request.value };
    const result = { kind: 'ok' as const, value: server }; results.set(request.operationId, result);
    if (loseNextResponse) { loseNextResponse = false; return { kind: 'unknown', message: 'Simulated lost response. Retry after 250 ms.' }; }
    return result;
  },
  async discard(request) {
    const prior = results.get(request.operationId); if (prior) return prior;
    if (request.expectedRevision !== server.revision) return { kind: 'conflict', current: server };
    server = { kind: 'absent', revision: String(++revision) };
    const result = { kind: 'ok' as const, value: server }; results.set(request.operationId, result); return result;
  },
};
function App() {
  const recovery = useDraftRecovery({ scope: { userId: 'demo', documentId: 'note', editorId: 'plain' }, initialValue: '', codec, storage, remote });
  const { state, actions } = recovery;
  const [message, setMessage] = useState('');
  const report = async (operation: Promise<{ kind: string; message?: string; code?: string }>) => {
    const result = await operation;
    setMessage(result.message ?? result.code ?? result.kind);
  };
  return <main style={{ maxWidth: 640, margin: '3rem auto', fontFamily: 'system-ui', padding: 16 }}>
    <h1>Recover your draft</h1>
    <p>Type a note, then reload to find a local draft. Restore it explicitly or discard the saved copy.</p>
    <label>Your note<textarea style={{ display: 'block', width: '100%', minHeight: 160 }} disabled={!actions} value={state.value} onChange={event => actions?.update(event.target.value)} /></label>
    <p role="status">{state.status}{state.dirty ? ' · Unsaved changes' : ''}</p>
    {state.error && <p role="alert">{state.error.message}</p>}
    {actions && <>
      {state.candidate.kind === 'available' && <button onClick={() => actions.restore()}>Restore draft</button>}
      <button onClick={() => void report(actions.discardLocal())}>Discard local draft</button>
      <button onClick={() => void report(actions.persistLocal())}>Retry local storage</button>
      <button onClick={() => void report(actions.save())}>Save to demo server</button>
      <button onClick={() => void report(actions.discardRemote())}>Discard remote draft</button>
      <button onClick={() => void report(actions.retry())}>Retry remote operation</button>
      <button onClick={() => void report(actions.reloadRemote())}>Reload remote</button>
      <hr />
      <button onClick={() => { loseNextResponse = true; setMessage('Next successful save loses its response. Save, wait 250 ms, then retry.'); }}>Simulate lost response</button>
      <button onClick={() => { server = { kind: 'present', revision: String(++revision), value: 'Edited elsewhere' }; setMessage('Server changed. Save to see the conflict.'); }}>Simulate competing edit</button>
      {state.remote.kind === 'ready' && <section>
        <h2>Remote revision {state.remote.snapshot.revision}</h2>
        <p>{state.remote.snapshot.kind === 'present' ? state.remote.snapshot.value : '(No remote draft)'}</p>
        <p>After a conflict or restoring a draft with unknown ancestry, choose the text above, then explicitly reconcile before saving.</p>
        <button onClick={() => {
          if (state.remote.kind === 'ready') {
            const result = actions.reconcile(state.remote.snapshot, state.value);
            setMessage(result.kind === 'ok' ? 'Reconciled. Save to submit your text.' : result.message);
          }
        }}>Keep my text against this revision</button>
      </section>}
    </>}
    <p aria-live="polite">{message}</p>
    <small>The demo server is in memory and resets on reload. No form library is used.</small>
  </main>;
}
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
