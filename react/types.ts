import { useDraftRecovery } from './index.ts';
import type { RecoveryEngineOptions } from './index.ts';
// Compile-only consumer checks. This component is never executed by the tests.
export function TypedConsumer({ options }: { options: RecoveryEngineOptions<{ title: string }> }) {
  const result = useDraftRecovery(options);
  const title: string = result.state.value.title;
  if (result.ready) {
    result.actions.update({ title });
    // @ts-expect-error updates must match the inferred draft type
    result.actions.update({ title: 123 });
    // @ts-expect-error reconciliation must use the same draft type
    result.actions.reconcile({ kind: 'present', revision: '1', value: 123 }, { title });
  } else {
    const unavailable: null = result.actions;
    void unavailable;
  }
  return null;
}
