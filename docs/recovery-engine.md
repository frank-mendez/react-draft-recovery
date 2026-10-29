# Recovery engine

`src/recovery-engine.ts` implements issue #3 and the controller in
[the API contract](api-contract.md). It composes local recovery with remote
revision/idempotency coordination without React, browser or backend dependencies.
This is source-level code; package exports remain pending. See the [React binding](react.md) for hook integration.

## Usage

```ts
import { createRecovery } from '../src/recovery-engine.ts';
import { createLocalStorageAdapter } from '../src/local-recovery.ts';

const opened = await createRecovery({
  scope: { userId, documentId, editorId: 'body' },
  initialValue,
  codec, // Application validation, encoding and decoding.
  storage: createLocalStorageAdapter(),
  remote, // Optional; implements atomic revisions and idempotency.
});
if (opened.kind === 'ok') {
  const recovery = opened.value;
  const unsubscribe = recovery.subscribe(() => render(recovery.getSnapshot()));
  render(recovery.getSnapshot());
  // On editing: recovery.update(nextValue);
  // On an explicit recovery choice: recovery.restore();
  // At the application's save boundary: await recovery.save();
  // After correcting a local storage failure: await recovery.persistLocal();
  // After a retry delay: await recovery.retry();
  // On unmount/account/document change: unsubscribe(); recovery.dispose();
}
```

Creation awaits local candidate discovery, but never remote discovery. Remote load
completion establishes the initial input base without replacing active input. Later
loads update observed remote state without advancing that base. Restoring a draft
uses its stored revision, so restoring r1 after observing r3 still saves against r1
and conflicts. A null restored base requires explicit reconciliation; it is never
replaced silently with the latest observed revision. A hung or
failed backend does not hide the local recovery candidate. A local failure remains
visible even when a remote operation succeeds. Without a remote adapter, all remote
actions return `remote_unavailable` and local persistence still works.

## Observable transitions

| Event | Status / result | Input and recovery |
| --- | --- | --- |
| Remote discovery begins | `loading` | Local editing/restoration available |
| Load succeeds / fails | `idle` / `error` | Input unchanged; failure can be retried via `reloadRemote` |
| Save / remote discard dispatches | `saving` / `discarding` | Single mutation in flight |
| Save succeeds | `idle` (or `error` for retained local failure) | Only the dispatched generation is acknowledged |
| Remote discard succeeds | `idle` | New tombstone base; input and local record retained |
| Revision conflict | `conflict` | Input retained; explicit reconciliation required |
| Ambiguous response or thrown mutation | `unknown` | Frozen request retained; new mutations blocked |
| Retryable no-commit failure | `error` | Frozen request retained; new mutations blocked |
| Permanent rejection | `error` | Input retained; a new logical save is allowed |
| Reconcile allowed failure | `idle` (or retained local error) | Explicitly chosen value becomes dirty; no remote mutation |
| Dispose | Snapshot retained, notifications stop | Late completions cannot change controller state |

`dirty` tracks remote acknowledgement when a remote adapter is configured. A local
write cannot clear it. Saving A, editing B and then receiving A's success leaves B
intact and dirty. Without remote persistence, dirty tracks local durability.

## Local writes and recovery choices

Updates/restoration start local persistence immediately. While one write is pending,
subsequent edits coalesce into a write of the newest value. `persistLocal()` retries
local storage and resolves after that queue drains. It neither saves remotely nor
clears remote dirty state. Local errors remain in `state.error` until corrected.
`refreshLocal()` drains pending local writes/removal, then revalidates stored data
without replacing active input. A record last written by this controller is not
offered as a recovery candidate; competing records or removal still block writes.
This supports reconnecting notifications after a lifecycle gap. Applications must
await revalidation before issuing new local actions.

Local records retain the active draft's base revision, captured with its payload.
A remote conflict or reload cannot re-stamp an older draft with a newer revision.
An older in-flight success cannot advance the base of a newly restored draft.

Existing/corrupt recovery records are protected by the local primitive until an
explicit restore/discard. Restore failures are visible in `state.error`; restore
returns void to match the controller contract. A restore during a remote save
creates a newer dirty generation. A restore during local discovery/write is guarded.
`discardLocal()` uses the local mutation guard: if a local write is active it returns
`operation_in_progress`; await `persistLocal()` and explicitly discard afterward.
Edits made while removal is pending queue a new write after removal settles,
including automatic writes without an explicit flush. Remote saves do not themselves block local discard. Successful local discard keeps
active input; only a subsequent edit/restore/persist request recreates the record.

