# Public API and persistence contract

This is the initial design contract for issue #1. The authoritative type shapes
are in [contracts/index.ts](../contracts/index.ts). They are implemented by the source-level [recovery engine](recovery-engine.md),
not yet an installable package. The [local recovery primitive](local-recovery.md)
implements storage and explicit local restoration. Scheduling, React bindings and
production backend adapters remain separate implementation work. Names may change before beta.

## Boundaries and identity

The core has no React, browser, server framework or database dependency. The
`createRecovery` factory accepts initial data, a codec, storage and optionally a
remote adapter; it returns a controller after attempting local candidate discovery. Local storage or
codec failures leave the candidate empty and expose the failure in state.error;
they do not prevent creation. Only invalid options (permanent `invalid_options`)
fail creation. A configured remote load starts in the background and is never
awaited by creation: a slow, failed or hung backend cannot hide local recovery.
Remote load completion cannot replace active input or the local candidate. Loading
must not replace initial input. A missing local record is `ok` with `null`.
Storage reads otherwise return untyped data (TypeScript `unknown`), including malformed data.
This is distinct from the `unknown` mutation outcome.

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

Every save and discard supplies the active draft's base as expectedRevision. Initial discovery establishes that base; subsequent reads only update observed remote state. Restoring a local draft preserves its recorded base, so stale drafts conflict with newer remote revisions. A restored null base requires explicit reconciliation before remote mutation. The backend
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

Retryable failures may include an optional machine-readable `code` (for example,
local `storage_quota` or `storage_unavailable`). Adapters return these unions for expected failures. Reads can return retryable or
permanent failures because they cannot mutate. Unexpected read/storage exceptions
become visible errors, never successful saves. Do not put secrets in messages.

The core validates the local envelope (formatVersion, matching scope, nonempty
revision when present, integer dataVersion, string payload and valid savedAt)
before calling the codec. savedAt is diagnostic and may be used for opt-in local
expiration; it is never a revision. The codec owns application serialization, schema validation and explicit migrations; TypeScript types do not
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
Use remote revisions for remote safety. The [local recovery primitive](local-recovery.md)
notifies about competing tab changes without replacing active input; it does not
provide atomic local compare-and-swap.

`persistLocal` writes/retries the latest local recovery snapshot and awaits queued local writes; it does not acknowledge remote persistence. Updates and restoration schedule local persistence automatically by default. The engine option `localWritePolicy: 'manual'` delegates edit-time writes to the application; restoration still persists.

`discardLocal` removes the recovery record only, retaining active input and remote
state. Edits made during removal queue local persistence until removal settles; they are not dropped. A discard requested during an existing local write is guarded with `operation_in_progress`. `discardRemote` deletes only the scoped remote draft using the same revision
and idempotency protocol as save; it does not delete a published application record,
local recovery or active input. Applications explicitly compose these actions.
A failed remote discard must not silently clear local recovery.

Serialize mutations per controller. Discard requested during an in-flight or
unresolved save returns the guard failure below rather than silently queuing.
Settle/reconcile that save first, then obtain explicit confirmation against
the resulting revision before calling discard again. Never send an unconditional delete.
Across controllers/tabs, stale saves or deletes conflict against the new tombstone
or saved revision; they cannot resurrect or erase a newer draft silently.

## Controller semantics

`getSnapshot` returns a stable immutable snapshot until state changes. `subscribe`
notifies on changes and returns an unsubscribe function. `update` changes active
input and marks it dirty. `restore` explicitly applies the loaded local candidate
and marks it dirty; candidate kind `none` means no change. An `available` candidate
can contain null when the application data type permits it. Candidate discovery never applies
input automatically. Remote state is a discriminated union: `disabled` (no adapter), `loading`,
`ready` with a present/absent snapshot, or `failed` with its load error. Initial
remote loading sets status `loading`; completion sets `idle` or `error`, preserving
any local error. Local restore/update remain usable while loading or failed.
`reloadRemote` retries discovery after failure, sets remote/status to loading, and
returns the read result. It may run only while idle or error with no pending mutation; otherwise it returns
permanent `operation_in_progress` without changing state. The first successful load establishes the base for initial input. Later loads refresh observed remote state without rebasing active input, even when clean; only a successful mutation in the same draft lineage or explicit reconciliation advances its base. A failed load sets remote to failed.
A controller with remote disabled starts idle (or error for a local failure).
Remote mutation methods require a ready remote base. Dirty is measured against the last acknowledged active-data generation,
not just the presence of a remote draft; initial input is clean until update/restore.

