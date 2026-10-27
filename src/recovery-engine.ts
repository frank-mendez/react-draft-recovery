import type { Failure, Mutation, MutationResult, RecoveryController, RecoveryOptions, RecoveryState, Result, Snapshot } from '../contracts/index.js';
import { createLocalRecovery } from './local-recovery.ts';
import type { LocalStorageAdapter } from './local-recovery.js';

export interface RecoveryEngineOptions<T> extends RecoveryOptions<T> {
  /** Monotonic milliseconds. Defaults to performance.now; never use wall-clock time. */
  readonly now?: () => number;
  /** Must return a globally unique, nonempty ID for every logical mutation. */
  readonly createOperationId?: () => string;
}
const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
const fail = (code: string): Failure => ({ kind: 'permanent', code, message: `Recovery action failed: ${code}.` });
const unavailable = (): Failure => ({ kind: 'retryable', code: 'remote_unavailable', message: 'Remote discovery failed.' });
const uncertain = (): MutationResult<never> => ({ kind: 'unknown', message: 'The remote mutation may have committed.' });

// Codec outputs are detached application values. Freeze ordinary object graphs so
// neither an observer nor an adapter can change a published snapshot/request.
function freeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value && typeof value === 'object' && !seen.has(value)) {
    seen.add(value);
    for (const child of Object.values(value)) freeze(child, seen);
    Object.freeze(value);
  }
  return value;
}
interface Operation<T> {
  readonly kind: 'save' | 'discard';
  readonly request: Mutation & { readonly value?: T };
  readonly generation: number;
  readonly baseEpoch: number;
  readonly started: number;
  attempts: number;
  retryAt: number;
  outcome: 'unknown' | 'retryable' | 'conflict' | null;
}

