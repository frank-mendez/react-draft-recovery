# Local recovery

Issue #2 is implemented in `src/local-recovery.ts`. This is a source-level local
recovery primitive, composed by the [recovery engine](recovery-engine.md), and is not a published
package. React bindings, scheduling/debounce and package exports remain separate roadmap work.

## Use

Use one `createLocalStorageAdapter()` per application context and share it among
local sessions. Browser storage is obtained lazily, so importing the module on a
server does not touch `window` or `localStorage`. Inject `getStorage` and `events`
for other hosts or testing. A denied storage getter is a visible failure, not a
reason to lose the active editor value.

```ts
import { createLocalRecovery, createLocalStorageAdapter } from '../src/local-recovery.ts';
import { codec } from '../contracts/examples.ts'; // Replace with your validated application codec.

const storage = createLocalStorageAdapter();
const opened = await createLocalRecovery({
  scope: { userId: 'user-123', documentId: 'article-456', editorId: 'body' },
  initialValue: { title: '' },
  codec,
  storage,
  maxAgeMs: 7 * 24 * 60 * 60 * 1000, // Optional; no expiration by default.
});
if (opened.kind === 'ok') {
  const recovery = opened.value;
  // Subscribe to show candidate, externalChange and error in your UI.
  const unsubscribe = recovery.subscribe(() => render(recovery.getSnapshot()));
  // Call these from explicit UI actions, never automatically on discovery:
  // recovery.restore();             // Apply the available candidate to active input.
  // await recovery.discard();       // Remove stored recovery; retain active input.
  // On input: recovery.update({ title: nextTitle });
  // On the application's save schedule: await recovery.persist();
  // On unmount: unsubscribe(); recovery.dispose();
  // On logout/account switch: await recovery.logout(); then open the next account.
}
```

`render` above is application code. Call `getSnapshot()` once for the initial UI;
subscriptions announce subsequent changes. `update` changes input without storage
I/O. `persist` immediately encodes a detached snapshot. If discovery is in progress,
it waits for the latest read before writing: absence allows the write, a candidate
requires an explicit recovery decision, and a read failure is returned unchanged.
Edits made while discovery or the write is pending remain dirty. Dirty here tracks local persistence only,
not remote acknowledgement. Snapshot `baseRevision` exposes the initial/restored
input revision. `persist(baseRevision)` optionally supplies a revision for that
write only; the revision and payload are captured together before asynchronous
discovery or writing. There is no background scheduling. Keep application
values immutable and have the codec validate unknown data before returning it.

## Envelope, identity and migrations

Keys are `react-draft-recovery:` followed by JSON encoding of the exact
`[userId, documentId, editorId]` tuple. Delimiters and Unicode inside identifiers
cannot collide. Scope identifiers are strings; empty strings are distinct valid
identifiers. Changing any identifier requires a new session. The session copies
scope at creation so caller mutation cannot redirect its pending operations.

Every record has `formatVersion: 1`, matching `scope`, `baseRevision` (null or a
nonempty remote revision), nonnegative integer `dataVersion`, string `payload`, and
parseable `savedAt`. The envelope is validated before invoking the codec.
`codec.decode(payload, dataVersion)` owns application schema validation and explicit
migration. Successful migration is offered as a candidate; the original record is
not rewritten until the user restores it and the application persists it using the
current codec version. Unknown envelope versions fail visibly; there is no automatic
envelope migration in v1.

Raw malformed JSON, stored JSON `null`, mismatched scopes, unsupported envelopes,
codec failures and expired records are retained. They produce no candidate and
cannot replace active input. Persistence is blocked with `recovery_pending` until
explicit discard, or until a successful refresh finds no record. A valid candidate
also blocks persistence until restore or discard, preserving it while the user types.
Nullable decoded application data is an available candidate, distinct from absence.

`maxAgeMs` is optional and must be finite and nonnegative. With a policy configured,
a record expires when `now - savedAt >= maxAgeMs`; future timestamps and invalid
clocks fail visibly. Expiration is evaluated on discovery/refresh, not by a background
timer. Timestamps are never used to choose a winner between writers or compare
remote revisions. Expiration does not silently delete data; call `discard()` to
remove an expired record. `maxAgeMs: 0` expires records immediately.

## Failures and retry