Adapters exposing the local primitive's optional subscription API retain competing
change notifications and candidate validation. Plain `StorageAdapter`s have no
notification capability. Local storage still has no atomic cross-tab compare-and-swap.

## Retries and reconciliation

There is no automatic network retry loop. Call `retry()` explicitly after a failure.
It reuses the original operation kind, scope, revision, ID and detached value even
when input has changed. Retry delays start at 250 ms and double to a 30-second cap;
`retryAfterMs` can require a longer delay. Calling early returns `retry_not_ready`
without changing the pending operation. `retry()` never saves the newest input in
place of the unresolved request.

The replay deadline is 90% of the adapter's advertised `replayWindowMs`, measured
from first dispatch with `performance.now()`. The remaining 10% is a scheduling and
network margin, not a guarantee against arbitrarily delayed network delivery.
Adapters/backends must enforce their own idempotency contract. `now` may be injected
for deterministic host clocks/tests; invalid or backward readings fail closed.
The engine does not automatically load or resend after deadline expiry.

After restoring an unknown-base draft, a conflict, or an unknown/retryable result past its safe replay deadline, load
fresh state directly through the remote adapter, obtain the application's/user's
explicit reconciliation choice, and call `reconcile(current, chosenValue)`. This
sets a new base and dirty value, without sending a remote mutation. A subsequent
save gets a fresh operation ID and may still conflict if the base has changed.
`reloadRemote()` is guarded while a mutation is pending; it cannot silently resolve
an uncertain operation. There is no automatic merging or durable pending-operation
replay after restart.

The default operation ID factory uses `crypto.randomUUID()`. Hosts without it can
inject `createOperationId`, which must return globally unique nonempty IDs. Duplicate
IDs within a controller are rejected. Codec failures and ID generation failures
prevent dispatch; unexpected mutation exceptions are always ambiguous.

## Values, disposal and validation

Codec round trips detach input and requests. Ordinary object graphs are frozen;
codecs must return detached values and applications must treat custom mutable types
(such as Date/Map instances) as immutable. Invalid input is retained for editing;
when codec capture fails, structured cloning is attempted and persistence exposes
validation/serialization errors. Uncloneable invalid input must be kept immutable
by its owner. Remote adapters validate wire responses; the engine additionally
checks revision tokens and successful snapshot kinds before acknowledging a write.

Create a separate controller after changing any scope component. Scope is copied
before asynchronous discovery. Dispose the old controller to stop notifications,
queued local work and late state updates. Already dispatched local writes and remote
mutations cannot be undone by disposal. Account storage cleanup and coordination
across browser tabs remain application responsibilities; see [local recovery](local-recovery.md).

## Verification

Run `npm run --prefix contracts typecheck`, `npm run --prefix contracts test`, and
`node scripts/check-repository.mjs` with Node.js 24. The engine tests use deferred
promises and an injected monotonic clock, with no real timers or external services.
An atomic in-memory revision/idempotency adapter tests response loss, competing
controllers, reversed completion order and delete tombstones. These tests establish
engine behavior, not production backend transaction correctness or browser support.

## Save acknowledgements and initial discovery

After a successful remote save, the engine persists the active draft with the
acknowledged revision. This write is serialized behind pending local writes and
preserves newer edits. A candidate explicitly restored during the save retains
its own ancestry. The local recovery copy remains available after reopening, but
restoring it no longer conflicts against that same acknowledged save. Local write
failures remain visible and can be retried with `persistLocal()`.

Edits made before initial remote discovery succeeds have unknown ancestry, just
like their persisted recovery record. Loading a remote snapshot does not silently
rebase those edits: call `reconcile(snapshot, chosenValue)` before saving. This
also applies to edits made while the initial remote load has failed.

## External document saves

`saveDocument(submit)` coordinates an application-owned document save or publication
with recovery mutations. See [external saves](external-saves.md) for pause/drain
semantics, snapshot acknowledgements, creation identity and guarded cleanup.