/** Framework-independent engine. Creation waits only for local discovery. */
export async function createRecovery<T>(options: RecoveryEngineOptions<T>): Promise<Result<RecoveryController<T>>> {
  const { remote, codec, storage } = options;
  const now = options.now ?? (() => performance.now());
  const operationId = options.createOperationId ?? (() => globalThis.crypto.randomUUID());
  if (!storage || ['read', 'write', 'remove'].some(k => typeof storage[k as keyof typeof storage] !== 'function') || (remote && (!Number.isFinite(remote.replayWindowMs) || remote.replayWindowMs <= 0 ||
      ['load', 'save', 'discard'].some(k => typeof remote[k as keyof typeof remote] !== 'function'))) ||
      typeof now !== 'function' || typeof operationId !== 'function') return fail('invalid_options');
  let lastTime: number;
  try { lastTime = now(); if (!Number.isFinite(lastTime)) return fail('invalid_options'); }
  catch { return fail('invalid_options'); }
  // A bad/rolled-back injected clock makes retry safety unprovable. Fail closed.
  let clockFailed = false;
  const time = () => {
    if (clockFailed) return Infinity;
    try {
      const t = now();
      if (!Number.isFinite(t) || t < lastTime) { clockFailed = true; return Infinity; }
      lastTime = t; return t;
    } catch { clockFailed = true; return Infinity; }
  };
  const scope = Object.freeze({ ...options.scope });
  const capture = (value: T): T => {
    try {
      const encoded = codec.encode(value);
      if (encoded.kind === 'ok') {
        const decoded = codec.decode(encoded.value, codec.version);
        if (decoded.kind === 'ok') return freeze(decoded.value);
      }
    } catch { /* Invalid input remains editable; local persistence exposes the error. */ }
    try { return freeze(structuredClone(value)); } catch { return value; }
  };
  // Undefined means initial discovery has not established a base; null means a
  // restored draft has unknown ancestry and needs explicit reconciliation.
  let activeBase: string | null | undefined;
  let baseEpoch = 0;
  let remoteState: RecoveryState<T>['remote'] = remote ? { kind: 'loading' } : { kind: 'disabled' };
  const extended = storage as Partial<LocalStorageAdapter>;
  const localResult = await createLocalRecovery({
    scope, initialValue: capture(options.initialValue), codec,
    storage: {
      read: scope => storage.read(scope),
      write: (scope, record, origin) => (storage as LocalStorageAdapter).write(scope, record, origin),
      remove: (scope, origin) => (storage as LocalStorageAdapter).remove(scope, origin),
      clearUser: user => extended.clearUser ? extended.clearUser.call(storage, user) : Promise.resolve(fail('unsupported')),
      subscribe: (scope, listener) => extended.subscribe ? extended.subscribe.call(storage, scope, listener) : () => {},
    },
  });
  if (localResult.kind !== 'ok') return localResult;
  const local = localResult.value;
  let disposed = false;
  let generation = 0, acknowledged = 0;
  let status: RecoveryState<T>['status'] = remote ? 'loading' : 'idle';
  let remoteError: Failure | null = null;
  let actionError: Failure | null = null;
  let inFlight = false;
  let loading = !!remote;
  let operation: Operation<T> | null = null;
  const usedIds = new Set<string>();
  const listeners = new Set<() => void>();
  let state: RecoveryState<T>;
  let changingLocal = false;
  const publish = () => {
    if (disposed) return;
    const l = local.getSnapshot();
    const error = l.error ?? actionError ?? remoteError;
    state = Object.freeze({ value: l.value, dirty: remote ? generation !== acknowledged : l.dirty,
      candidate: freeze(l.candidate), remote: remoteState,
      status: status === 'idle' && error ? 'error' : status, error });
    for (const listener of [...listeners]) {
      if (disposed) break;
      try { listener(); } catch { /* observers cannot change an operation's outcome */ }
    }
  };
  const unsubscribe = local.subscribe(() => { if (!changingLocal) publish(); });
  publish();

  // Coalesce edits while a storage write is pending; preserve the newest input.
  let localTask: Promise<Result<void>> | null = null;
  let localRequested = false;
  let localRemoval: Promise<Result<void>> | null = null;
  const persistLocal = (): Promise<Result<void>> => {
    if (disposed) return Promise.resolve(fail('disposed'));
    localRequested = true;
    if (localTask) return localTask;
    // Install the guard before storage/codec callbacks can reenter the engine.
    let finish!: (result: Result<void>) => void;
    localTask = new Promise(resolve => { finish = resolve; });
    const task = localTask;
    void (async () => {
      let result: Result<void> = ok(undefined);
      do {
        if (localRemoval) await localRemoval;
        if (disposed) break;
        localRequested = false; result = await local.persist(activeBase ?? null);
      }
      while (localRequested && !disposed);
      localTask = null;
      finish(disposed ? fail('disposed') : result);
    })();
    return task;
  };
  const detached = (value: T): Result<T> => {
    try {
      const encoded = codec.encode(value);
      if (encoded.kind !== 'ok') return encoded;
      if (typeof encoded.value !== 'string') return fail('serialization_failed');
      const decoded = codec.decode(encoded.value, codec.version);
      return decoded.kind === 'ok' ? ok(freeze(decoded.value)) : decoded;
    } catch { return fail('serialization_failed'); }
  };
  const snapshot = (value: Snapshot<T>): Result<Snapshot<T>> => {
    if (!value || typeof value.revision !== 'string' || !value.revision.length) return fail('invalid_remote_response');
    if (value.kind === 'absent') return ok(Object.freeze({ kind: 'absent', revision: value.revision }));
    if (value.kind !== 'present') return fail('invalid_remote_response');
    const data = detached(value.value);
    return data.kind === 'ok' ? ok(Object.freeze({ kind: 'present', revision: value.revision, value: data.value })) : data;
  };
  const load = async (): Promise<Result<Snapshot<T>>> => {
    loading = true; status = 'loading'; remoteState = Object.freeze({ kind: 'loading' }); publish();
    if (disposed) return fail('disposed');
    let result: Result<Snapshot<T>>;
    try { const response = await remote!.load(scope); result = response.kind === 'ok' ? snapshot(response.value) : response; }
    catch { result = unavailable(); }
    if (disposed) return fail('disposed');
    loading = false;
    if (result.kind === 'ok' && activeBase === undefined) activeBase = result.value.revision;
    remoteError = result.kind === 'ok' ? null : result;
    remoteState = Object.freeze(result.kind === 'ok' ? { kind: 'ready', snapshot: result.value } : { kind: 'failed', error: result });
    status = result.kind === 'ok' ? 'idle' : 'error'; publish();
    return result;
  };
  const expired = (op: Operation<T>) => time() - op.started >= remote!.replayWindowMs * 0.9;
  const guard = (kind: 'save' | 'discard' | 'retry'): Failure | null => {
    if (disposed) return fail('disposed');
    if (!remote) return fail('remote_unavailable');
    if (kind !== 'retry' && (operation?.outcome === 'unknown' || operation?.outcome === 'retryable')) return fail('operation_unresolved');
    if (kind !== 'retry' && operation?.outcome === 'conflict') return fail('reconciliation_required');
    if (remoteState.kind !== 'ready') return fail('remote_not_ready');
    if (inFlight) return fail('operation_in_progress');
    if (kind !== 'retry' && activeBase === null) return fail('reconciliation_required');
    if (kind === 'retry') {
      if (!operation || !['unknown', 'retryable'].includes(operation.outcome ?? '')) return fail('no_pending_operation');
      const currentTime = time();
      if (!Number.isFinite(currentTime) || currentTime - operation.started >= remote.replayWindowMs * 0.9) return fail('replay_window_expired');
      if (currentTime < operation.retryAt) return fail('retry_not_ready');
    }
    return null;
  };
  const dispatch = async (op: Operation<T>): Promise<MutationResult<T>> => {
    inFlight = true; op.outcome = null; op.attempts++;
    status = op.kind === 'save' ? 'saving' : 'discarding'; remoteError = null; actionError = null; publish();
    if (disposed) return fail('disposed');
    let result: MutationResult<T>;
    try {
      result = op.kind === 'save'
        ? await remote!.save(op.request as Mutation & { readonly value: T })
        : await remote!.discard(op.request);
      if (result.kind === 'ok') {
        const checked = snapshot(result.value);
        // A malformed success cannot prove that the backend did not commit.
        result = checked.kind === 'ok' && checked.value.kind === (op.kind === 'save' ? 'present' : 'absent') ? checked : uncertain();
      } else if (result.kind === 'conflict') {
        const checked = snapshot(result.current);
        result = checked.kind === 'ok' ? { kind: 'conflict', current: checked.value } : uncertain();
      }
    } catch { result = uncertain(); }
    if (disposed) return fail('disposed');
    switch (result.kind) {
      case 'ok':
        remoteState = Object.freeze({ kind: 'ready', snapshot: result.value });
        if (op.kind === 'save') acknowledged = op.generation;
        if (op.baseEpoch === baseEpoch) {
          activeBase = result.value.revision;
          // Serialize behind pending local writes and preserve any newer edits.
          // A restored candidate has its own ancestry and must not be rebased.
          if (op.kind === 'save') await persistLocal();
          if (disposed) return fail('disposed');
        }
        operation = null; status = 'idle'; break;
      case 'conflict':
        op.outcome = 'conflict'; status = 'conflict';
        remoteState = Object.freeze({ kind: 'ready', snapshot: result.current }); break;
      case 'unknown': case 'retryable': {
        op.outcome = result.kind; status = result.kind === 'unknown' ? 'unknown' : 'error';
        remoteError = result.kind === 'retryable' ? result : null;
        const requested = result.kind === 'retryable' ? result.retryAfterMs ?? 0 : 0;
        const backoff = Math.min(30000, 250 * 2 ** Math.min(op.attempts - 1, 7));
        op.retryAt = time() + Math.max(backoff, Number.isFinite(requested) && requested > 0 ? requested : 0);
        break;
      }
      case 'permanent': operation = null; status = 'error'; remoteError = result; break;
    }
    inFlight = false; publish(); return result;
  };
  const mutate = (kind: 'save' | 'discard'): Promise<MutationResult<T>> => {
    const blocked = guard(kind); if (blocked) return Promise.resolve(blocked);
    // Guard codec/ID callbacks as well as adapter calls and notifications.
    inFlight = true;
    const savedGeneration = generation;
    const savedBaseEpoch = baseEpoch;
    const expectedRevision = activeBase!;
    const data = kind === 'save' ? detached(state.value) : ok(undefined);
    let id = '';
    try { id = operationId(); } catch { /* reported below */ }
    if (disposed) return Promise.resolve(fail('disposed'));
    if (data.kind !== 'ok' || typeof id !== 'string' || !id.length || usedIds.has(id)) {
      const error = data.kind !== 'ok' ? data : fail('invalid_operation_id');
      inFlight = false; actionError = error; publish();
      return Promise.resolve(error);
    }
    const started = time();
    if (!Number.isFinite(started)) { inFlight = false; return Promise.resolve(fail('invalid_clock')); }
    usedIds.add(id);
    const request = Object.freeze({ scope, operationId: id,
      expectedRevision,
      ...(kind === 'save' ? { value: data.value as T } : {}) });
    operation = { kind, request, generation: savedGeneration, baseEpoch: savedBaseEpoch, started, attempts: 0, retryAt: 0, outcome: null };
    return dispatch(operation);
  };
  const controller: RecoveryController<T> = {
    getSnapshot: () => state,
    subscribe(listener) { if (disposed) throw new Error('Recovery controller is disposed'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(value) {
      if (disposed) throw new Error('Recovery controller is disposed');
      const captured = capture(value);
      if (remote && activeBase === undefined) activeBase = null;
      generation++; changingLocal = true;
      try { local.update(captured); } finally { changingLocal = false; }
      publish(); void persistLocal();
    },
    restore() {
      if (disposed) throw new Error('Recovery controller is disposed');
      const available = local.getSnapshot().candidate.kind === 'available';
      changingLocal = true;
      let result: Result<void>;
      try { result = local.restore(); } finally { changingLocal = false; }
      if (result.kind !== 'ok') actionError = result;
      else if (available) {
        generation++; baseEpoch++; activeBase = local.getSnapshot().baseRevision; actionError = null;
      }
      publish(); if (result.kind === 'ok' && available) void persistLocal();
    },
    save: () => mutate('save'),
    discardRemote: () => mutate('discard'),
    retry() { const blocked = guard('retry'); return blocked ? Promise.resolve(blocked) : dispatch(operation!); },
    persistLocal,
    async refreshLocal() {
      // Finish this session's queued writes/removal before comparing stored data.
      while (localTask || localRemoval) await (localTask ?? localRemoval);
      if (disposed) return fail('disposed');
      return local.refresh(true);
    },
    discardLocal() {
      if (disposed) return Promise.resolve(fail('disposed'));
      if (localTask || localRemoval) return Promise.resolve(fail('operation_in_progress'));
      let finish!: (result: Result<void>) => void;
      localRemoval = new Promise(resolve => { finish = resolve; });
      const task = localRemoval;
      void local.discard().then(result => {
        localRemoval = null; finish(disposed ? fail('disposed') : result);
      });
      return task;
    },
    reloadRemote() {
      if (disposed) return Promise.resolve(fail('disposed'));
      if (!remote) return Promise.resolve(fail('remote_unavailable'));
      if (loading || inFlight || operation || !['idle', 'error'].includes(status)) return Promise.resolve(fail('operation_in_progress'));
      return load();
    },
    reconcile(current, value) {
      if (disposed) return fail('disposed');
      if (!remote || inFlight || loading || !(activeBase === null && !operation || operation && (operation.outcome === 'conflict' ||
        ((operation.outcome === 'unknown' || operation.outcome === 'retryable') && expired(operation))))) return fail('invalid_reconciliation_state');
      const checked = snapshot(current); if (checked.kind !== 'ok') return checked;
      operation = null; activeBase = checked.value.revision; baseEpoch++;
      remoteState = Object.freeze({ kind: 'ready', snapshot: checked.value });
      remoteError = null; actionError = null; status = 'idle';
      controller.update(value); return ok(undefined);
    },
    dispose() {
      if (disposed) return;
      disposed = true; localRequested = false; unsubscribe(); local.dispose(); listeners.clear();
    },
  };
  if (remote) void load();
  return ok(controller);
}
