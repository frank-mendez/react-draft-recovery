# Public API and persistence contract

This is the initial design contract for issue #1. The authoritative type shapes
are in [contracts/index.ts](../contracts/index.ts). They are not an installable
package or implemented engine. Storage, scheduling, React bindings and production
backend adapters remain separate implementation work. Names may change before beta.

## Boundaries and identity

The core has no React, browser, server framework or database dependency. A future
`CreateRecovery` factory accepts initial data, a codec, storage and optionally a
remote adapter; it returns a controller after loading recovery candidates. Loading
must not replace initial input. A missing local record is `ok` with `null`.
Storage reads otherwise return `unknown`, including malformed data.

A scope is the exact tuple (userId, documentId, editorId). Encode it unambiguously
(for example, a JSON array, not delimiter concatenation). Every remote operation,
revision and idempotency lookup is scoped to that tuple and the authenticated
principal. The backend authenticates and authorizes every call, including replays;
client-supplied userId is not proof of identity. Changing accounts or documents
requires disposing the old controller and creating a new one. Separate editorIds
are independent draft streams; tabs sharing an editorId compete for one stream.

## Snapshots and atomic revisions

Revisions are opaque, nonempty equality tokens, never timestamps to compare or
client-generated sequence numbers. `load` returns a present value or an absent
snapshot with a revision. Absence has a stable server revision too: initial absence
must have a token, and discard creates a new tombstone token. Tokens must not be
reused after create/delete/recreate (avoid the ABA problem).

Every save and discard supplies the last loaded expectedRevision. The backend
atomically compares that token and changes the record only on equality. A mismatch
returns `conflict` with the current snapshot and does not modify it. A successful
mutation returns a new revision and the committed snapshot. Saves return present;
discards return absent, including discarding an already absent draft. All checks,
state changes and idempotency result recording occur in one transaction or an
equivalent atomic operation. A read followed by an unconditional write is invalid.

## Idempotency and uncertain outcomes

Generate a unique operationId per logical mutation and freeze its operation kind,
scope, expected revision and serialized payload. Retries reuse all of these exactly.
New edits require a new operationId; they must not alter an in-flight request.
The backend binds the key to a canonical request fingerprint. Same key and same
request returns the original terminal result, including its original revision;
same key with different content returns permanent `idempotency_mismatch`.

After authorization, look up an existing key BEFORE comparing the current revision.
Otherwise retrying a successful save would incorrectly conflict with itself. Concurrent
requests with one key must execute at most once and replay the same result. Terminal
successes, conflicts and permanent rejections must be retained. Retryable failures
must guarantee no commit; transient infrastructure failures need not be cached.

`replayWindowMs` is a positive advertised minimum retention period, starting at
server completion. The client conservatively measures its retry deadline from the
first dispatch using a monotonic clock, allowing for scheduling/network margin.
Within that window an `unknown` outcome is retried with the identical request.
Timeout, lost connection, abort or unexpected thrown exceptions during a mutation
are `unknown`, never evidence that no write occurred. Do not mint a fresh key and
blindly resend. A retryable result explicitly guarantees no commit and can be
retried with the same key, honoring retryAfterMs and bounded backoff.

After the safe retry window (or after restart without a trustworthy deadline), stop
automatic mutation retries and load current state for explicit reconciliation.
Matching values alone do not prove which operation committed. Preserve local edits
and ask the application/user to reconcile before a new mutation. This v1 contract
does not require durable pending-operation replay across browser restarts.

## Errors and validation

- `conflict`: expected revision did not match; retain input and expose current state.
- `retryable`: operation definitely did not commit; retry may succeed later.
- `permanent`: invalid data, forbidden operation or key misuse; no automatic retry.
- `unknown`: mutation may have committed; follow the replay rules above.

Adapters return these unions for expected failures. Reads can return retryable or
permanent failures because they cannot mutate. Unexpected read/storage exceptions
become visible errors, never successful saves. Do not put secrets in messages.

The core validates the local envelope (formatVersion, matching scope, nonempty
revision when present, integer dataVersion, string payload and valid savedAt)
before calling the codec. savedAt is diagnostic only. The codec owns application
serialization, schema validation and explicit migrations; TypeScript types do not
validate runtime input. Unsupported/corrupt records produce an error and are not
automatically deleted or restored. Encode must produce a detached snapshot; input
mutation after dispatch must not change request contents. Remote adapters validate
wire responses; servers independently validate payloads and enforce access controls.

