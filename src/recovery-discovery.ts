import type { Codec, Failure, LocalRecord, Result, Scope } from '../contracts/index.js';
import { isScope, validateRecord } from './local-record.ts';

export interface DiscoveryQuery {
  readonly userId: string;
  /** Omit to list unfinished documents for this user. */
  readonly documentId?: string;
  /** Exclude the live writer from recovery choices and actions. */
  readonly excludeEditorId?: string;
}
export interface DiscoveryEntry {
  /** Stable identity within this adapter, independent of record updates. */
  readonly id: string;
  /** Opaque version used for conditional cleanup; must change whenever the source changes. */
  readonly revision: string;
  /** Consumer adapters normalize legacy envelopes here; core validates and decodes them. */
  readonly record: unknown;
}
export interface DiscoveryAdapter {
  list(query: DiscoveryQuery): Promise<Result<readonly DiscoveryEntry[]>>;
  read(query: DiscoveryQuery, id: string): Promise<Result<DiscoveryEntry | null>>;
  /** Must enforce query ownership and refuse removal if the revision changed. */
  remove(query: DiscoveryQuery, id: string, revision: string): Promise<Result<void>>;
}
export interface DiscoveryImportStorage {
  /** Persist to an unused writer key; never overwrite an existing record. */
  writeIfAbsent(scope: Scope, record: LocalRecord): Promise<Result<void>>;
}
export interface RecoveryCandidate<T> {
  readonly id: string;
  /** Pass the displayed revision with every action so refresh cannot retarget a selection. */
  readonly revision: string;
  readonly record: LocalRecord;
  readonly value: T;
}
export interface RecoveryDiscoveryOptions<T> extends DiscoveryQuery {
  /** Read the current authenticated account at every operation and after asynchronous work. */
  readonly getUserId: () => string | null;
  readonly adapter: DiscoveryAdapter;
  readonly codec: Codec<T>;
  /** Clock used to start a fresh retention period when importing. */
  readonly now?: () => number;
}
export interface RecoveryDiscovery<T> {
  /** Enumerate without mutating editor input. Invalid records are skipped and retained. */
  refresh(): Promise<Result<readonly RecoveryCandidate<T>[]>>;
  /** Revalidate the selected snapshot; caller explicitly applies its value and base revision. */
  restore(id: string, revision: string): Promise<Result<RecoveryCandidate<T>>>;
  discard(id: string, revision: string): Promise<Result<void>>;
  /** Persist a normalized replacement. Source cleanup is a separate explicit discard after success. */
  importCandidate(id: string, scope: Scope, storage: DiscoveryImportStorage, revision: string): Promise<Result<void>>;
  dispose(): void;
}
const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
const fail = (code: string, message: string): Failure => ({ kind: 'permanent', code, message });

