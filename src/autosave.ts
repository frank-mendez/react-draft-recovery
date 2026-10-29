import type { Failure, MutationResult, RecoveryController, Result } from '../contracts/index.ts';

export interface AutosaveOptions<T> {
  /** Remote quiet period, default 1000 ms. */
  readonly debounceMs?: number;
  /** Optional local quiet period. Use engine localWritePolicy: 'manual' to avoid immediate edit writes. */
  readonly localDebounceMs?: number;
  readonly online?: boolean;
  /** Synchronous remote-only validation, e.g. UTF-8 wire payload size. */
  readonly validateRemote?: (value: T) => Failure | null;
  readonly onResult?: (action: 'save' | 'retry' | 'local', result: MutationResult<T> | Result<void>) => void;
}
export interface AutosaveScheduler<T> {
  save(): Promise<MutationResult<T>>;
  /** Explicitly retry the engine's frozen operation; never substitutes current input. */
  retry(): Promise<MutationResult<T>>;
  flushLocal(): Promise<Result<void>>;
  setOnline(online: boolean): void;
  /** Application gate, including unresolved authoritative saves. Local writes continue. */
  setPaused(paused: boolean): void;
  /** Disconnect only; does not flush, cancel in-flight requests, or dispose the controller. */
  dispose(): void;
}
const fail = (code: string): Failure => ({ kind: 'permanent', code, message: `Autosave action blocked: ${code}.` });

/** Attach once per controller. No browser listeners or automatic mutation retries. */
export function createAutosaveScheduler<T>(controller: RecoveryController<T>, options: AutosaveOptions<T> = {}): AutosaveScheduler<T> {
  const debounce = options.debounceMs ?? 1000;
  for (const delay of [debounce, options.localDebounceMs]) {
    if (delay !== undefined && (!Number.isFinite(delay) || delay < 0 || delay > 2147483647)) {
      throw new RangeError('Autosave delays must be finite milliseconds between 0 and 2147483647.');
    }
  }
  let online = options.online ?? true, paused = false, disposed = false, running = false;
  let remoteTimer: ReturnType<typeof setTimeout> | undefined;
  let localTimer: ReturnType<typeof setTimeout> | undefined;
  let lastValue = controller.getSnapshot().value;
  // Prevent rejected input/guard failures from causing an automatic hot loop.
  let blocked = false;
  let validationBlocked = false;
  const clearRemote = () => { clearTimeout(remoteTimer); remoteTimer = undefined; };
  const clearLocal = () => { clearTimeout(localTimer); localTimer = undefined; };
  const report = (action: 'save' | 'retry' | 'local', result: MutationResult<T> | Result<void>) => {
    if (disposed) return;
    try { options.onResult?.(action, result); } catch { /* Observers do not affect persistence. */ }
  };
  const available = () => {
    const state = controller.getSnapshot();
    return !disposed && !paused && online && !running && !state.document.saving &&
      state.candidate.kind === 'none' && state.remote.kind === 'ready' && state.status === 'idle';
  };
  const schedule = () => {
    if (!available() || blocked || validationBlocked || !controller.getSnapshot().dirty) { clearRemote(); return; }
    remoteTimer ??= setTimeout(() => { remoteTimer = undefined; void save(); }, debounce);
  };
  const flushLocal = async (): Promise<Result<void>> => {
    clearLocal();
    if (disposed) return fail('disposed');
    const result = await controller.persistLocal();
    report('local', result);
    return result;
  };
  const queueLocal = () => {
    if (options.localDebounceMs === undefined || disposed) return;
    clearLocal();
    localTimer = setTimeout(() => { localTimer = undefined; void flushLocal(); }, options.localDebounceMs);
  };
  const run = async (action: 'save' | 'retry'): Promise<MutationResult<T>> => {
    clearRemote();
    if (disposed) return fail('disposed');
    const state = controller.getSnapshot();
    if (paused || !online || running || state.document.saving || state.candidate.kind !== 'none') return fail('autosave_paused');
    if (action === 'save' && !available()) return fail('resolution_required');
    if (action === 'save') {
      let invalid: Failure | null;
      try { invalid = options.validateRemote?.(state.value) ?? null; }
      catch { invalid = fail('remote_validation_failed'); }
      validationBlocked = invalid !== null;
      if (invalid) { report(action, invalid); return invalid; }
    }
    running = true;
    try {
      const result = await (action === 'save' ? controller.save() : controller.retry());
      blocked = result.kind !== 'ok';
      report(action, result);
      return result;
    } finally { running = false; schedule(); }
  };
  const save = () => run('save');
  const unsubscribe = controller.subscribe(() => {
    const value = controller.getSnapshot().value;
    if (!Object.is(lastValue, value)) {
      lastValue = value; blocked = false; validationBlocked = false; clearRemote(); queueLocal();
    }
    // A successful explicit engine retry/reconciliation may unblock scheduling.
    if (controller.getSnapshot().status === 'idle' && !running) blocked = false;
    schedule();
  });
  if (controller.getSnapshot().dirty) queueLocal();
  schedule();
  return {
    save, retry: () => run('retry'), flushLocal,
    setOnline(value) { online = value; schedule(); },
    setPaused(value) { paused = value; schedule(); },
    dispose() { disposed = true; clearRemote(); clearLocal(); unsubscribe(); },
  };
}