## Local persistence and discard

Storage write replaces one complete record atomically where supported; the adapter
must disclose weaker guarantees. Resolve only after the attempted operation finishes.
Quota, unavailable storage and serialization failures remain observable. Storage is
best effort, not a backup or secret vault. Local read/write/remove provides no
cross-tab compare-and-swap; the engine must not claim local multi-writer safety.
Use remote revisions for remote safety and leave local tab coordination to issue #2.

`discardLocal` removes the recovery record only, retaining active input and remote
state. `discardRemote` deletes only the scoped remote draft using the same revision
and idempotency protocol as save; it does not delete a published application record,
local recovery or active input. Applications explicitly compose these actions.
A failed remote discard must not silently clear local recovery.

Serialize mutations per controller. If discard is requested during an unresolved
save, settle/reconcile that save first, then obtain explicit confirmation against
the resulting revision before discarding. Never send an unconditional delete.
Across controllers/tabs, stale saves or deletes conflict against the new tombstone
or saved revision; they cannot resurrect or erase a newer draft silently.

## Controller semantics

`getSnapshot` returns a stable immutable snapshot until state changes. `subscribe`
notifies on changes and returns an unsubscribe function. `update` changes active
input and marks it dirty. `restore` explicitly applies the loaded local candidate
and marks it dirty; candidate kind `none` means no change. An `available` candidate
can contain null when the application data type permits it. Candidate discovery never applies
input automatically. Initial remote load populates remote state without replacing
active input. Dirty is measured against the last acknowledged active-data generation,
not just the presence of a remote draft; initial input is clean until update/restore.

`save` freezes the current generation and queues a single mutation. On completion,
only that generation is acknowledged; subsequent edits remain dirty and intact.
`retry` retries the unresolved frozen operation, not the latest input. A conflict
requires explicit reconciliation and a fresh save against the chosen current revision;
`reconcile(current, value)` explicitly accepts a freshly loaded/current conflict
snapshot as the new base and the application-selected active value, marks it dirty,
and clears the failed/pending operation. It is allowed only after a conflict or
after an unknown operation has exhausted its safe replay window; the application
must confirm this choice. A later save gets a fresh operationId and can still
conflict if that base is stale. It does not itself persist or delete anything.
There is no automatic merge or overwrite. While unknown, block new remote mutations.
Local edits remain possible. `error` carries retryable/permanent failures; conflict
and unknown are represented by status and the operation result. Without a remote
adapter, save/retry/discardRemote return permanent `remote_unavailable`; local
persistence still follows updates. No pending retry returns `no_pending_operation`.

`dispose` stops notifications and future scheduling. Calling actions after disposal
is invalid (async actions return permanent `disposed`; sync actions throw). Late
completions must not update a new controller. Cancellation cannot undo a remote
commit. Autosave debounce policy and React lifecycle integration belong to the engine
and hooks issues, not this contract.

## Contract examples and acceptance scenarios

The [typechecked examples](../contracts/examples.ts) demonstrate adapter consumers.
A backend implementation must additionally pass these behavioral scenarios:

| Scenario | Required result |
| --- | --- |
| A and B load r0; A saves, then B saves with r0 | A gets r1; B conflicts; A's value remains |
| A commits but response is lost; identical request retries | Original success/r1 replays; no second write |
| Two identical requests arrive concurrently | One mutation; identical terminal results |
| Same key carries changed payload, kind or revision | Permanent idempotency_mismatch; no mutation |
| Retry arrives after retention deadline | Client stops replay and reconciles; no blind fresh-key save |
| Save r0 succeeds before a competing discard r0 | Discard conflicts and preserves the saved draft |
| Discard r0 succeeds before delayed save r0 | Save conflicts against tombstone; no resurrection |
| Create, delete, recreate | Distinct revisions throughout; old revision never becomes valid |
| Edit B while A is saving | A completion never replaces B or marks B clean |
| Corrupt storage or unsupported schema | Visible failure; active input retained; no implicit removal |
| Unauthorized replay or different account | Reauthorize; never expose another principal's result |

Run `npx --yes --package typescript@5.9.3 tsc -p contracts/tsconfig.json` to verify
examples and negative type assertions. This checks contract shape only; runtime
conformance tests will accompany the engine and concrete adapters.
