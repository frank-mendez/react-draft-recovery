/** Design contract only: no runtime factory or published entry point yet. */
export type Revision = string;
export interface Scope {
  readonly userId: string;
  readonly documentId: string;
  readonly editorId: string;
}
export type Snapshot<T> =
  | { readonly kind: 'present'; readonly revision: Revision; readonly value: T }
  | { readonly kind: 'absent'; readonly revision: Revision };
export type Failure =
  | { readonly kind: 'retryable'; readonly message: string; readonly retryAfterMs?: number }
  | { readonly kind: 'permanent'; readonly message: string; readonly code: string };
export type Result<T> = { readonly kind: 'ok'; readonly value: T } | Failure;
export type MutationResult<T> = Result<Snapshot<T>>
  | { readonly kind: 'conflict'; readonly current: Snapshot<T> }
  | { readonly kind: 'unknown'; readonly message: string };
export interface Mutation {
  readonly scope: Scope;
  readonly expectedRevision: Revision;
  readonly operationId: string;
}
export interface RemoteAdapter<T> {
  /** Minimum time a completed operation's result remains replayable. */
  readonly replayWindowMs: number;
  load(scope: Scope): Promise<Result<Snapshot<T>>>;
  save(request: Mutation & { readonly value: T }): Promise<MutationResult<T>>;
  discard(request: Mutation): Promise<MutationResult<T>>;
}
export interface LocalRecord {
  readonly formatVersion: 1;
  readonly scope: Scope;
  readonly baseRevision: Revision | null;
  readonly dataVersion: number;
  readonly payload: string;
  readonly savedAt: string;
}
export interface StorageAdapter {
  /** Raw input must be checked before use, including the record envelope. */
  read(scope: Scope): Promise<Result<unknown>>;
  write(scope: Scope, record: LocalRecord): Promise<Result<void>>;
  remove(scope: Scope): Promise<Result<void>>;
}
export interface Codec<T> {
  readonly version: number;
  encode(value: T): Result<string>;
  /** Validate unknown data; migrate explicitly or return a permanent failure. */
  decode(payload: string, version: number): Result<T>;
}
export type RecoveryState<T> = {
  readonly value: T;
  readonly dirty: boolean;
  readonly candidate: { readonly kind: 'none' } | { readonly kind: 'available'; readonly value: T };
  readonly remote: Snapshot<T> | null;
  readonly status: 'idle' | 'saving' | 'conflict' | 'unknown' | 'error';
  readonly error: Failure | null;
};
export interface RecoveryController<T> {
  getSnapshot(): RecoveryState<T>;
  subscribe(listener: () => void): () => void;
  update(value: T): void;
  restore(): void;
  /** Explicit user/application reconciliation; never an automatic overwrite. */
  reconcile(current: Snapshot<T>, value: T): void;
  save(): Promise<MutationResult<T>>;
  retry(): Promise<MutationResult<T>>;
  discardLocal(): Promise<Result<void>>;
  discardRemote(): Promise<MutationResult<T>>;
  dispose(): void;
}
export interface RecoveryOptions<T> {
  readonly scope: Scope;
  readonly initialValue: T;
  readonly storage: StorageAdapter;
  readonly codec: Codec<T>;
  readonly remote?: RemoteAdapter<T>;
}
/** Signature for the future engine, not an implemented export. */
export type CreateRecovery = <T>(options: RecoveryOptions<T>) => Promise<Result<RecoveryController<T>>>;
