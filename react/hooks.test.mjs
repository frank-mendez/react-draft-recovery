import assert from 'node:assert/strict';
import test from 'node:test';
import * as React from 'react';
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

test('invalid initialization exposes an error and a keyed remount retries configuration', async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  try {
    await act(async () => root.render(h(Editor, { options: { ...f.options, storage: {} } })));
    assert.equal(latest.ready, false); assert.equal(latest.state.status, 'error');
    assert.equal(latest.state.error.code, 'invalid_options');
    await act(async () => root.render(h(Editor, { key: 'fixed', options: f.options })));
    assert.equal(latest.ready, true); assert.equal(latest.state.error, null);
  } finally { await act(async () => root.unmount()); d.close(); }
});


test('Activity hide/reveal preserves edits and pending writes without creating a recovery candidate', { skip: !React.Activity }, async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  const write = f.options.storage.write; let release;
  f.options.storage.write = async (...args) => { await new Promise(resolve => { release = resolve; }); return write(...args); };
  const show = mode => h(React.Activity, { mode }, h(Editor, { options: f.options }));
  try {
    await act(async () => root.render(show('visible')));
    await act(async () => latest.actions.update('typed'));
    await act(async () => root.render(show('hidden')));
    assert.equal(f.subscriptions.size, 0);
    await act(async () => release());
    await act(async () => root.render(show('visible')));
    assert.equal(latest.state.value, 'typed');
    assert.equal(latest.state.candidate.kind, 'none');
    assert.equal(f.subscriptions.size, 1);
    f.options.storage.write = write;
    await act(async () => { latest.actions.update('continued'); await latest.actions.persistLocal(); });
    assert.equal(f.records.get('a').payload, '"continued"');
  } finally { await act(async () => root.unmount()); d.close(); }
});

test('inline configuration does not restart discovery or erase edits and warns once', async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  const warnings = []; const warn = console.warn; console.warn = message => warnings.push(message);
  let renders = 0;
  function InlineEditor() {
    // Bound the old restart loop so this regression fails rather than hanging.
    if (++renders > 12) throw new Error('Configuration restart loop');
    return Editor({ options: { ...f.options, storage: { ...f.options.storage }, codec: { ...f.options.codec }, now: () => 0, createOperationId: () => 'id' } });
  }
  try {
    await act(async () => root.render(h(InlineEditor)));
    await act(async () => latest.actions.update('typed inline'));
    await act(async () => root.render(h(InlineEditor)));
    assert.equal(latest.state.value, 'typed inline'); assert.equal(f.reads(), 1);
    assert.equal(warnings.length, 1); assert.match(warnings[0], /configuration.*remount/i);
  } finally { console.warn = warn; await act(async () => root.unmount()); d.close(); }
});

test('Activity retains unresolved remote mutations and retries the original request', { skip: !React.Activity }, async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  let clock = 0; let id = 0; const requests = [];
  f.options.now = () => clock; f.options.createOperationId = () => String(++id);
  f.options.remote = {
    replayWindowMs: 10000,
    async load() { return ok({ kind: 'absent', revision: '0' }); },
    async save(request) {
      requests.push(request);
      return requests.length === 1 ? { kind: 'unknown', message: 'Lost response' } : ok({ kind: 'present', revision: '1', value: request.value });
    },
    async discard() { return ok({ kind: 'absent', revision: '2' }); },
  };
  const show = mode => h(React.Activity, { mode }, h(Editor, { options: f.options }));
  try {
    await act(async () => root.render(show('visible')));
    await act(async () => { latest.actions.update('submitted'); await latest.actions.save(); latest.actions.update('newer'); });
    const oldActions = latest.actions;
    await act(async () => root.render(show('hidden')));
    assert.equal((await oldActions.save()).code, 'inactive_session');
    await act(async () => root.render(show('visible')));
    assert.equal(latest.state.status, 'unknown'); assert.equal(latest.state.value, 'newer');
    clock = 250;
    await act(async () => { await latest.actions.retry(); });
    assert.deepEqual(requests[1], requests[0]); assert.equal(latest.state.value, 'newer'); assert.equal(latest.state.dirty, true);
  } finally { await act(async () => root.unmount()); d.close(); }
});

test('Activity rechecks missed competing storage changes before allowing persistence', { skip: !React.Activity }, async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  const show = mode => h(React.Activity, { mode }, h(Editor, { options: f.options }));
  try {
    await act(async () => root.render(show('visible')));
    await act(async () => latest.actions.update('mine'));
    await act(async () => root.render(show('hidden')));
    f.records.set('a', { ...f.records.get('a'), payload: '"theirs"' });
    await act(async () => root.render(show('visible')));
    assert.equal(latest.state.value, 'mine'); assert.equal(latest.state.candidate.value, 'theirs');
    await act(async () => { assert.equal((await latest.actions.persistLocal()).code, 'recovery_pending'); });
    assert.equal(f.records.get('a').payload, '"theirs"');
  } finally { await act(async () => root.unmount()); d.close(); }
});

test('Activity retains input when its local write fails while hidden', { skip: !React.Activity }, async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container); let release;
  f.options.storage.write = () => new Promise(resolve => { release = resolve; });
  const show = mode => h(React.Activity, { mode }, h(Editor, { options: f.options }));
  try {
    await act(async () => root.render(show('visible')));
    await act(async () => latest.actions.update('only in memory'));
    await act(async () => root.render(show('hidden')));
    await act(async () => release({ kind: 'retryable', code: 'storage_quota', message: 'Full' }));
    await act(async () => root.render(show('visible')));
    assert.equal(latest.state.value, 'only in memory'); assert.equal(latest.state.error.code, 'storage_quota');
    assert.equal(latest.state.candidate.kind, 'none');
  } finally { await act(async () => root.unmount()); d.close(); }
});

test('reveal does not drain a queued edit over an unseen competing record', { skip: !React.Activity }, async () => {
  const f = fixture(); const d = dom(); const root = createRoot(d.container);
  const write = f.options.storage.write; let acknowledge;
  f.options.storage.write = async (...args) => { await write(...args); await new Promise(resolve => { acknowledge = resolve; }); return ok(); };
  const show = mode => h(React.Activity, { mode }, h(Editor, { options: f.options }));
  try {
    await act(async () => root.render(show('visible')));
    await act(async () => latest.actions.update('first'));
    await act(async () => latest.actions.update('queued'));
    await act(async () => root.render(show('hidden')));
    f.records.set('a', { ...f.records.get('a'), payload: '"competing"' });
    await act(async () => root.render(show('visible')));
    assert.equal(latest.actions, null);
    await act(async () => acknowledge());
    assert.equal(latest.state.value, 'queued');
    assert.equal(f.records.get('a').payload, '"competing"');
    assert.equal(latest.state.candidate.value, 'competing');
    await act(async () => { assert.equal((await latest.actions.persistLocal()).code, 'recovery_pending'); });
  } finally { await act(async () => root.unmount()); d.close(); }
});
