# Remote adapter conformance and backend migration

A `RemoteAdapter<T>` implements a persistence protocol, not just a return-type
wrapper around a compare-and-save endpoint. The [API contract](api-contract.md)
is authoritative. The executable tools here show how to meet it without choosing
a database, server framework, or application authorization model.

- [Reusable conformance suite](../contracts/remote-adapter-conformance.mjs)
- [Typed reference backend](../contracts/reference-remote-adapter.ts)
- [Fixture integration and executable tests](../tests/remote-adapter-conformance.test.mjs)
- [Deliberately naive adapter](../tests/fixtures/naive-remote-adapter.mjs)

These are **source-level development tools**, not exports from the npm package.
Use a pinned checkout or vendor the suite into your backend tests (retain the MIT
license). Development/source execution requires Node 24+. No production backend
compatibility is claimed by these tests passing against the reference backend.

## Run the executable examples

From a checkout with development dependencies installed:

```sh
node --test tests/remote-adapter-conformance.test.mjs
npm run typecheck
```

The first command runs the same protocol cases against the reference backend and
checks that the naive adapter fails specific assertions. Expected naive failures
are asserted with `assert.rejects`; they are not skipped tests and do not make the
normal test run fail. Both the root test command and contracts test command include
this test file.

The naive implementation gives conditional writes every advantage: scoped rows,
atomic compare-and-save, authenticated calls and current-row operation recognition.
It still fails revisioned absence, retained save/discard results after later writes,
changed-payload key reuse, and retained conflict/permanent outcomes. Returning an
`absent` envelope around a nullable row does not supply a durable tombstone.

## Reference backend

```ts
import { createReferenceBackend } from './contracts/reference-remote-adapter.ts';

type Draft = { title: string; body: string };
const backend = createReferenceBackend<Draft>({
  replayWindowMs: 60_000,
  authorize: (authenticatedUser, scope, action) =>
    authenticatedUser === scope.userId && canAccessDocument(authenticatedUser, scope.documentId, action),
  validate: (value): value is Draft =>
    typeof value === 'object' && value !== null &&
    'title' in value && typeof value.title === 'string' &&
    'body' in value && typeof value.body === 'string',
});
// Inside trusted server code, after authenticating the request:
const adapter = backend.adapterFor(authenticatedSession.userId);
```

`canAccessDocument` and `authenticatedSession` above belong to your application.
Never take the argument to `adapterFor` from the client request's scope. The
reference accepts a synchronous authorization policy so the full critical section
can remain synchronous. Authorization executes on every load, save, discard and
replay, before reading receipts or returning snapshots. A revoked principal cannot
retrieve an old successful result; restoring access allows its original receipt
to replay. Authorization denial takes precedence over receipt replay.

The example's synchronous map operations model an atomic transaction within one
JavaScript process. Saves and discards allocate fresh revisions, store tombstones,
and retain detached terminal results with canonical JSON request fingerprints.
Property order does not affect JSON object identity; operation kind, scope, expected
revision and payload do. Inputs and returned snapshots cannot mutate stored state.
The data domain is plain JSON; unsupported JavaScript values are rejected before
entering the mutation protocol. Schema/policy rejections for valid JSON are retained.
Malformed protocol envelopes and denied access are ingress failures; they do not
create authorized mutation receipts. A key mismatch leaves the original receipt intact.

**Limits:** This backend is volatile and single-process. Restart loses rows,
tombstones, receipts and the revision allocator, so it cannot honor a replay window
across restarts. Do not use it for production persistence. Authorized mutations sweep all expired receipts, including operation IDs that
are never retried. The sweep retains receipts at the exact deadline and removes
them only after it. Cleanup is activity-driven: an idle backend retains receipts
until its next mutation. Tombstones remain in memory without bound. Injected `now` must be monotonic; the default is `performance.now()`. Receipts
remain available through the completion time plus `replayWindowMs` boundary. Beyond
that boundary the reference may re-evaluate a request; clients must stop automatic
retries and reconcile. Production receipt storage must survive restarts and scale
across workers, with garbage collection that respects the advertised window.

## Connect the suite to your backend

