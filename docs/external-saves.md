# External document saves and publication

`controller.saveDocument(submit)` coordinates an authoritative document save with
recovery autosave. The same action is available through `useDraftRecovery`.
It captures the current value immediately, pauses remote recovery actions, drains
any in-flight recovery mutation, persists local input, and calls `submit` with
that captured value and the current document ID/version. Input remains editable
and locally persisted throughout. It resumes remote actions in `finally`, including
when validation fails, submission throws, or cleanup fails.

```ts
const opened = await createRecovery({
  scope: { userId, documentId: recoveryKey, editorId: writerId },
  initialValue: article,
  document: { id: articleId, version: articleVersion }, // null/null for creation
  codec, storage, remote,
});
if (opened.kind !== 'ok') throw new Error(opened.message);
const controller = opened.value;

const result = await controller.saveDocument(async ({ value, document }) => {
  // Validate and obtain approval for this exact value, not the live form.
  if (!validateArticle(value)) {
    return { kind: 'permanent', code: 'invalid_article', message: 'Review the article.' };
  }
  if (!await askForEditorialApproval(value)) {
    return { kind: 'permanent', code: 'approval_required', message: 'Not approved.' };
  }
  return documentApi.publish({
    value, id: document.id, expectedVersion: document.version, recoveryKey,
  }); // Result<{ id: string; version: string }> or { kind: 'unknown', message }
});
```

The [typechecked publishing example](../contracts/document-save-example.ts) keeps
validation and human approval in the application. The server must enforce its own
authorization, validation and editorial rules; the library does not grant approval.
The callback must not wait for a recovery save/retry: those actions are paused.

This example intentionally keeps human approval inside the pause so that the
approved snapshot is exactly the submitted one. Remote recovery autosave stays
paused for the entire dialog, potentially minutes; cross-device recovery will not
receive new edits during that interval. Local persistence and editing continue.
Show this state in the UI and let the user cancel approval to resume scheduling.

## Two independent acknowledgements

- `state.dirty` describes recovery persistence, as before.
- `state.document.dirty` tracks edits since the last authoritative acknowledgement.
- `state.document.reference` contains the authoritative ID/version, never a working
  copy revision. Successful submission requires nonempty `id` and `version` strings.
- `state.document.saving` covers drain, submission and cleanup. A scheduler should
  skip while it is true and schedule again when it becomes false. The engine owns
  no debounce timer and does not queue skipped autosaves.

If A is submitted and the user types B, success acknowledges A only. B remains
`document.dirty` and locally recoverable, and the visible input stays B. Recovery
save success alone never clears `document.dirty`. Equality is generation-based:
retyping the same value is conservatively treated as an edit.

The document option initializes the session's authoritative reference; omitting it
uses `{ id: null, version: null }` and accepts the first successful server ID.
For an existing document, supply its ID/version explicitly. Recovery keys are never
inferred to be server IDs. In React, keep options stable;
changing this option does not replace the active session's reference. A successful
`saveDocument` advances it. `reconcile` remains a recovery conflict-resolution API,
not an external acknowledgement or document-token update API. Reconciliation that
retains the exact current snapshot (`reconcile(current, controller.getSnapshot().value)`)
preserves an existing document acknowledgement. Merged/replaced values are treated
as edits; already-dirty input remains dirty. Recovery conflicts still require this
explicit decision, including conflicts from optional cleanup.

## Pending, failed and uncertain work

| Recovery state | External save behavior |
| --- | --- |
| Mutation in flight | Pause immediately, await its final result, then inspect it |
| Successful or permanently failed mutation | Submission may proceed after local durability succeeds |
| Retryable or unknown mutation | Return `operation_unresolved`; resolve via `retry()` first |
| Conflict | Return `reconciliation_required`; reconcile explicitly first |
| Expired replay window | Use the existing explicit reconciliation flow; never invent success |
| Unreviewed local candidate or local persistence failure | Return the local error; do not submit or remove the record |

Remote discovery itself does not need to finish for an authoritative save. No
recovery cleanup is attempted for a working copy this session has not saved.
Concurrent document saves and remote save/retry/discard/reload/reconcile actions
return `document_save_in_progress`; local updates and persistence continue.
Explicit local discard is also blocked during document save.

Callback failures leave the reference and acknowledgement unchanged. A thrown
callback or invalid success acknowledgement returns `unknown`, since the document
may have committed. The application must verify that outcome and use its own
idempotency/concurrency protocol before resubmitting. Recovery scheduling resumes;
no automatic external retry occurs. Local errors remain available in `state.error`;
the application should present the returned external-save result separately.

## Creation and persisted identity

Allocate a durable recovery key before creation and keep it for the editor session.
Start with `document: { id: null, version: null }`. A successful creation response
updates the authoritative document reference without changing the recovery scope,
recreating the controller, deleting the creation record, or replacing active input.
Later submissions receive the new document ID and version. Once persisted, a save
cannot acknowledge a different document ID within this session.

Have the application/server retain the mapping from the created document to its
recovery key (for example, submit `recoveryKey` in the creation request). Reopen with
that same recovery scope and the latest authoritative reference. New writer
instances can use cross-writer discovery for that key. This is a stable-key
composition pattern, not a rename of storage keys: do not switch `scope.documentId`
to the server ID on creation or dispose/remount the editor to mark creation done.
The library does not persist authoritative version metadata in recovery records;
load it from the document service when reopening. Account/document navigation to
an unrelated editor still requires disposing the old session.

## Cleanup is separate from document success

An `ok` result contains `{ document, cleanup }`. Cleanup is `null` when skipped,
or a recovery `MutationResult`. Cleanup is attempted only for a successfully saved
working copy belonging to the submitted generation, with no later edits or pending
local candidate. It uses the engine's expected recovery revision and operation ID;
an intervening remote writer produces a conflict, never an unconditional delete.
Edits during cleanup stay local and dirty. Cleanup failure does not undo
the authoritative acknowledgement. Retryable, unknown, or conflicting cleanup must
be resolved through the normal retry/reconciliation protocol before another remote
mutation or external save; permanent cleanup failure permits a new save.

Local records are deliberately retained after publication. The existing storage
contract has no atomic conditional removal, so automatically calling `discardLocal`
could destroy a newer candidate. Use the discovery adapter's revision-checked
candidate discard for explicit housekeeping where supported. A stale retained copy
may be offered on reopen; the application should present it for review, not silently
restore it over the authoritative document.
