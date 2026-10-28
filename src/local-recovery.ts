import { isScope, validateRecord } from './local-record.ts';
import type { DiscoveryAdapter, DiscoveryImportStorage, DiscoveryQuery } from './recovery-discovery.ts';
import type { Codec, Failure, LocalRecord, Result, Scope, StorageAdapter } from '../contracts/index.js';

const prefix = 'react-draft-recovery:';
const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
const failure = (code: string, message: string): Failure => ({ kind: 'permanent', code, message });
const retryable = (code: string, message: string): Failure => ({ kind: 'retryable', code, message });
const disposedError = () => failure('disposed', 'The recovery session is disposed.');
/** A stable namespace plus an exact JSON tuple, never delimiter concatenation. */
export function storageKey(scope: Scope): string {
  if (!isScope(scope)) throw new TypeError('Invalid scope');
  return prefix + JSON.stringify([scope.userId, scope.documentId, scope.editorId]);
}
function keyScope(key: string): Scope | null {
  if (!key.startsWith(prefix)) return null;
  try {
    const tuple: unknown = JSON.parse(key.slice(prefix.length));
    if (!Array.isArray(tuple) || tuple.length !== 3 || !tuple.every(v => typeof v === 'string')) return null;
    const scope = { userId: tuple[0], documentId: tuple[1], editorId: tuple[2] };
    return storageKey(scope) === key ? scope : null;
  } catch { return null; }
}
function storageFailure(error: unknown): Failure {
  return error && typeof error === 'object' && 'name' in error && error.name === 'QuotaExceededError'
    ? retryable('storage_quota', 'Draft storage quota was exceeded; free space and retry.')
    : retryable('storage_unavailable', 'Draft storage is unavailable; retry when access is restored.');
}
export interface StorageChange {
  readonly kind: 'changed' | 'logout';
  readonly origin?: symbol;
}
export interface LocalStorageAdapter extends StorageAdapter {
  /** Optional cross-writer enumeration; existing custom adapters need not implement it. */
  readonly discovery?: DiscoveryAdapter & DiscoveryImportStorage;
  write(scope: Scope, record: LocalRecord, origin?: symbol): Promise<Result<void>>;
  remove(scope: Scope, origin?: symbol): Promise<Result<void>>;
  /** Removes all owned keys for this account, even when their payload is corrupt. */
  clearUser(userId: string): Promise<Result<void>>;
  subscribe(scope: Scope, listener: (change: StorageChange) => void): () => void;
}
export interface BrowserStorageOptions {
  readonly getStorage?: () => Storage;
  readonly events?: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
}