```js
import test from 'node:test';
import { runRemoteAdapterConformance } from './vendor/remote-adapter-conformance.mjs';
import { createDatabaseFixture } from './database-fixture.mjs';

test('database adapter contract', async t => {
  await runRemoteAdapterConformance(t.test.bind(t), createDatabaseFixture);
});
```

`createDatabaseFixture()` returns a new isolated store for **each case**. The suite
uses `{ title: string, body: string }` payloads and the exact scope
`{ userId: 'alice', documentId: 'document', editorId: 'editor' }`, plus `bob`, other
editors/documents and delimiter-containing IDs. Provision those identities/documents
in the fixture or translate them consistently at the authenticated test boundary.
Do not translate away editor IDs. Required fixture methods:

| Method | Responsibility |
| --- | --- |
| `adapterFor(principal)` | Synchronously return a real `RemoteAdapter` bound to a trusted test session; multiple instances must share the fixture's store. Alice and Bob may access their own scopes only. |
| `setAuthorized(principal, allowed)` | Revoke/restore access for existing and new sessions without deleting rows or receipts. |
| `setValidationAllowed(allowed)` | Make saves of valid fixture payloads fail with a permanent application policy rejection when false; restoring the policy must not erase receipts. |
| `advanceTime(ms)` | Advance a frozen server receipt/GC clock by exactly the requested duration. It must not advance during other calls. Keep normal expiry logic enabled. |
| `dispose()` (optional) | Close clients and remove the fixture's isolated test data. Runs even after assertion failure. |

Control methods may return promises. The suite always awaits them. Run against a
real transactional test database and authentication boundary; do not implement the
adapter behavior in the fixture itself. Inject a frozen server clock into retention and GC logic. Only `advanceTime` may
advance it: the tests check the full advertised window after intervening calls, so
wall-clock time or a real-time-plus-offset clock could falsely fail a conforming
backend. If your backend cannot control this clock, add that test seam before
running these boundary cases; test real-clock retention separately with timing
margins. Do not make `advanceTime` a no-op: that would fail to test retention.

The suite covers stable revisioned absence, create/delete/recreate, stale saves and
discards, concurrent CAS and identical requests for both mutation kinds, payload/key
mismatch, replay of success/conflict/permanent policy results through the advertised
window, reauthorization, impersonation and tuple isolation. Revisions are opaque:
the suite does not require their strings to differ across unrelated streams.

Concurrency cases dispatch requests together with `Promise.all` across adapter
instances. They catch visible contract violations but cannot prove database
isolation under every schedule. Add backend-specific transaction barriers, multiple
workers, forced crashes between state and receipt writes, restart/durability tests,
and response-loss injection. Validate production authorization rules and wire
response validation separately. In particular, test unauthorized users on documents
they do not own, not only a revoked test identity.

## Choose the stream mapping explicitly

The logical key is the exact tuple `(userId, documentId, editorId)`, additionally
namespaced/authorized by the authenticated principal. Use structured composite keys
or an unambiguous encoding such as a JSON array; delimiter concatenation can collide.

**Independent editor drafts:** assign distinct, stable `editorId` values. Each tuple
has its own row/tombstone and receipt namespace. Tabs with different editor IDs must
not overwrite each other's working copies. Persist/reuse the appropriate editor ID
if the product expects recovery after reopening an editor.

**Shared document draft for one user:** configure all participating editors/tabs
with the same agreed `editorId`, such as `document-working-copy`. They then intentionally
compete on one stream and handle revision conflicts. An adapter must not accept
different editor IDs and silently drop them to fit a `(user, document)` table.
Reject unsupported mappings explicitly or migrate the schema. Migrating existing
local recovery keys/base revisions also needs an explicit consumer policy; do not
silently move a local draft into a different stream.

Cross-user collaboration is a separate product and authorization decision. This
contract's user-scoped draft streams do not implement shared-document merging or
multi-user collaboration.

## Transaction, receipt and tombstone requirements

A practical persistent model has a stream record and an operation receipt table:

