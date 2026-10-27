import type { Codec, Mutation, MutationResult, RemoteAdapter, RecoveryState, Result, Scope, StorageAdapter } from './index.js';

type Draft = { title: string };
export const codec: Codec<Draft> = {
  version: 1,
  encode(value) { return { kind: 'ok', value: JSON.stringify(value) }; },
  decode(payload, version) {
    try {
      const data: unknown = JSON.parse(payload);
      if (version === 1 && typeof data === 'object' && data !== null &&
          'title' in data && typeof data.title === 'string') {
        return { kind: 'ok', value: { title: data.title } };
      }
    } catch { /* malformed JSON has the same validation failure */ }
    return { kind: 'permanent', code: 'invalid_data', message: 'Invalid draft' };
  },
};

// A single attempt; retry scheduling and reconciliation belong to the engine.
export async function saveLoaded(remote: RemoteAdapter<Draft>, scope: Scope,
  operationId: string, value: Draft): Promise<MutationResult<Draft>> {
  const loaded = await remote.load(scope);
  if (loaded.kind !== 'ok') return loaded;
  return remote.save({ scope, operationId, expectedRevision: loaded.value.revision, value });
}

export async function readCandidate(storage: StorageAdapter, scope: Scope): Promise<Result<unknown>> {
  const result = await storage.read(scope);
  // Preserve the result envelope: raw data can itself resemble a Failure object.
  // The engine must validate result.value before decoding, including scope.
  return result;
}

export function describe(result: MutationResult<Draft>): string {
  switch (result.kind) {
    case 'ok': return result.value.revision;
    case 'conflict': return `Conflict with ${result.current.revision}`;
    case 'retryable': return 'No commit; retry with bounded backoff';
    case 'permanent': return result.code;
    case 'unknown': return 'Replay frozen request within retention window';
    default: { const exhaustive: never = result; return exhaustive; }
  }
}

const scope: Scope = { userId: 'user', documentId: 'document', editorId: 'editor' };
// @ts-expect-error Every mutation must supply an expected revision.
const missingRevision: Mutation = { scope, operationId: 'operation' };
// @ts-expect-error Even absent snapshots must carry a revision (tombstone).
const missingTombstone: MutationResult<Draft> = { kind: 'ok', value: { kind: 'absent' } };
// @ts-expect-error Unknown outcome must not be represented as success.
const unknownSuccess: MutationResult<Draft> = { kind: 'unknown', value: { kind: 'absent', revision: 'r1' } };
export { missingRevision, missingTombstone, unknownSuccess };

// Nullable application data remains distinct from an absent recovery candidate.
const nullCandidate: RecoveryState<null>['candidate'] = { kind: 'available', value: null };
const noCandidate: RecoveryState<null>['candidate'] = { kind: 'none' };
export { nullCandidate, noCandidate };

// Remote failures and absence are different states; neither hides local candidates.
export const failedRemote: RecoveryState<Draft>['remote'] = {
  kind: 'failed', error: { kind: 'retryable', message: 'Offline' },
};
export const absentRemote: RecoveryState<Draft>['remote'] = {
  kind: 'ready', snapshot: { kind: 'absent', revision: 'r0' },
};
// @ts-expect-error A failed load must expose its error.
export const missingLoadError: RecoveryState<Draft>['remote'] = { kind: 'failed' };
// @ts-expect-error Raw records must remain inside the successful result envelope.
export const rawCandidate: Awaited<ReturnType<typeof readCandidate>> = { title: 'Draft' };