/** No browser globals are accessed until an operation or subscription occurs. */
export function createLocalStorageAdapter(options: BrowserStorageOptions = {}): LocalStorageAdapter & { readonly discovery: DiscoveryAdapter & DiscoveryImportStorage } {
  const getStorage = options.getStorage ?? (() => globalThis.localStorage);
  const listeners = new Set<{ scope: Scope; listener: (change: StorageChange) => void }>();
  const notify = (matches: (scope: Scope) => boolean, change: StorageChange) => {
    for (const entry of [...listeners]) if (matches(entry.scope)) {
      // An observer must not turn a committed storage write into a reported failure.
      try { entry.listener(change); } catch { /* isolate application observers */ }
    }
  };
  const matches = (scope: Scope, query: DiscoveryQuery) => scope.userId === query.userId &&
    (query.documentId === undefined || scope.documentId === query.documentId);
  const readEntry = (storage: Storage, query: DiscoveryQuery, id: string) => {
    const scope = keyScope(id);
    if (!scope || !matches(scope, query)) return null;
    const raw = storage.getItem(id);
    if (raw === null) return null;
    try {
      const record = validateRecord(JSON.parse(raw), scope);
      return record.kind === 'ok' ? { id, revision: raw, record: record.value } : null;
    } catch { return null; }
  };
  return {
    discovery: {
      async list(query) {
        try {
          const storage = getStorage();
          const keys = new Set<string>();
          for (let i = 0; i < storage.length; i++) {
            const key = storage.key(i);
            if (key !== null) keys.add(key);
          }
          const entries = [];
          for (const key of [...keys].sort()) {
            const entry = readEntry(storage, query, key);
            if (entry) entries.push(entry);
          }
          return ok(entries);
        } catch (error) { return storageFailure(error); }
      },
      async read(query, id) {
        try { return ok(readEntry(getStorage(), query, id)); }
        catch (error) { return storageFailure(error); }
      },
      async remove(query, id, revision) {
        try {
          const scope = keyScope(id);
          if (!scope || !matches(scope, query)) return failure('unauthorized_candidate', 'Candidate is outside this account or document.');
          const storage = getStorage();
          if (storage.getItem(id) !== revision) return failure('candidate_changed', 'Refresh before acting on an updated candidate.');
          storage.removeItem(id);
          notify(s => storageKey(s) === id, { kind: 'changed' });
          return ok(undefined);
        } catch (error) { return storageFailure(error); }
      },
      async writeIfAbsent(scope, record) {
        try {
          if (validateRecord(record, scope).kind !== 'ok') return failure('invalid_envelope', 'Invalid draft envelope.');
          const key = storageKey(scope);
          const storage = getStorage();
          if (storage.getItem(key) !== null) return failure('destination_exists', 'Import requires an unused writer key.');
          storage.setItem(key, JSON.stringify(record));
          notify(s => storageKey(s) === key, { kind: 'changed' });
          return ok(undefined);
        } catch (error) { return storageFailure(error); }
      },
    },
    async read(scope) {
      try {
        const raw = getStorage().getItem(storageKey(scope));
        if (raw === null) return ok(null);
        try {
          const value: unknown = JSON.parse(raw);
          return value === null ? failure('invalid_envelope', 'Invalid draft envelope.') : ok(value);
        }
        catch { return failure('invalid_envelope', 'The stored draft is not valid JSON.'); }
      } catch (error) { return storageFailure(error); }
    },
    async write(scope, record, origin) {
      try {
        const key = storageKey(scope);
        if (validateRecord(record, scope).kind !== 'ok') return failure('invalid_envelope', 'Invalid draft envelope.');
        let raw: string;
        try { raw = JSON.stringify(record); }
        catch { return failure('serialization_failed', 'The draft could not be serialized.'); }
        getStorage().setItem(key, raw);
        notify(s => storageKey(s) === key, { kind: 'changed', ...(origin ? { origin } : {}) });
        return ok(undefined);
      } catch (error) { return storageFailure(error); }
    },
    async remove(scope, origin) {
      try {
        const key = storageKey(scope);
        getStorage().removeItem(key);
        notify(s => storageKey(s) === key, { kind: 'changed', ...(origin ? { origin } : {}) });
        return ok(undefined);
      } catch (error) { return storageFailure(error); }
    },
    async clearUser(userId) {
      // Stop sessions sharing this adapter before touching storage, even if removal fails.
      notify(s => s.userId === userId, { kind: 'logout' });
      try {
        const storage = getStorage();
        const keys: string[] = [];
        for (let i = 0; i < storage.length; i++) {
          const key = storage.key(i);
          if (key !== null && keyScope(key)?.userId === userId) keys.push(key);
        }
        for (const key of keys) storage.removeItem(key);
        return ok(undefined);
      } catch (error) { return storageFailure(error); }
    },
    subscribe(scope, listener) {
      const entry = { scope: { ...scope }, listener };
      listeners.add(entry);
      const events = options.events ?? (typeof window === 'undefined' ? undefined : window);
      const handler: EventListener = event => {
        const change = event as StorageEvent;
        try {
          if (change.storageArea !== getStorage()) return;
          if (change.key === null || change.key === storageKey(entry.scope)) listener({ kind: 'changed' });
        } catch { /* inaccessible storage is reported by the next explicit operation */ }
      };
      events?.addEventListener('storage', handler);
      return () => { listeners.delete(entry); events?.removeEventListener('storage', handler); };
    },
  };
}


