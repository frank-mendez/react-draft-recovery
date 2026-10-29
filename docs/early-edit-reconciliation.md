# Editing before remote discovery completes

`createRecovery()` awaits local discovery, not the network. Likewise, the React
hook's ready state means a controller is available for local editing and recovery;
it does **not** mean remote mutations are ready. Keep the editor usable while
`state.remote.kind === 'loading'` or `'failed'`. `update(value)` preserves input
locally by default; manual local-write policies must call `persistLocal()`.

If the user edits before the first successful load, the active draft and local
record have unknown ancestry (`baseRevision: null`). Discovery must not silently
adopt the newly observed revision, even when the remote snapshot is absent.
Otherwise normal typing could overwrite a draft the user has never reviewed.

## UI state and actions

Subscribe to controller state (or use the hook's snapshot) rather than probing
readiness by attempting a save:

| State | Suggested UI/action |
| --- | --- |
| `remote.kind === 'loading'` | Editing is available; remote save waits for discovery. |
| `remote.kind === 'failed'` | Show the load error and an explicit retry calling `reloadRemote()`. Local input stays available. |
| `error?.code === 'reconciliation_required'` | Show “Review remote draft before saving”; remote discovery alone cannot unblock autosave. |
| `status === 'conflict'` | Show a fresh reconciliation decision; never automatically repeat the save with the new revision. |
| `remote.kind === 'ready'`, `status === 'idle'`, dirty, no local candidate | Eligible for ordinary save/autosave, subject to validation and action guards. |

`state.error` prioritizes local errors and other action errors over the ancestry
error. Surface and resolve those first (for example, retry local persistence with
`persistLocal()`), then re-read state. There is no dedicated mutation-readiness
boolean. Always handle action results too: `remote_not_ready`,
`reconciliation_required`, `operation_in_progress`, and other failures can still
occur as state changes. Do not treat `remote.kind === 'ready'` alone as permission
to save. `retry()` retries an unresolved mutation, not initial discovery;
`reloadRemote()` retries discovery without adopting a base for early input.

## Runnable example

From a repository checkout, with Node.js 24:

```sh
node examples/early-edit-reconciliation.mjs
```

Type while discovery is deferred. The demo then shows the reconciliation state,
loads a fresh snapshot and asks you to save your input, enter a merged value, or
cancel. Cancellation preserves input and unknown ancestry. The demo prints the
retained local record and remote result. Its storage/backend are in memory and
last only for the process; a browser application should use its durable storage
adapter and authenticated remote adapter.

The typed [decision handler](../contracts/early-edit-reconciliation-example.ts)
is shared by the demo and regression tests. It:

1. Loads fresh state directly through the same remote adapter and scope as the
   controller. A failed load returns without presenting a stale decision.
2. Presents current input alongside the fresh remote snapshot, including an
   absent snapshot's revision, and awaits an explicit keep/merge/cancel choice.
3. Rejects approval if the text changed while the decision was open. The user
   can review again; newer input is never replaced by an older approved value.
4. Calls `reconcile(current, chosenValue)` to establish ancestry, then `save()`.
   Reconciliation itself does not send a remote mutation.

This example uses explicit saves and no autosave scheduler. In a UI, disable
repeat review actions while the handler is pending, and invalidate/close the
review when the editor scope changes or unmounts. If using autosave, keep it paused
through the decision and explicit save (see [autosave](autosave.md)); otherwise
reconciliation's idle transition can schedule a save before your explicit call.

Handle `cancelled` by leaving the review action available. Handle `input_changed`
by asking for a new review. A `conflict` after reconciliation means someone wrote
between the fresh load and conditional save: retain input and repeat the fresh
review only on another user action. Unknown/retryable mutation outcomes follow
the engine's [retry and replay rules](recovery-engine.md#retries-and-reconciliation),
not an immediate new reconciliation. The helper returns these outcomes unchanged.
It never deletes local recovery or automatically overwrites remote state when
initial discovery completes.

Run the deterministic examples/tests:

```sh
node --test contracts/early-edit-reconciliation.test.mjs
```

They cover delayed successful discovery, failed load then retry, changed remote
data, cancellation, a conflict after reconciliation, edits during the decision,
and failure/exception while loading the fresh snapshot.
