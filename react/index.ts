'use client';

import { useEffect, useState, useSyncExternalStore } from 'react';
import { createRecovery } from '../src/recovery-engine.ts';
import type { RecoveryEngineOptions } from '../src/recovery-engine.ts';
import type { LocalStorageAdapter, StorageChange } from '../src/local-recovery.ts';
import type { Failure, RecoveryController, RecoveryState, Scope } from '../contracts/index.ts';

export type RecoveryActions<T> = Omit<RecoveryController<T>, 'getSnapshot' | 'subscribe' | 'dispose' | 'refreshLocal'>;
export type DraftRecovery<T> =
  | { readonly ready: false; readonly state: RecoveryState<T>; readonly actions: null }
  | { readonly ready: true; readonly state: RecoveryState<T>; readonly actions: RecoveryActions<T> };
export type { RecoveryEngineOptions };

// Pure allocation. React owns the session's memory; effects own its connections.
// Cleanup cannot distinguish an unmount from Activity/Fast Refresh effect replay.
function session<T>(options: RecoveryEngineOptions<T>) {
  const initial: DraftRecovery<T> = { ready: false, actions: null, state: {
    value: options.initialValue, dirty: false, candidate: { kind: 'none' },
    remote: options.remote ? { kind: 'loading' } : { kind: 'disabled' }, status: 'loading', error: null,
  } };
  let snapshot: DraftRecovery<T> = initial;
  let active = false;
  let usable = false;
  let epoch = 0;
  let controller: RecoveryController<T> | undefined;
  let opening: ReturnType<typeof createRecovery<T>> | undefined;
  let actions: RecoveryActions<T>;
  let warned = false;
  let started = false;
  let connectionError: Failure | null = null;
  const listeners = new Set<() => void>();
  const emit = () => { for (const listener of listeners) listener(); };
  const subscriptions = new Set<{ scope: Scope; listener: (change: StorageChange) => void; stop?: () => void }>();
  const storage = options.storage as LocalStorageAdapter;
  const connect = (entry: { scope: Scope; listener: (change: StorageChange) => void; stop?: () => void }) => {
    if (entry.stop || !storage.subscribe) return;
    entry.stop = storage.subscribe(entry.scope, change => { if (active) entry.listener(change); });
  };
  const disconnect = (entry: { stop?: () => void }) => {
    const stop = entry.stop; delete entry.stop;
    try { stop?.(); }
    catch { connectionError = { kind: 'permanent', code: 'notifications_unavailable', message: 'Draft notifications could not be disconnected.' }; }
  };
  // Preserve validation of invalid adapters instead of masking missing methods.
  const engineOptions = !storage || ['read', 'write', 'remove'].some(key => typeof storage[key as keyof LocalStorageAdapter] !== 'function') ? options : {
    ...options,
    storage: {
      read: (scope: Scope) => storage.read(scope),
      write: (...args: Parameters<LocalStorageAdapter['write']>) => usable ? storage.write(...args) : Promise.resolve({ kind: 'retryable' as const, code: 'inactive_session', message: 'Local persistence paused while the editor is disconnected; retry after reconnecting.' }),
      remove: (...args: Parameters<LocalStorageAdapter['remove']>) => storage.remove(...args),
      subscribe(scope: Scope, listener: (change: StorageChange) => void) {
        const entry: { scope: Scope; listener: (change: StorageChange) => void; stop?: () => void } = { scope, listener };
        if (active) connect(entry);
        subscriptions.add(entry);
        return () => { subscriptions.delete(entry); disconnect(entry); };
      },
    },
  };
  const failed = (error: Failure) => {
    snapshot = { ready: false, actions: null, state: { ...(controller?.getSnapshot() ?? initial.state), status: 'error', error } }; emit();
  };
  return {
    getSnapshot: () => snapshot,
    getServerSnapshot: () => initial,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    checkConfiguration(next: RecoveryEngineOptions<T>) {
      if (!warned && (['storage', 'codec', 'remote', 'now', 'createOperationId'] as const).some(key => next[key] !== options[key])) {
        warned = true;
        console.warn('useDraftRecovery: configuration changes within a scope are ignored. Use stable configuration references, or remount with a new React key to apply changes.');
      }
    },
    start() {
      active = true; usable = false;
      const ticket = ++epoch;
      let unsubscribe: (() => void) | undefined;
      const current = () => active && ticket === epoch;
      const refresh = started;
      started = true;
      const publish = () => {
        if (!current() || !controller) return;
        if (connectionError) { failed(connectionError); return; }
        snapshot = { ready: true, state: controller.getSnapshot(), actions }; emit();
      };
      void (async () => {
        for (const entry of subscriptions) connect(entry);
        opening ??= createRecovery(engineOptions);
        const result = await opening;
        if (result.kind !== 'ok') { if (current()) failed(result); return; }
        controller = result.value;
        if (!actions) {
          const inactive = (): Failure => ({ kind: 'permanent', code: 'inactive_session', message: 'The editor session is disconnected.' });
          actions = {
            update(value) { if (usable) controller!.update(value); },
            restore() { if (usable) controller!.restore(); },
            reconcile: (revision, value) => usable ? controller!.reconcile(revision, value) : inactive(),
            save: () => usable ? controller!.save() : Promise.resolve(inactive()),
            retry: () => usable ? controller!.retry() : Promise.resolve(inactive()),
            persistLocal: () => usable ? controller!.persistLocal() : Promise.resolve(inactive()),
            discardLocal: () => usable ? controller!.discardLocal() : Promise.resolve(inactive()),
            discardRemote: () => usable ? controller!.discardRemote() : Promise.resolve(inactive()),
            reloadRemote: () => usable ? controller!.reloadRemote() : Promise.resolve(inactive()),
          };
        }
        if (!current()) return;
        if (refresh) {
          snapshot = { ready: false, actions: null, state: controller.getSnapshot() }; emit();
          await controller.refreshLocal();
          if (!current()) return;
        }
        usable = true;
        unsubscribe = controller.subscribe(publish);
        publish();
      })().catch(() => { if (current()) failed({ kind: 'permanent', code: 'initialization_failed', message: 'Recovery initialization or reconnection failed.' }); });
      return () => {
        active = false; usable = false; epoch++;
        unsubscribe?.();
        for (const entry of subscriptions) disconnect(entry);
        // Keep controller state and outstanding operations for a possible reveal.
        // No external listener retains the session after a successful disconnect.
      };
    },
  };
}

/** Configuration and initialValue are captured per scope; use a key to reset. */
export function useDraftRecovery<T>(options: RecoveryEngineOptions<T>): DraftRecovery<T> {
  const key = JSON.stringify([options.scope.userId, options.scope.documentId, options.scope.editorId]);
  const create = () => ({ key, store: session({ ...options, scope: { ...options.scope } }) });
  const [saved, setSaved] = useState(create);
  let selected = saved;
  if (saved.key !== key) { selected = create(); setSaved(selected); }
  const store = selected.store;
  const value = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  useEffect(() => store.start(), [store]);
  useEffect(() => store.checkConfiguration(options));
  return value;
}
