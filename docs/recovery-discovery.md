# Discovering drafts across writers

Exact-scope recovery remains the default. A writer's `editorId` still owns an
independent key. To offer drafts from previous mounts or other tabs, use the
optional discovery API from `react-draft-recovery/core`.

```ts
import { createLocalStorageAdapter, createRecoveryDiscovery } from 'react-draft-recovery/core';

const storage = createLocalStorageAdapter();
const discovery = createRecoveryDiscovery({
  userId: account.id,
  getUserId: () => auth.currentUser?.id ?? null,
  documentId: document.id,
  adapter: storage.discovery,
  codec,
});
const result = await discovery.refresh();
if (result.kind === 'ok') showRecoveryChoices(result.value);
```

Each candidate has a stable `id`, an opaque `revision`, a validated `record` (including writer scope,
base revision and saved timestamp), and a decoded `value`. IDs remain the same
when a writer updates its record; actions require the displayed revision so a background refresh cannot retarget a selection.
Malformed envelopes, unsupported formats, undecodable values and duplicate IDs
are skipped without deleting their records. Storage failures are returned as
`Result` failures. Discovery does not apply the local controller's `maxAgeMs`;
consumers may filter choices by `record.savedAt` according to their retention policy.

To build an unfinished-document list, omit `documentId`, then group returned
candidates by `record.scope.documentId`. Every operation is bound to the original
`userId`; both adapter enumeration and core envelope validation filter ownership.
`getUserId` must read the current authenticated account, not a captured account ID.
An observed account change permanently invalidates that session. Dispose it and
clear rendered candidate lists on logout/account changes, even if no operation is
in flight. Create a new session for the next account. Already returned objects
cannot be revoked by the library. This is application isolation, not a security
boundary against scripts with access to the same origin's storage.

## Explicit restore and discard

```ts
const restored = await discovery.restore(selected.id, selected.revision);
if (restored.kind === 'ok') {
  // Application state owns both the input and its associated base revision.
  setEditorValue(restored.value.value);
  setEditorBaseRevision(restored.value.record.baseRevision);
}
// A separate user action, if they choose to delete this writer's draft:
const discarded = await discovery.discard(selected.id, selected.revision);
```

Neither discovery nor restore mutates a controller or UI automatically. Thus text
entered while discovery is pending remains intact until the application explicitly
applies a selection. Restore rereads the selected record; discard compares the
revision at removal time. `candidate_changed` means refresh and ask the user to
select the updated candidate. Unknown IDs cannot be used to delete arbitrary keys.
No action deletes the other writers' copies. Use `refresh()` on reopening the
picker or after a relevant storage event; this API does not subscribe automatically.
Overlapping refreshes return `discovery_superseded` for the older response.

For the built-in local controller, importing to a fresh writer key also provides
an integration path that retains base revision handling:

```ts
const imported = await discovery.importCandidate(selected.id, freshWriterScope, storage.discovery, selected.revision);
if (imported.kind === 'ok') {
  // Construct a local controller for freshWriterScope, or refresh one already open.
  await local.refresh();
  local.restore(); // Explicit action applies the imported value and base revision.
}
```

Choose the fresh writer scope when creating that local controller. Pause any
application autosave while presenting this explicit restore action. Import refuses
an occupied destination (`destination_exists`), including a malformed stored value;
it never silently replaces active persisted input. If already editing under an
occupied key, apply `restore()`'s returned value and base revision through the
application's own explicit reconciliation flow instead.

## Versioned legacy records

Implement `DiscoveryAdapter` in the consumer for formats such as
`post-recovery:v1:`. The library does not know a CMS's schema. The adapter must:

1. Enumerate only keys owned by the requested user and optional document.
2. Validate the legacy version, ownership, fields and timestamp before returning a
   normalized `LocalRecord`. Preserve the source writer identity and base revision.
3. Return a stable source `id` and an opaque `revision` that changes on every source
   update (the complete raw storage string works for local storage).
4. Implement `read(query, id)` with the same ownership checks and normalization.
5. Implement `remove(query, id, revision)` with ownership checks and a fresh
   compare-before-delete. Return `candidate_changed` if the source differs.

For example, a consumer whose v1 records contain `{ version: 1, userId,
documentId, writerId, title, savedAt }` can normalize **after validation** to:

```ts
const normalized = {
  id: legacyKey,
  revision: rawLegacyString,
  record: {
    formatVersion: 1 as const,
    scope: { userId: legacy.userId, documentId: legacy.documentId, editorId: legacy.writerId },
    baseRevision: null, // Only when the legacy format has no known server revision.
    dataVersion: 1,
    payload: JSON.stringify(legacy.title),
    savedAt: legacy.savedAt,
  },
};
```

This is an illustrative consumer schema, not an assumed CMS format. Supply a
`Codec` whose `decode(payload, 1)` validates/migrates that legacy payload into the
current editor model, and whose `encode` produces the current `codec.version`.
Unknown versions must be rejected, not guessed. The discovery tests include a
memory-backed consumer adapter exercising the complete import/cleanup sequence.

```ts
const legacyDiscovery = createRecoveryDiscovery({
  userId: account.id,
  getUserId: () => auth.currentUser?.id ?? null,
  documentId: document.id,
  adapter: legacyAdapter,
  codec,
});
const found = await legacyDiscovery.refresh();
// After the user selects a candidate object from found.value:
const imported = await legacyDiscovery.importCandidate(selected.id, freshWriterScope, storage.discovery, selected.revision);
if (imported.kind === 'ok') {
  const cleanup = await legacyDiscovery.discard(selected.id, selected.revision);
  // If cleanup fails, retain both copies and surface/retry that failure.
}
```

Import rereads the selected revision, decodes it, encodes the current data version,
and persists a normalized replacement to an unused key. It preserves the source
saved timestamp and base revision. It **never removes the source automatically**.
Only discard the same selected ID and revision after successful persistence; a
background refresh cannot authorize cleanup of a newly updated source. Quota errors,
encoding failures, occupied destinations and account changes leave originals intact.
A failed cleanup can leave two copies, which is preferable to losing either version.

## Concurrency limits

Browser `localStorage` has no compare-and-swap transaction spanning read and write
or read and remove. The built-in adapter performs each comparison and mutation in
one synchronous operation and catches updates visible at the comparison, but
another tab/process can still race between them. Enumeration is also a best-effort
snapshot, not an atomic listing. These operations do not claim cross-tab atomicity.
Use unique writer IDs and a transactional consumer adapter (for example IndexedDB)
if strict conditional deletion or insert-if-absent is required. Custom asynchronous
adapters must enforce their own authorization and conditional mutation at commit;
core cannot cancel a mutation already dispatched when the account changes. Dispose
sessions on account changes and drain in-flight work before clearing storage.
