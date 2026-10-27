'use client';

import { useEffect, useMemo, useSyncExternalStore } from 'react';
import { createRecovery } from '../src/recovery-engine.ts';
import type { RecoveryEngineOptions } from '../src/recovery-engine.ts';
import type { Failure, RecoveryController, RecoveryState } from '../contracts/index.ts';

export type RecoveryActions<T> = Omit<RecoveryController<T>, 'getSnapshot' | 'subscribe' | 'dispose'>;
export type DraftRecovery<T> =
  | { readonly ready: false; readonly state: RecoveryState<T>; readonly actions: null }
  | { readonly ready: true; readonly state: RecoveryState<T>; readonly actions: RecoveryActions<T> };
export type { RecoveryEngineOptions };

// Pure allocation: abandoned renders and SSR never start I/O or subscriptions.
function session<T>(options: RecoveryEngineOptions<T>) {
  const initial: DraftRecovery<T> = { ready: false, actions: null, state: {
    value: options.initialValue, dirty: false, candidate: { kind: 'none' },
    remote: options.remote ? { kind: 'loading' } : { kind: 'disabled' }, status: 'loading', error: null,
  } };
  let snapshot: DraftRecovery<T> = initial;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      let active = true;
      let controller: RecoveryController<T> | undefined;
      let unsubscribe: (() => void) | undefined;
      snapshot = initial; emit();
      const failed = (error: Failure) => {
        if (!active) return;
        snapshot = { ready: false, actions: null, state: { ...initial.state, status: 'error', error } }; emit();
      };
      void createRecovery(options).then(result => {
        if (result.kind !== 'ok') { failed(result); return; }
        if (!active) { result.value.dispose(); return; }
        controller = result.value;
        const { getSnapshot, subscribe, dispose: _dispose, ...actions } = controller;
        const publish = () => {
          if (!active) return;
          snapshot = { ready: true, state: getSnapshot(), actions }; emit();
        };
        unsubscribe = subscribe(publish);
        publish();
      }).catch(() => failed({ kind: 'permanent', code: 'initialization_failed', message: 'Recovery initialization failed.' }));
      return () => { active = false; unsubscribe?.(); controller?.dispose(); };
    },
  };
}

/** Initial value is a seed per scope/adapter session, not a controlled value. */
export function useDraftRecovery<T>(options: RecoveryEngineOptions<T>): DraftRecovery<T> {
  const { scope, storage, codec, remote, now, createOperationId } = options;
  const store = useMemo(() => session({ ...options, scope: { ...scope } }),
    [scope.userId, scope.documentId, scope.editorId, storage, codec, remote, now, createOperationId]);
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => store.start(), [store]);
  return value;
}