`save` freezes the current generation and dispatches a single mutation after the guards below. On completion,
only that generation is acknowledged; subsequent edits remain dirty and intact.
`retry` retries the unresolved frozen operation, not the latest input. A conflict
requires explicit reconciliation and a fresh save against the chosen current revision;
`reconcile(current, value)` explicitly accepts a freshly loaded/current conflict
snapshot as the new base and the application-selected active value, marks it dirty,
and clears the failed/pending operation. It is allowed after restoring a draft with an unknown (null) base, after a conflict, or
after an unknown or retryable operation has exhausted its safe replay window; the application
must confirm this choice. For reconciliation the application loads a fresh snapshot
through its remote adapter directly; this read does not change controller state.
It returns `ok` with undefined on success and permanent
`invalid_reconciliation_state` with no state change otherwise. A later save gets a fresh operationId and can still
conflict if that base is stale. It does not itself persist or delete anything.
There is no automatic merge or overwrite. While unknown, block new remote mutations.

Mutation guards return permanent failures without dispatch, clearing errors, or
changing pending operations. Apply guards in this order:

| Condition | Methods | Code |
| --- | --- | --- |
| Disposed | All result-returning actions | `disposed` |
| No remote adapter | save/retry/discardRemote/reloadRemote | `remote_unavailable` |
| Unknown or retryable pending outcome | save/discardRemote | `operation_unresolved` |
| Conflict awaits reconciliation | save/discardRemote | `reconciliation_required` |
| Initial/reload discovery incomplete or failed | save/discardRemote/retry | `remote_not_ready` |
| Another mutation is in flight | save/discardRemote/retry | `operation_in_progress` |
| No retryable or unknown pending operation | retry | `no_pending_operation` |
| Pending replay window exhausted | retry | `replay_window_expired` |
| Retry delay has not elapsed | retry | `retry_not_ready` |

A blocked call's permanent failure describes that attempted action, not the earlier
uncertain mutation. `retry` is the only mutation allowed while unknown and uses the
frozen request. A pending retryable failure also blocks new save/discard requests
with `operation_unresolved` until retried or explicitly reconciled; it cannot silently be replaced.
Dispatched saves set status `saving`; dispatched discards set `discarding`.
Retries use the status for the original operation kind. Completion sets idle,
conflict, unknown or error according to its result. Local errors remain observable
in state.error even if a remote operation succeeds.
Local edits remain possible. `error` carries retryable/permanent failures; conflict
and unknown are represented by status and the operation result. Without a remote
adapter, save/retry/discardRemote return permanent `remote_unavailable`; local
persistence still follows updates. No pending retry returns `no_pending_operation`.

`dispose` stops notifications and future scheduling. Calling actions after disposal
is invalid (result-returning actions return permanent `disposed`; update/restore/subscribe throw). Late
completions must not update a new controller. Cancellation cannot undo a remote
commit. The engine exposes explicit save/retry actions. The separate [opt-in autosave scheduler](autosave.md) supplies debounce; browser and React lifecycle integration remain application-owned. See the [engine timing policy](recovery-engine.md) for bounded retry delays and replay margins.

## Contract examples and acceptance scenarios

The [typechecked examples](../contracts/examples.ts) demonstrate adapter consumers.
The [reusable conformance suite and reference adapter](remote-adapters.md) exercise
backend protocol requirements and explain migration from simpler APIs. A backend
implementation must additionally pass these behavioral scenarios:

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

Run `npm ci --prefix contracts --ignore-scripts` followed by
`npm run --prefix contracts typecheck` to verify
examples and negative type assertions. This checks contract/source types only; behavioral local recovery tests run
separately below. The engine suite exercises remote coordination against deterministic adapter doubles; the reusable conformance suite can be run against each real backend via a fixture.
Production durability and authorization validation remain the responsibility of each adapter.

Both development and release workflows run this same locked, script-disabled
compiler installation, typecheck, and `npm run --prefix contracts test`.
The example tests check failure-envelope preservation and codec validation. The
local recovery tests exercise concrete storage and local session behavior; the separate engine suite checks concurrency, revision conflicts, retry identity and lifecycle behavior. The private contracts manifest is tooling
only; it does not turn the repository into a published library package.