export interface LocalRecoveryOptions<T> {
  readonly scope: Scope;
  readonly initialValue: T;
  readonly storage: LocalStorageAdapter;
  readonly codec: Codec<T>;
  /** Omit for no expiration. Expired records are retained until explicit discard. */
  readonly maxAgeMs?: number;
  readonly now?: () => number;
  readonly baseRevision?: string | null;
}
export interface LocalRecoveryState<T> {
  readonly status: 'active' | 'logged_out';
  readonly value: T;
  readonly dirty: boolean;
  /** Revision associated with active input, including a restored candidate. */
  readonly baseRevision: string | null;
  readonly candidate: { readonly kind: 'none' } | { readonly kind: 'available'; readonly value: T };
  readonly externalChange: boolean;
  readonly error: Failure | null;
}
export interface LocalRecovery<T> {
  getSnapshot(): LocalRecoveryState<T>;
  subscribe(listener: () => void): () => void;
  update(value: T): void;
  restore(): Result<void>;
  persist(baseRevision?: string | null): Promise<Result<void>>;
  /** Revalidate after disconnection without offering this session's own saved draft. */
  refresh(preserveActive?: boolean): Promise<Result<void>>;
  discard(): Promise<Result<void>>;
  /** Dispose, drain the in-flight operation, then clear this account's drafts. Retryable after disposal. */
  logout(): Promise<Result<void>>;
  dispose(): void;
}

