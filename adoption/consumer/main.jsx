import { StrictMode, createElement as h, useCallback, useEffect, useMemo, useRef, useState, version as reactVersion } from 'react';
import { createRoot } from 'react-dom/client';
import { useDraftRecovery } from 'react-draft-recovery';
import { createLocalStorageAdapter, createRecoveryDiscovery } from 'react-draft-recovery/core';
import { createLegacyAdapter, legacyStorageKey } from './legacy-adapter.mjs';

window.__adoptionReactVersion = reactVersion;

const ok = value => ({ kind: 'ok', value });
const codec = {
  version: 1,
  encode(value) {
    if (!value || typeof value.body !== 'string') {
      return { kind: 'permanent', code: 'invalid_draft', message: 'Draft body must be text.' };
    }
    return ok(JSON.stringify({ body: value.body }));
  },
  decode(payload) {
    try {
      const parsed = JSON.parse(payload);
      if (!parsed || typeof parsed.body !== 'string') {
        return { kind: 'permanent', code: 'invalid_draft', message: 'Draft body must be text.' };
      }
      // Editorial state belongs to the application/server and is never restored.
      return ok({ body: parsed.body, approvalStatus: 'awaiting_review' });
    } catch {
      return { kind: 'permanent', code: 'invalid_draft', message: 'Draft is not valid JSON.' };
    }
  },
};
const storage = createLocalStorageAdapter();
const backend = window.__adoptionBackend ??= {
  streams: new Map(),
  pendingLoads: [],
  staleLoadsResolved: 0,
  pendingSaves: [],
  pendingDocument: null,
  requests: [],
  documentRequests: [],
  delayAliceLoad: new URLSearchParams(location.search).has('staleLoad'),
  delayNextSave: false,
  unknownNextSave: false,
  delayNextDocument: false,
};

const stream = scope => {
  const key = JSON.stringify(scope);
  let state = backend.streams.get(key);
  if (!state) {
    state = { sequence: 0, snapshot: { kind: 'absent', revision: 'r0' }, receipts: new Map() };
    backend.streams.set(key, state);
  }
  return state;
};

function createRemote(scope) {
  const state = stream(scope);
  return {
    replayWindowMs: 60_000,
    async load() {
      if (scope.userId === 'alice' && backend.delayAliceLoad) {
        backend.delayAliceLoad = false;
        return new Promise(resolve => backend.pendingLoads.push(() => {
          backend.staleLoadsResolved++;
          resolve(ok({
            kind: 'present', revision: 'stale-alice-load',
            value: { body: 'stale account response', approvalStatus: 'awaiting_review' },
          }));
        }));
      }
      return ok(structuredClone(state.snapshot));
    },
    async save(request) {
      backend.requests.push(structuredClone(request));
      const receipt = state.receipts.get(request.operationId);
      if (receipt) return structuredClone(receipt);
      if (request.expectedRevision !== state.snapshot.revision) {
        return { kind: 'conflict', current: structuredClone(state.snapshot) };
      }
      const committed = {
        kind: 'present',
        revision: `r${++state.sequence}`,
        // Deliberately persist only editable content. Approval is app-owned.
        value: { body: request.value.body, approvalStatus: 'awaiting_review' },
      };
      const result = ok(committed);
      state.snapshot = committed;
      state.receipts.set(request.operationId, result);
      if (backend.delayNextSave) {
        backend.delayNextSave = false;
        return new Promise(resolve => backend.pendingSaves.push(() => resolve(structuredClone(result))));
      }
      if (backend.unknownNextSave) {
        backend.unknownNextSave = false;
        return { kind: 'unknown', message: 'The fixture lost the save response.' };
      }
      return result;
    },
    async discard(request) {
      if (request.expectedRevision !== state.snapshot.revision) {
        return { kind: 'conflict', current: structuredClone(state.snapshot) };
      }
      state.snapshot = { kind: 'absent', revision: `r${++state.sequence}` };
      return ok(state.snapshot);
    },
  };
}