| Record | Required information |
| --- | --- |
| Stream | Authenticated namespace and full scope, current opaque revision, present/absent marker, payload if present |
| Receipt | Same namespace/scope plus operation ID (unique), canonical request fingerprint, complete terminal result, completion time, retention deadline |

For each authorized mutation, one transaction or equivalent atomic mechanism must:

1. Serialize on the stream/key, including when no row exists yet. Create stable
   initial absence safely; two first readers/writers must not invent different bases.
2. Look up the receipt **before** checking the current revision. An identical request
   replays the original result; a changed fingerprint returns permanent
   `idempotency_mismatch`. Concurrent requests with one key must converge on one receipt.
3. Validate the application payload/policy and compare `expectedRevision` atomically.
   A mismatch stores a terminal conflict with that moment's snapshot, not a pointer
   that will later resolve to the newest row.
4. On equality, allocate a fresh revision and write a present snapshot or tombstone.
   Discarding absence also advances its revision. Never reset revisions when deleting
   or recreating a row, and never use an ordinary timestamp as a revision allocator.
5. Record the full terminal success, conflict or permanent application rejection in
   the same transaction, and commit before returning. Retain it at least for the
   advertised replay window measured from server completion.

An atomic conditional update followed by a separate receipt insert is insufficient:
a crash between the two creates a committed operation with no replayable result.
Use transactional uniqueness/locking or equivalent coordination across workers.
Successful deletion must return its new tombstone revision. Keep enough durable
absence state to prevent ABA even after payload deletion and receipt expiry.
Receipt GC and tombstone GC are separate policies; deleting receipts must never
reset a stream's revision lineage. Protect receipts with the same access controls
as payloads because old success/conflict results can contain private draft data.

## Failures and uncertain outcomes

| Outcome | Meaning and application behavior |
| --- | --- |
| `ok` | Return the exact committed snapshot/revision, or original replay result. |
| `conflict` | No mutation committed for this request; retain the terminal conflict snapshot and require reconciliation. |
| `permanent` | Terminal validation/policy rejection or key misuse. Do not automatically retry. Retain authorized terminal operation results. |
| `retryable` | Guarantee no commit occurred, for example a proven transaction rollback. Retry the identical request with bounded backoff. |
| `unknown` | Commit may have happened. A timeout, disconnect, abort, or thrown mutation exception is not proof of rollback. Replay the identical request within the safe window. |

After a transport response is lost, the client must preserve scope, operation ID,
kind, expected revision and payload. It must not mint a new key and blindly save.
After the safe replay deadline, or restart without a trustworthy deadline, load
current state and reconcile explicitly while retaining local edits. Matching values
do not prove which operation committed. Reads cannot commit mutations, so read
failures use retryable/permanent envelopes rather than `unknown`.

## Migrating an existing compare-and-save API

1. Inventory existing guarantees: nullable reads, revision allocation, delete
   behavior, identity source, row uniqueness, retry recognition, authorization and
   retention. Treat a current-row operation ID as insufficient historical evidence.
2. Decide independent-editor versus shared-stream mapping above. Add the necessary
   composite keys and provision a revision for existing rows and absence. A legacy
   null response must become an absent snapshot with a durable server revision.
3. Add durable receipts and tombstones, transactional revision checks for **both**
   save and discard, and canonical payload identity. Existing conditional deletion
   without a returned tombstone needs a server change, not a client envelope wrapper.
4. Authenticate server-side and authorize every call/replay before receipt access.
   Validate payloads and response envelopes. Document the actual retention SLA and
   ensure deployment/restart/GC cannot shorten it.
5. Adapt your real backend into the fixture and run the suite plus backend-specific
   fault tests. Roll out schema/backfill, endpoint and client changes together with
   an explicit transition policy for old clients and stale local base revisions.
6. Preserve users' local edits during migration and require reconciliation for
   unknown legacy bases; never fabricate a revision or claim old requests have
   receipts that were never recorded.

Schema migrations, backfill/rollback plans, authorization/RLS implementation,
retention sizing, payload migration and rollout ownership remain in the consumer
repository. The library supplies protocol checks and coordination, not those
application-specific decisions. This guide does not establish compatibility with
any audited CMS or production backend.