/** Local recovery only; remote save coordination and React bindings are separate. */
export async function createLocalRecovery<T>(options: LocalRecoveryOptions<T>): Promise<Result<LocalRecovery<T>>> {
  if (!isScope(options.scope) || !options.codec || !Number.isSafeInteger(options.codec.version) || options.codec.version < 0 ||
    typeof options.codec.encode !== 'function' || typeof options.codec.decode !== 'function' ||
    !options.storage || ['read', 'write', 'remove', 'clearUser', 'subscribe'].some(k => typeof (options.storage as unknown as Record<string, unknown>)[k] !== 'function') ||
    (options.maxAgeMs !== undefined && (!Number.isFinite(options.maxAgeMs) || options.maxAgeMs < 0)) ||
    (options.baseRevision !== undefined && options.baseRevision !== null && (typeof options.baseRevision !== 'string' || !options.baseRevision.length))) {
    return failure('invalid_options', 'Invalid local recovery options.');
  }
  const scope = Object.freeze({ ...options.scope });
  const { storage, codec, maxAgeMs } = options;
  const clock = options.now ?? Date.now;
  const origin = Symbol('local-recovery');
  let state: LocalRecoveryState<T> = Object.freeze({ status: 'active', value: options.initialValue, dirty: false, baseRevision: options.baseRevision ?? null,
    candidate: Object.freeze({ kind: 'none' as const }), externalChange: false, error: null });
  let disposed = false;
  let loggedOut = false;
  let stopWaiting!: () => void;
  const stopped = new Promise<void>(resolve => { stopWaiting = resolve; });
  const inactiveError = () => disposed ? disposedError() : failure('logged_out', 'This account was logged out; create a new session before using storage.');
  let blocked = false;
  let generation = 0;
  let discovery = 0;
  let discovering = false;
  let refreshing: Promise<Result<void>> | null = null;
  let signalRefresh!: () => void;
  let refreshChanged = new Promise<void>(resolve => { signalRefresh = resolve; });
  let discoveryError: Failure | null = null;
  let pending: Promise<Result<void>> | null = null;
  let baseRevision = options.baseRevision ?? null;
  let candidateRevision: string | null = null;
  let unsubscribe = () => {};
  let ownRecord: LocalRecord | null = null;
  let notificationError: Failure | null = null;
  let mutationError: Failure | null = null;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<LocalRecoveryState<T>>) => {
    if (disposed) return;
    state = Object.freeze({ ...state, ...patch, ...(patch.error === null ? { error: mutationError ?? notificationError } : {}) });
    for (const listener of [...listeners]) { try { listener(); } catch { /* isolate observers */ } }
  };
  const attempt = async <R>(operation: () => Promise<Result<R>>): Promise<Result<R>> => {
    try { return await operation(); } catch (error) { return storageFailure(error); }
  };
  const discover = async (preserveActive: boolean): Promise<Result<void>> => {
    if (disposed || loggedOut) return inactiveError();
    const ticket = ++discovery;
    discovering = true;
    blocked = true;
    const result = await attempt(() => storage.read(scope));
    if (disposed || loggedOut) return inactiveError();
    if (ticket !== discovery) return ok(undefined);
    discovering = false;
    if (preserveActive && ownRecord && result.kind === 'ok' && !state.externalChange) {
      const checked = validateRecord(result.value, scope);
      if (checked.kind === 'ok' && checked.value.payload === ownRecord.payload &&
          checked.value.dataVersion === ownRecord.dataVersion && checked.value.savedAt === ownRecord.savedAt &&
          checked.value.baseRevision === ownRecord.baseRevision) {
        blocked = false; discoveryError = null;
        publish({ candidate: Object.freeze({ kind: 'none' }), error: null });
        return ok(undefined);
      }
      // A different record (including removal) may have arrived while disconnected.
      publish({ externalChange: true });
    }
    let error: Failure | null = result.kind === 'ok' ? null : result;
    let candidate: LocalRecoveryState<T>['candidate'] = { kind: 'none' };
    blocked = result.kind !== 'ok' || result.value !== null || state.externalChange;
    if (result.kind === 'ok' && result.value !== null) {
      const checked = validateRecord(result.value, scope);
      if (checked.kind !== 'ok') error = checked;
      else {
        const record = checked.value;
        let age = NaN;
        try { age = clock() - Date.parse(record.savedAt); } catch { /* handled below */ }
        if (maxAgeMs !== undefined && (!Number.isFinite(age) || age < 0)) error = failure('invalid_timestamp', 'The draft timestamp is in the future or the clock is invalid.');
        else if (maxAgeMs !== undefined && age >= maxAgeMs) error = failure('expired', 'The stored draft has expired.');
        else {
          try {
            const decoded = codec.decode(record.payload, record.dataVersion);
            if (decoded.kind === 'ok') { candidate = { kind: 'available', value: decoded.value }; candidateRevision = record.baseRevision; }
            else error = decoded;
          } catch { error = failure('invalid_data', 'The stored draft could not be decoded.'); }
        }
      }
    }
    discoveryError = error;
    publish({ candidate: Object.freeze(candidate), error });
    return error ?? ok(undefined);
  };
  const refresh = (preserveActive = false): Promise<Result<void>> => {
    signalRefresh();
    refreshChanged = new Promise<void>(resolve => { signalRefresh = resolve; });
    const task = discover(preserveActive);
    refreshing = task;
    const settled = () => { if (refreshing === task) refreshing = null; };
    void task.then(settled, settled);
    return task;
  };
  const recoveryPending = (): Failure => {
    const error = failure('recovery_pending', 'Restore or discard the stored draft before persisting.');
    if (!state.error) publish({ error });
    return error;
  };
  const dispose = () => { if (!disposed) { disposed = true; discovery++; stopWaiting(); unsubscribe(); listeners.clear(); } };
  const mutate = (operation: () => Promise<Result<void>>): Promise<Result<void>> => {
    if (disposed || loggedOut) return Promise.resolve(inactiveError());
    if (pending) return Promise.resolve(failure('operation_in_progress', 'A local operation is in progress.'));
    // Install the guard before callbacks run, then encode synchronously at dispatch.
    let finish!: (result: Result<void>) => void;
    const current = new Promise<Result<void>>(resolve => { finish = resolve; });
    pending = current;
    void operation().then(result => { pending = null; finish(result); }, error => {
      const result = disposed || loggedOut ? inactiveError() : storageFailure(error);
      pending = null; if (!loggedOut) publish({ error: result }); finish(result);
    });
    return current;
  };
  const controller: LocalRecovery<T> = {
    getSnapshot: () => state,
    subscribe(listener) { if (disposed) throw new Error('Recovery session is disposed'); listeners.add(listener); return () => { listeners.delete(listener); }; },
    update(value) { if (disposed) throw new Error('Recovery session is disposed'); generation++; publish({ value, dirty: true }); },
    restore() {
      if (disposed || loggedOut) return inactiveError();
      if (discovering || pending) return failure('operation_in_progress', 'A local operation is in progress.');
      if (state.candidate.kind === 'available') {
        generation++; blocked = false; mutationError = null; baseRevision = candidateRevision;
        publish({ value: state.candidate.value, dirty: true, baseRevision, candidate: Object.freeze({ kind: 'none' }), externalChange: false, error: null });
      }
      return ok(undefined);
    },
    refresh,
    persist: (revision = baseRevision) => mutate(async () => {
      if (disposed || loggedOut) return inactiveError();
      if (blocked && !discovering) return recoveryPending();
      const savedGeneration = generation;
      let record: LocalRecord;
      try {
        const encoded = codec.encode(state.value);
        if (encoded.kind !== 'ok') { mutationError = encoded; publish({ error: encoded }); return encoded; }
        if (typeof encoded.value !== 'string') throw new TypeError('Codec must return a string');
        record = { formatVersion: 1, scope, baseRevision: revision, dataVersion: codec.version, payload: encoded.value, savedAt: new Date(clock()).toISOString() };
      } catch {
        const error = failure('serialization_failed', 'The draft could not be serialized.'); mutationError = error; publish({ error }); return error;
      }
      // Keep the dispatch snapshot, but wait until the latest discovery establishes
      // whether there is a stored draft to protect. An empty read needs no decision.
      let waited = false;
      while (refreshing) {
        waited = true;
        const task = refreshing;
        const reading = discovery;
        const read = await Promise.race([task, refreshChanged.then(() => ok(undefined)), stopped.then(inactiveError)]);
        if (disposed || loggedOut) return inactiveError();
        if (reading !== discovery) continue;
        if (read.kind !== 'ok') return read;
      }
      if (waited && discoveryError) return discoveryError;
      if (blocked) return recoveryPending();
      const ticket = discovery;
      const savedRecord = { ...record };
      const result = await attempt(() => storage.write(scope, record, origin));
      if (result.kind === 'ok') ownRecord = savedRecord;
      if (disposed || loggedOut) return inactiveError();
      mutationError = result.kind === 'ok' ? null : result;
      if (result.kind !== 'ok') publish({ error: result });
      else if (ticket === discovery) publish({ dirty: savedGeneration !== generation, error: null });
      return result;
    }),
    discard: () => mutate(async () => {
      if (disposed || loggedOut) return inactiveError();
      const ticket = ++discovery;
      discovering = false;
      const result = await attempt(() => storage.remove(scope, origin));
      if (disposed || loggedOut) return inactiveError();
      if (result.kind === 'ok') {
        ownRecord = null;
        const superseded = ticket !== discovery;
        discovery++; discovering = false; blocked = false; mutationError = null;
        refreshing = null; discoveryError = null; signalRefresh();
        publish({ candidate: Object.freeze({ kind: 'none' }), externalChange: false, error: null });
        // A competing read may have observed the record before removal committed.
        // Re-read after removal rather than offering that stale candidate again.
        if (superseded) await refresh();
      } else { mutationError = result; publish({ error: result }); }
      return result;
    }),
    async logout() {
      dispose();
      await pending;
      return attempt(() => storage.clearUser(scope.userId));
    },
    dispose,
  };
  try {
    unsubscribe = storage.subscribe(scope, change => {
      if (disposed || loggedOut || change.origin === origin) return;
      if (change.kind === 'logout') {
        loggedOut = true; discovery++; discovering = false; blocked = true; stopWaiting();
        unsubscribe();
        publish({ status: 'logged_out', candidate: Object.freeze({ kind: 'none' }), externalChange: false, error: inactiveError() });
        return;
      }
      blocked = true;
      publish({ externalChange: true, candidate: Object.freeze({ kind: 'none' }) });
      void refresh();
    });
  } catch {
    notificationError = failure('notifications_unavailable', 'Competing draft notifications are unavailable.');
    publish({ error: mutationError ?? notificationError });
  }
  await refresh();
  return ok(controller);
}