Storage access/read/write/remove failures are returned as `Result` values and shown
in snapshot `error`. Quota failures use `storage_quota`; other storage exceptions
use `storage_unavailable`. Both are `retryable`, with an optional machine-readable
`code` on the retryable failure contract. Failed localStorage writes do not commit;
retry after freeing space or restoring access. Codec encode exceptions use `serialization_failed`, decode
exceptions use `invalid_data`, and explicit codec failure results are preserved.
Error messages do not include thrown exception text or draft content. Invalid
envelopes, unsupported data and serialization failures remain `permanent`: correct
the data or codec before retrying. This primitive does not schedule retries itself.

Creation succeeds even when local discovery fails; only invalid options fail
creation. Retry a read with `refresh()`, a write with `persist()`, and deletion with
`discard()` or `logout()`. One local mutation may run at a time; another receives
`operation_in_progress`. A real `recovery_pending` guard is shown in snapshot
`error` unless an existing failure already explains the blockage. An empty refresh
does not produce that guard. Restore returns `operation_in_progress` while discovery or a
mutation is pending, so an old candidate cannot be consumed during validation of
a replacement. A failed write never marks input clean. A failed discard
keeps the candidate. Observer exceptions cannot change storage results. A failed
notification subscription remains visible as `notifications_unavailable`.

## Account cleanup and disposal

On logout or account switch, call and await `logout()` before opening the next
account. It disposes the session, waits for its pending write/removal, and calls
`clearUser(userId)`. Cleanup snapshots matching owned keys before removing them, so
multiple documents/editors and corrupt payloads are removed without skipping keys.
Other accounts and unrelated storage entries remain intact. Same-adapter sibling
sessions transition to observable `status: 'logged_out'` before cleanup, unsubscribe
from storage events and clear their candidates. Their existing input is retained;
`update()` continues accepting in-memory edits without throwing. Storage actions
and restore return a permanent `logged_out` failure, also exposed in snapshot
`error`; applications must create a new session after authentication changes.
Other accounts remain active. Failed/partial cleanup is observable;
`logout()` may be retried even after disposal.

`dispose()` alone does not delete data: unmounting should preserve recovery. It
stops subscriptions and rejects future actions (`update` and `subscribe` throw);
this explicit teardown remains distinct from a sibling logout notification.
Persistence waiting only on discovery is cancelled immediately on logout/disposal,
so an unresponsive read cannot delay account cleanup. Already dispatched mutations
are still drained. Late asynchronous reads/writes
cannot update the disposed snapshot. It cannot cancel an already dispatched write.
Custom asynchronous adapters must stop/drain **all** account writers before returning
from `clearUser`; the built-in localStorage adapter performs its mutations
synchronously. Applications own authentication changes across browser tabs and must
stop sessions in each tab on logout. Key scoping is not authorization or encryption.

## Competing tabs

The adapter listens to browser `storage` events, filters by storage area and exact
scope, and handles `clear()` events. It also notifies sessions sharing the adapter
within one document because browsers do not send storage events to the writer's
own document. The originating session ignores its own notifications.

An external write/removal immediately sets `externalChange`, clears any stale
candidate, and refreshes discovery. Active input is never replaced. Persistence
remains blocked until the application explicitly restores or discards; an external
removal requires discard to acknowledge it. Superseded read results cannot reintroduce
a discarded candidate. Disposed sessions do not receive notifications.

This protects active input and makes observed competition explicit. localStorage
still has no atomic compare-and-swap: simultaneous writes before events arrive use
last-writer-wins persistence, and there is no guarantee of retaining every tab's
stored version. `discard()` explicitly removes the current scoped record. Use the
remote adapter's atomic revisions for durable multi-writer conflict protection;
this module does not claim local locking or conflict merging.

## Verification

With Node.js 24:

```sh
npm ci --prefix contracts --ignore-scripts
npm run --prefix contracts typecheck
npm run --prefix contracts test
node scripts/check-repository.mjs
```

The existing development/release contract-check stage now compiles the local source
and runs the behavioral suite. Tests inject storage and event boundaries, including
quota/permission errors, corrupt payloads, migration, expiration, account cleanup,
competing notifications, and delayed asynchronous operations. These deterministic
checks do not establish a real-browser compatibility matrix or published-package
compatibility; those remain part of integration/package verification.
