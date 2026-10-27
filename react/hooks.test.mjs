import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement as h, StrictMode, act } from 'react';
import { renderToString } from 'react-dom/server';
import { createRoot, hydrateRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { useDraftRecovery } from './index.ts';

const ok = value => ({ kind: 'ok', value });
function fixture() {
  const records = new Map(); const subscriptions = new Set(); let reads = 0;
  const options = {
    scope: { userId: 'u', documentId: 'a', editorId: 'e' }, initialValue: 'initial',
    codec: { version: 1, encode: value => ok(JSON.stringify(value)), decode: payload => ok(JSON.parse(payload)) },
    storage: {
      async read(scope) { reads++; return ok(records.get(scope.documentId) ?? null); },
      async write(scope, record) { records.set(scope.documentId, record); return ok(); },
      async remove(scope) { records.delete(scope.documentId); return ok(); },
      subscribe(scope, listener) { subscriptions.add(listener); return () => subscriptions.delete(listener); },
    },
  };
  return { options, records, subscriptions, reads: () => reads };
}
function dom() {
  const d = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  globalThis.window = d.window; globalThis.document = d.window.document;
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  return { container: document.getElementById('root'), close() { d.window.close(); delete globalThis.window; delete globalThis.document; } };
}
let latest;
function Editor({ options }) {
  latest = useDraftRecovery(options);
  return h('p', null, latest.state.value + ':' + latest.state.status);
}

test('SSR imports and rendering do not access browser storage or start discovery', () => {
  assert.equal(typeof window, 'undefined');
  const f = fixture();
  assert.equal(renderToString(h(Editor, { options: f.options })), '<p>initial:loading</p>');
  assert.equal(f.reads(), 0); assert.equal(latest.actions, null);
});

test('hydrates initial markup before discovering local recovery', async () => {
  const f = fixture();
  f.records.set('a', { formatVersion: 1, scope: f.options.scope, baseRevision: null, dataVersion: 1, payload: '"recovered"', savedAt: new Date().toISOString() });
  const markup = renderToString(h(Editor, { options: f.options }));
  const d = dom(); d.container.innerHTML = markup; const errors = []; let root;
  try {
    await act(async () => { root = hydrateRoot(d.container, h(Editor, { options: f.options }), { onRecoverableError: e => errors.push(e) }); });
    assert.deepEqual(errors, []); assert.equal(latest.state.value, 'initial');
    assert.equal(latest.state.candidate.kind, 'available');
    await act(async () => latest.actions.restore());
    assert.equal(d.container.textContent, 'recovered:idle');
    await act(async () => { await latest.actions.discardLocal(); });
    assert.equal(f.records.has('a'), false);
  } finally { await act(async () => root?.unmount()); d.close(); }
});

test('Strict Mode replay leaves one live subscription and cleans up on unmount', async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  try {
    await act(async () => root.render(h(StrictMode, null, h(Editor, { options: f.options }))));
    assert.equal(f.subscriptions.size, 1);
    await act(async () => latest.actions.update('edited'));
    assert.equal(latest.state.value, 'edited'); assert.equal(f.records.get('a').payload, '"edited"');
    const reads = f.reads();
    await act(async () => root.render(h(StrictMode, null, h(Editor, { options: { ...f.options, scope: { ...f.options.scope }, initialValue: 'ignored' } }))));
    assert.equal(f.reads(), reads); assert.equal(latest.state.value, 'edited');
  } finally { await act(async () => root.unmount()); d.close(); }
  assert.equal(f.subscriptions.size, 0);
});

test('scope changes isolate state and late discovery; unmount during discovery cleans up', async () => {
  const f = fixture(); const original = f.options.storage.read; let release;
  f.options.storage.read = scope => scope.documentId === 'a' ? new Promise(resolve => { release = resolve; }) : original(scope);
  const d = dom(); const root = createRoot(d.container);
  try {
    await act(async () => root.render(h(Editor, { options: f.options })));
    assert.equal(latest.actions, null);
    await act(async () => root.render(h(Editor, { options: { ...f.options, scope: { ...f.options.scope, documentId: 'b' }, initialValue: 'B' } })));
    await act(async () => latest.actions.update('B edited'));
    await act(async () => release(ok(null)));
    assert.equal(latest.state.value, 'B edited'); assert.equal(f.subscriptions.size, 1);
    assert.equal(f.records.has('a'), false); assert.equal(f.records.get('b').payload, '"B edited"');
    await act(async () => root.render(h(Editor, { options: f.options })));
    await act(async () => root.unmount());
    await act(async () => release(ok(null)));
    assert.equal(f.subscriptions.size, 0);
  } finally { await act(async () => root.unmount()); d.close(); }
});

test('typed actions expose retry and conflict reconciliation without replacing edits', async () => {
  const f = fixture(); let clock = 0; let attempt = 0; let id = 0; const requests = [];
  f.options.now = () => clock; f.options.createOperationId = () => String(++id);
  f.options.remote = {
    replayWindowMs: 10000,
    async load() { return ok({ kind: 'absent', revision: '0' }); },
    async save(request) {
      requests.push(request);
      if (++attempt === 1) return { kind: 'unknown', message: 'Lost response' };
      if (attempt === 2) return ok({ kind: 'present', revision: '1', value: request.value });
      return { kind: 'conflict', current: { kind: 'present', revision: '2', value: 'other' } };
    },
    async discard() { return ok({ kind: 'absent', revision: '3' }); },
  };
  const d = dom(); const root = createRoot(d.container);
  try {
    await act(async () => root.render(h(Editor, { options: f.options })));
    await act(async () => { latest.actions.update('first'); await latest.actions.save(); });
    assert.equal(latest.state.status, 'unknown');
    await act(async () => latest.actions.update('newer'));
    clock = 250;
    await act(async () => { await latest.actions.retry(); });
    assert.deepEqual(requests[0], requests[1]); assert.equal(latest.state.value, 'newer'); assert.equal(latest.state.dirty, true);
    await act(async () => { await latest.actions.save(); });
    assert.equal(latest.state.status, 'conflict'); assert.equal(latest.state.value, 'newer');
    await act(async () => { assert.equal(latest.actions.reconcile(latest.state.remote.snapshot, 'merged').kind, 'ok'); });
    assert.equal(latest.state.value, 'merged'); assert.equal(latest.state.status, 'idle');
  } finally { await act(async () => root.unmount()); d.close(); }
});

test('invalid initialization exposes an error and replacing the adapter starts a new session', async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  try {
    await act(async () => root.render(h(Editor, { options: { ...f.options, storage: {} } })));
    assert.equal(latest.ready, false); assert.equal(latest.state.status, 'error');
    assert.equal(latest.state.error.code, 'invalid_options');
    await act(async () => root.render(h(Editor, { options: f.options })));
    assert.equal(latest.ready, true); assert.equal(latest.state.error, null);
  } finally { await act(async () => root.unmount()); d.close(); }
});