/** Optional, account-bound discovery session, independent of active editor state. */
export function createRecoveryDiscovery<T>(options: RecoveryDiscoveryOptions<T>): RecoveryDiscovery<T> {
  const { adapter, codec, getUserId } = options;
  const now = options.now ?? Date.now;
  if (typeof options.userId !== 'string' || (options.documentId !== undefined && typeof options.documentId !== 'string') ||
      (options.excludeEditorId !== undefined && typeof options.excludeEditorId !== 'string') || typeof now !== 'function' ||
      typeof getUserId !== 'function' || !adapter || ['list', 'read', 'remove'].some(k => typeof (adapter as unknown as Record<string, unknown>)[k] !== 'function') ||
      !codec || !Number.isSafeInteger(codec.version) || codec.version < 0 || typeof codec.decode !== 'function' || typeof codec.encode !== 'function') {
    throw new TypeError('Invalid recovery discovery options');
  }
  const query: DiscoveryQuery = Object.freeze({ userId: options.userId, ...(options.documentId === undefined ? {} : { documentId: options.documentId }),
    ...(options.excludeEditorId === undefined ? {} : { excludeEditorId: options.excludeEditorId }) });
  let disposed = false;
  let invalidAccount = false;
  let generation = 0;
  let candidates = new Map<string, { revision: string }>();
  const guard = (): Failure | null => {
    if (disposed) return fail('disposed', 'The discovery session is disposed.');
    try { if (getUserId() !== query.userId) invalidAccount = true; } catch { invalidAccount = true; }
    if (invalidAccount) { candidates.clear(); return fail('account_changed', 'Create a new discovery session for the current account.'); }
    return null;
  };
  const attempt = async <R>(operation: () => Promise<Result<R>>): Promise<Result<R>> => {
    try { return await operation(); }
    catch { return { kind: 'retryable', code: 'discovery_unavailable', message: 'Draft discovery storage is unavailable.' }; }
  };
  const decode = (entry: DiscoveryEntry): Result<RecoveryCandidate<T>> => {
    if (!entry || typeof entry.id !== 'string' || !entry.id.length || typeof entry.revision !== 'string') return fail('invalid_candidate', 'Invalid candidate identity.');
    const scope = (entry.record as Partial<LocalRecord> | null)?.scope;
    if (!isScope(scope) || scope.userId !== query.userId || scope.editorId === query.excludeEditorId || (query.documentId !== undefined && scope.documentId !== query.documentId)) return fail('unauthorized_candidate', 'Candidate is outside this account or document.');
    const checked = validateRecord(entry.record, scope);
    if (checked.kind !== 'ok') return checked;
    const record = Object.freeze({ ...checked.value, scope: Object.freeze({ ...scope }) });
    try {
      const decoded = codec.decode(record.payload, record.dataVersion);
      return decoded.kind === 'ok' ? ok(Object.freeze({ id: entry.id, revision: entry.revision, record, value: decoded.value })) : decoded;
    } catch { return fail('invalid_data', 'The candidate could not be decoded.'); }
  };
  const selected = async (id: string, revision: string): Promise<Result<RecoveryCandidate<T>>> => {
    const error = guard(); if (error) return error;
    const previous = candidates.get(id);
    if (!previous) return fail('unknown_candidate', 'Refresh and select an available candidate.');
    if (revision !== previous.revision) return fail('candidate_changed', 'Refresh and select the current candidate revision.');
    const read = await attempt(() => adapter.read(query, id));
    const inactive = guard(); if (inactive) return inactive;
    if (read.kind !== 'ok') return read;
    if (read.value?.id !== id || read.value.revision !== previous.revision) return fail('candidate_changed', 'Refresh before acting on an updated candidate.');
    return decode(read.value);
  };
  return {
    async refresh() {
      const error = guard(); if (error) return error;
      const ticket = ++generation;
      const listed = await attempt(() => adapter.list(query));
      const inactive = guard(); if (inactive) return inactive;
      if (ticket !== generation) return fail('discovery_superseded', 'A newer discovery operation superseded this request.');
      if (listed.kind !== 'ok') return listed;
      const next = new Map<string, { revision: string }>();
      const result: RecoveryCandidate<T>[] = [];
      const duplicates = new Set<string>();
      const seen = new Set<string>();
      for (const entry of listed.value) {
        if (typeof entry?.id !== 'string') continue;
        if (seen.has(entry.id)) { duplicates.add(entry.id); continue; }
        seen.add(entry.id);
        const decoded = decode(entry);
        if (decoded.kind !== 'ok') continue;
        next.set(entry.id, { revision: entry.revision });
        result.push(decoded.value);
      }
      for (const id of duplicates) next.delete(id);
      candidates = next;
      return ok(Object.freeze(result.filter(c => !duplicates.has(c.id))));
    },
    restore: selected,
    async discard(id, revision) {
      const error = guard(); if (error) return error;
      const previous = candidates.get(id);
      if (!previous) return fail('unknown_candidate', 'Refresh and select an available candidate.');
      if (revision !== previous.revision) return fail('candidate_changed', 'Refresh and select the current candidate revision.');
      // The adapter compares at deletion time, not just in a preceding asynchronous read.
      const removed = await attempt(() => adapter.remove(query, id, previous.revision));
      const inactive = guard(); if (inactive) return inactive;
      if (removed.kind === 'ok') { candidates.delete(id); generation++; }
      return removed;
    },
    async importCandidate(id, target, storage, revision) {
      const restored = await selected(id, revision);
      if (restored.kind !== 'ok') return restored;
      if (!isScope(target) || target.userId !== query.userId || target.documentId !== restored.value.record.scope.documentId) return fail('unauthorized_candidate', 'Import must remain in the same account and document.');
      let record: LocalRecord;
      try {
        const encoded = codec.encode(restored.value.value);
        if (encoded.kind !== 'ok') return encoded;
        record = { ...restored.value.record, scope: Object.freeze({ ...target }), dataVersion: codec.version, payload: encoded.value, savedAt: new Date(now()).toISOString() };
        if (validateRecord(record, record.scope).kind !== 'ok') return fail('serialization_failed', 'The imported draft could not be serialized.');
      } catch { return fail('serialization_failed', 'The imported draft could not be serialized.'); }
      const inactive = guard(); if (inactive) return inactive;
      const written = await attempt(() => storage.writeIfAbsent(record.scope, record));
      return guard() ?? written;
    },
    dispose() { disposed = true; candidates.clear(); generation++; },
  };
}
