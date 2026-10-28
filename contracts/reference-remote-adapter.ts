import type { Mutation, MutationResult, RemoteAdapter, Scope, Snapshot } from './index.ts';

export interface ReferenceBackendOptions<T> {
  /** Trusted server-side policy; principal must come from authentication. */
  readonly authorize: (principal: string, scope: Scope, action: 'load' | 'save' | 'discard') => boolean;
  readonly validate: (value: unknown) => value is T;
  readonly replayWindowMs?: number;
  /** Monotonic server clock, injectable for conformance tests. */
  readonly now?: () => number;
}

function canonicalJson(value: unknown): string {
  // Deliberately restrict this example to JSON data. Do not silently erase
  // undefined, nonfinite numbers, class instances, sparse arrays or cycles.
  const ancestors = new Set<object>();
  const encode = (input: unknown): string => {
    if (input === null || typeof input === 'string' || typeof input === 'boolean') return JSON.stringify(input);
    if (typeof input === 'number' && Number.isFinite(input)) return JSON.stringify(input);
    if (typeof input !== 'object' || input === null || ancestors.has(input)) throw new Error('Not JSON');
    ancestors.add(input);
    try {
      if (Array.isArray(input)) {
        const parts: string[] = [];
        for (let i = 0; i < input.length; i++) {
          if (!Object.hasOwn(input, i)) throw new Error('Sparse array');
          parts.push(encode(input[i]));
        }
        return `[${parts.join(',')}]`;
      }
      if (Object.getPrototypeOf(input) !== Object.prototype && Object.getPrototypeOf(input) !== null) throw new Error('Not plain JSON');
      if (Object.getOwnPropertySymbols(input).length) throw new Error('Not JSON');
      // Canonical identity uses code-unit ordering, never locale-dependent collation.
      const keys = Object.keys(input).sort((left, right) => {
        if (left === right) return 0;
        return left < right ? -1 : 1;
      });
      const fields = keys.map(key => JSON.stringify(key) + ':' + encode((input as Record<string, unknown>)[key]));
      return `{${fields.join(',')}}`;
    } finally { ancestors.delete(input); }
  };
  return encode(value);
}

/**
 * Executable single-process reference, NOT durable storage or production auth.
 * Each synchronous critical section models ONE database transaction. There must
 * be no await between receipt lookup, CAS, mutation, and receipt insertion.
 */
export function createReferenceBackend<T>(options: ReferenceBackendOptions<T>): {
  adapterFor(principal: string): RemoteAdapter<T>;
} {
  const replayWindowMs = options.replayWindowMs ?? 60_000;
  if (!Number.isFinite(replayWindowMs) || replayWindowMs <= 0) throw new Error('Invalid replay window');
  const now = options.now ?? (() => performance.now());
  const streams = new Map<string, Snapshot<T>>();
  const receipts = new Map<string, { fingerprint: string; result: MutationResult<T>; expiresAt: number }>();
  let sequence = 0;
  const revision = () => `reference-${++sequence}`;
  const streamKey = (principal: string, scope: Scope) => JSON.stringify([principal, scope.userId, scope.documentId, scope.editorId]);
  const read = (key: string): Snapshot<T> => {
    let current = streams.get(key);
    if (!current) {
      current = { kind: 'absent', revision: revision() };
      streams.set(key, current);
    }
    return current;
  };
  const failure = (code: string) => ({ kind: 'permanent' as const, code, message: code });
  const collectExpiredReceipts = () => {
    const currentTime = now();
    for (const [key, receipt] of receipts) {
      if (currentTime > receipt.expiresAt) receipts.delete(key);
    }
  };
  const nonemptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0;
  const validScope = (scope: Scope) => scope && [scope.userId, scope.documentId, scope.editorId].every(nonemptyString);
  return {
    adapterFor(principal) {
      const authorized = (scope: Scope, action: 'load' | 'save' | 'discard') =>
        validScope(scope) && options.authorize(principal, scope, action);
      const mutate = (kind: 'save' | 'discard', req: Mutation & { readonly value?: T }): MutationResult<T> => {
        if (!authorized(req.scope, kind)) return failure('forbidden');
        if (![req.operationId, req.expectedRevision].every(nonemptyString)) return failure('invalid_request');
        let fingerprint: string;
        try {
          fingerprint = canonicalJson([kind, req.scope.userId, req.scope.documentId, req.scope.editorId,
            req.expectedRevision, ...(kind === 'save' ? [req.value] : [])]);
        } catch { return failure('invalid_json'); }
        const key = streamKey(principal, req.scope);
        const receiptKey = JSON.stringify([key, req.operationId]);
        collectExpiredReceipts();
        const receipt = receipts.get(receiptKey);
        if (receipt) {
          return receipt.fingerprint === fingerprint ? structuredClone(receipt.result) : failure('idempotency_mismatch');
        }
        let result: MutationResult<T>;
        if (kind === 'save' && !options.validate(req.value)) {
          result = failure('invalid_value');
        } else {
          const current = read(key);
          if (req.expectedRevision !== current.revision) {
            result = { kind: 'conflict', current };
          } else {
            const next: Snapshot<T> = kind === 'save'
              ? { kind: 'present', revision: revision(), value: req.value as T }
              : { kind: 'absent', revision: revision() };
            // Validate before cloning: structuredClone erases class prototypes and
            // symbol keys. Store a detached snapshot only after JSON validation.
            streams.set(key, structuredClone(next));
            result = { kind: 'ok', value: next };
          }
        }
        receipts.set(receiptKey, { fingerprint, result: structuredClone(result), expiresAt: now() + replayWindowMs });
        return structuredClone(result);
      };
      return {
        replayWindowMs,
        async load(scope) {
          if (!authorized(scope, 'load')) return failure('forbidden');
          return { kind: 'ok', value: structuredClone(read(streamKey(principal, scope))) };
        },
        async save(req) { return mutate('save', req); },
        async discard(req) { return mutate('discard', req); },
      };
    },
  };
}