function Editor({ account, editorId, manual, legacySelection, onAccountChange, onLegacyPrepared, onLegacySelectionDone, onRemount }) {
  window.__adoptionAccount = account;
  const scope = useMemo(() => ({ userId: account, documentId: 'article-7', editorId }), [account, editorId]);
  const remote = useMemo(() => createRemote(scope), [scope]);
  const recovery = useDraftRecovery({
    scope,
    initialValue: { body: '', approvalStatus: 'awaiting_review' },
    document: { id: null, version: null },
    codec,
    storage,
    remote,
    localWritePolicy: manual ? 'manual' : 'immediate',
  });
  const { state } = recovery;
  const actions = recovery.ready ? recovery.actions : null;
  const [message, setMessage] = useState('');
  const [legacyCleanup, setLegacyCleanup] = useState('');
  const pendingLegacyRestore = useRef(null);
  const needsConfirmation = state.dirty || state.document.dirty || state.document.saving ||
    state.candidate.kind === 'available' || state.status === 'unknown' || state.status === 'conflict';

  useEffect(() => {
    if (!actions) return undefined;
    const pagehide = () => { void actions.persistLocal(); };
    const beforeunload = event => {
      if (!needsConfirmation) return;
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('pagehide', pagehide);
    window.addEventListener('beforeunload', beforeunload);
    return () => {
      window.removeEventListener('pagehide', pagehide);
      window.removeEventListener('beforeunload', beforeunload);
    };
  }, [actions, needsConfirmation]);

  useEffect(() => {
    const pending = pendingLegacyRestore.current;
    if (!pending || pending.running || !actions || state.candidate.kind !== 'none') return;

    let expectedBody;
    try {
      expectedBody = JSON.parse(pending.candidate.record.payload).body;
    } catch {
      pendingLegacyRestore.current = null;
      onLegacySelectionDone(pending.discovery);
      setLegacyCleanup('Restore could not be verified; legacy source remains');
      return;
    }
    if (state.value.body !== expectedBody) {
      pendingLegacyRestore.current = null;
      onLegacySelectionDone(pending.discovery);
      setLegacyCleanup('Restore did not match the imported draft; legacy source remains');
      return;
    }

    // The destination must be durably written before deleting the legacy copy.
    pending.running = true;
    void (async () => {
      const persisted = await actions.persistLocal();
      if (persisted.kind !== 'ok') {
        pendingLegacyRestore.current = null;
        onLegacySelectionDone(pending.discovery);
        setLegacyCleanup(`Local recovery save failed (${persisted.code}); legacy source remains`);
        return;
      }

      const discarded = await pending.discovery.discard(
        pending.candidate.id,
        pending.candidate.revision,
      );
      pendingLegacyRestore.current = null;
      onLegacySelectionDone(pending.discovery);
      setLegacyCleanup(discarded.kind === 'ok'
        ? 'Legacy source cleaned up'
        : `Legacy cleanup failed (${discarded.code}); both copies remain`);
    })();
  }, [actions, onLegacySelectionDone, state.candidate.kind, state.value]);

  async function seedLegacyRecord() {
    const id = legacyStorageKey({ userId: account, documentId: 'article-7', writerId: 'old-editor' });
    localStorage.setItem(id, JSON.stringify({
      version: 1, userId: account, documentId: 'article-7', writerId: 'old-editor',
      body: 'Legacy recovery text', savedAt: '2026-10-30T12:00:00.000Z', approvalStatus: 'approved',
    }));
    setMessage('Legacy draft ready');
  }

  async function importLegacyRecord() {
    const discovery = createRecoveryDiscovery({
      userId: account,
      getUserId: () => window.__adoptionAccount,
      documentId: 'article-7',
      adapter: createLegacyAdapter(),
      codec,
    });
    const listed = await discovery.refresh();
    if (listed.kind !== 'ok' || listed.value.length === 0) {
      setMessage(listed.kind === 'ok' ? 'No legacy draft found' : listed.message);
      discovery.dispose();
      return;
    }
    const candidate = listed.value[0];
    const imported = await discovery.importCandidate(candidate.id, scope, storage.discovery, candidate.revision);
    if (imported.kind !== 'ok') {
      setMessage(imported.message);
      discovery.dispose();
      return;
    }
    onLegacyPrepared({ discovery, candidate });
    onRemount();
    setMessage('Legacy draft imported; choose Restore to apply it');
  }

  async function restoreLegacy() {
    if (!actions || !legacySelection) return;
    pendingLegacyRestore.current = {
      discovery: legacySelection.discovery,
      candidate: legacySelection.candidate,
      running: false,
    };
    const restored = actions.restore();
    if (restored.kind !== 'ok') {
      pendingLegacyRestore.current = null;
      onLegacySelectionDone(legacySelection.discovery);
      setLegacyCleanup(`Restore failed (${restored.code}); legacy source remains`);
      return;
    }
    setLegacyCleanup('Verifying restored copy before cleanup');
  }

  function restoreRecoveryDraft() {
    const restored = actions?.restore();
    if (restored?.kind === 'ok' && legacySelection) {
      // This explicit restore keeps the old source but ends this import session.
      onLegacySelectionDone(legacySelection.discovery);
    }
  }

  async function publishDocument() {
    if (!actions) return;
    const result = await actions.saveDocument(request => {
      backend.documentRequests.push(structuredClone(request));
      const acknowledgement = ok({ id: 'server-article-42', version: 'document-v1' });
      if (!backend.delayNextDocument) return Promise.resolve(acknowledgement);
      backend.delayNextDocument = false;
      return new Promise(resolve => {
        backend.pendingDocument = () => resolve(acknowledgement);
      });
    });
    setMessage(result.kind === 'ok' ? 'Document save acknowledged' : `Document save ${result.kind}`);
  }

  async function navigate() {
    if (needsConfirmation && !window.confirm('Leave this editor?')) return;
    if (state.dirty || state.document.dirty) {
      const flushed = await actions?.persistLocal();
      if (flushed?.kind !== 'ok') {
        setMessage(`Navigation kept in editor (${flushed?.code ?? 'not_ready'})`);
        return;
      }
    }
    location.hash = 'next';
  }

  const candidateAvailable = state.candidate.kind === 'available';
  const remoteBody = state.remote.kind === 'ready' && state.remote.snapshot.kind === 'present'
    ? state.remote.snapshot.value.body
    : '';
  return h('main', {
    'data-testid': 'editor',
    'data-account': account,
    'data-editor': editorId,
  },
  h('label', null, 'Account ', h('select', {
    'aria-label': 'Account', value: account,
    onChange: event => onAccountChange(event.target.value),
  }, h('option', { value: 'alice' }, 'Alice'), h('option', { value: 'bob' }, 'Bob'))),
  h('label', null, 'Draft body ', h('textarea', {
    'aria-label': 'Draft body', disabled: !recovery.ready,
    value: state.value.body,
    onChange: event => actions?.update({ ...state.value, body: event.target.value }),
  })),
  h('output', { 'data-testid': 'approval' }, state.value.approvalStatus),
  h('output', { 'data-testid': 'status' }, state.status),
  h('output', { 'data-testid': 'error' }, state.error?.code ?? ''),
  h('output', { 'data-testid': 'candidate' }, state.candidate.kind),
  h('output', { 'data-testid': 'dirty' }, String(state.dirty)),
  h('output', { 'data-testid': 'remote-body' }, remoteBody),
  h('output', { 'data-testid': 'document-id' }, state.document.reference.id ?? 'none'),
  h('output', { 'data-testid': 'document-dirty' }, String(state.document.dirty)),
  h('output', { 'data-testid': 'document-saving' }, String(state.document.saving)),
  h('output', { 'data-testid': 'message' }, message),
  h('output', { 'data-testid': 'legacy-cleanup' }, legacyCleanup),
  candidateAvailable && h('button', { onClick: restoreRecoveryDraft }, 'Restore recovery draft'),
  candidateAvailable && legacySelection && h('button', { onClick: restoreLegacy }, 'Use imported legacy draft'),
  h('button', { onClick: () => { void actions?.persistLocal(); } }, 'Persist local copy'),
  h('button', { onClick: () => { void actions?.save(); } }, 'Save remotely'),
  h('button', { onClick: () => { void actions?.retry(); } }, 'Retry remote save'),
  h('button', { onClick: seedLegacyRecord }, 'Seed legacy record'),
  h('button', { onClick: () => { void importLegacyRecord(); } }, 'Import legacy record'),
  h('button', { onClick: () => { void publishDocument(); } }, 'Publish document'),
  h('button', { onClick: () => { void navigate(); } }, 'Navigate next'));
}

function App() {
  const params = new URLSearchParams(location.search);
  const [account, setAccount] = useState(params.get('account') ?? 'alice');
  const [generation, setGeneration] = useState(0);
  const [legacySelection, setLegacySelection] = useState(null);
  const editorId = params.get('editor') ?? 'main';
  const manual = params.get('manual') === '1';
  window.__adoptionAccount = account;
  const finishLegacySelection = useCallback(discovery => {
    discovery.dispose();
    setLegacySelection(current => current?.discovery === discovery ? null : current);
  }, []);
  function changeAccount(value) {
    legacySelection?.discovery.dispose();
    setLegacySelection(null);
    setAccount(value);
  }
  return h(StrictMode, null, h(Editor, {
    key: generation,
    account,
    editorId,
    manual,
    legacySelection,
    onAccountChange: changeAccount,
    onLegacyPrepared: setLegacySelection,
    onLegacySelectionDone: finishLegacySelection,
    onRemount: () => setGeneration(value => value + 1),
  }));
}

createRoot(document.getElementById('root')).render(h(App));
