import type { MutationResult, RecoveryController, RemoteAdapter, Scope, Snapshot } from './index.ts';

type Decision = { kind: 'cancel' } | { kind: 'save'; value: string };
type Outcome = MutationResult<string> | { kind: 'cancelled' };

/** App-owned text editor policy: call from one explicit review action at a time. */
export async function reconcileEarlyInput(
  recovery: RecoveryController<string>,
  remote: RemoteAdapter<string>,
  scope: Scope,
  choose: (input: { local: string; current: Snapshot<string> }) => Promise<Decision>,
): Promise<Outcome> {
  // Keep autosave disabled for this example; the explicit choice authorizes save.
  // Use the same adapter and scope used to create this controller.
  let loaded;
  try { loaded = await remote.load(scope); }
  catch { return { kind: 'retryable', code: 'remote_unavailable', message: 'Could not load fresh remote state.' }; }
  if (loaded.kind !== 'ok') return loaded;
  const local = recovery.getSnapshot().value;
  const decision = await choose({ local, current: loaded.value });
  if (decision.kind === 'cancel') return { kind: 'cancelled' };
  if (recovery.getSnapshot().value !== local) {
    return { kind: 'permanent', code: 'input_changed', message: 'Input changed. Review the latest input again.' };
  }
  const reconciled = recovery.reconcile(loaded.value, decision.value);
  if (reconciled.kind !== 'ok') return reconciled;
  // Reconciliation only establishes ancestry. The conditional save can conflict.
  return recovery.save();
}
