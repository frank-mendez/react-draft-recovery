# React integration

The source binding is `react/index.ts`; the independent engine remains in
`src/recovery-engine.ts`. This repository is not yet a published package. The
private `react/package.json` provides development tooling and records the peer
range: **React 18.3.1 or later in React 18, and React 19**. CI exercises React
18.3.1 and 19.2.0 with matching React DOM versions. No form library is required.

## Hook contract

`useDraftRecovery<T>(options: RecoveryEngineOptions<T>): DraftRecovery<T>` infers
`T` from the initial value and codec. It returns `{ ready, state, actions }`.
`state` uses the core's `RecoveryState<T>`; `actions` exposes all core editing,
restore, persistence, retry, reload, and reconciliation actions. Subscription
and connection management are owned by React and are not exposed as actions.

Before discovery finishes, `ready` is false, `actions` is null, and `state` has
the supplied initial value, no candidate, and status `loading`. Disable editing
until ready. Initialization failures return status `error` and `state.error`;
remount with a new React key and valid configuration to retry initialization. Storage
read failures handled by the core may still yield a ready session with an error.

```tsx
const recovery = useDraftRecovery({ scope, initialValue, codec, storage, remote });
if (!recovery.ready) return <p>{recovery.state.error?.message ?? 'Loading draft…'}</p>;
return <textarea value={recovery.state.value.title}
  onChange={event => recovery.actions.update({ title: event.target.value })} />;
```

Configuration (storage, codec, remote adapter, clock, and operation-ID function)
is captured once per scope. Inline objects do not restart the session. If their
identities change within a scope, the hook emits one runtime warning and continues
using the captured configuration. Use stable references to avoid that warning;
use a new React `key` to intentionally apply different configuration. This also
means callbacks must not depend on stale captured props: use an adapter that reads
current credentials, or remount when its configuration changes.

Scope is compared by its user, document, and editor strings. Changing any of those
starts a fresh session. `initialValue` is a seed; changing it alone never resets
edits. Do not mutate the seed or captured configuration objects. Each mounted hook
owns a separate controller.

The hook does not introduce remote autosave: updates persist locally, and the
application explicitly invokes `save()`. Restore never occurs automatically.
Action failures returned by the core (for example `retry_not_ready`) should also
be displayed by the application. See the [engine contract](recovery-engine.md)
for retry timing and reconciliation rules.

## Server rendering and lifecycle

Imports and rendering perform no storage reads or browser access. The engine is
created in an effect after commit. `useSyncExternalStore` supplies a stable initial
server snapshot for SSR and hydration. Supply the same scope and initial value
on the server and client. Recovery discovery happens after hydration and never
replaces the rendered input without an explicit restore action.

Cleanup disconnects external storage notifications and React observers, and
blocks actions retained by callers. It does not destroy in-memory controller
state: React uses the same cleanup for unmount and temporary hiding/replay, so
Activity hide/show and Fast Refresh must be able to reconnect the existing
session, including its active text, dirty state, and remote retry identity.
Once React releases the session, it can be garbage-collected; pending adapter
promises can retain it until they settle.

On reconnect, actions are temporarily null (`ready: false`) while local storage
is revalidated after outstanding local operations settle. The current text stays
visible. A record this session wrote is not presented as a new recovery candidate;
a competing record or removal blocks persistence until explicitly resolved. Read
failures remain visible and do not replace active input. Storage notification
reconnection failures return `ready: false` with an error; remount to retry.

A scope change renders a fresh seed and disconnects the old session on commit.
Already-issued adapter I/O cannot be cancelled and may finish against its original
scope. Local writes not yet dispatched are refused while disconnected, retain the
input in memory, and expose a retryable error; retry local persistence after
reconnecting. Cleanup does not flush or save remotely. Call and await persistence
before intentional navigation when that is required. Retained actions must not
be used while disconnected: async actions return `inactive_session`, synchronous
update/restore do nothing. Such actions become usable again only when their same
session has reconnected and completed revalidation.

These lifecycle choices follow React's [external-store SSR contract](https://react.dev/reference/react/useSyncExternalStore)
and [Strict Mode effect replay](https://react.dev/reference/react/StrictMode).

## Run the plain React example

With Node 24:

```sh
npm ci --prefix react
npm run --prefix react dev
```

Open the local URL printed by Vite. The example uses a textarea, localStorage,
and an in-memory demonstration server. Type and reload, then restore or discard
the candidate. Use **Simulate lost response**, save, wait at least 250 ms, and
retry. Use **Simulate competing edit**, then save to expose a conflict. Review the
remote revision, edit your text, explicitly reconcile, and save again. Local and
remote discard are separate actions; discarding storage does not erase active
input. Reload resets the demo server, while local recovery survives.

The demo server is educational: production adapters need durable idempotency,
authentication, authorization, and atomic revision checks. Its in-memory replay
map is not a persistence backend.

## Verification

```sh
npm run --prefix react typecheck
npm test --prefix react
npm run --prefix react build
```

Tests cover SSR without browser globals, hydration, explicit restore/discard,
Strict Mode replay, subscription cleanup, scope changes during discovery,
unmount during discovery, keyed configuration replacement, initialization failures,
inline configuration, retries, and conflict reconciliation. On React 19.2 the suite
also checks Activity hide/show with pending/failed writes, unresolved remote
mutations, and missed competing storage changes. Compile-only consumers check generic action types.
The existing independent core tests continue to run from `contracts`.

## Document saves and publication

Use `actions.saveDocument(submit)` for authoritative saves. Observe
`state.document.saving` to pause application autosave timers and resume scheduling
when it becomes false; `state.document.dirty` tracks edits not acknowledged by the
document service. The initial `document` option belongs to the session and updates
through successful submission, independently of recovery revisions. Keep the
recovery scope stable through creation. See [external saves](external-saves.md).

For an application-owned core controller, the [opt-in scheduler and browser guide](autosave.md)
provides debounce and lifecycle composition. The hook itself continues to expose
explicit save/retry actions; its internal controller is not exposed to that factory.

## Local readiness versus remote readiness

A ready hook exposes a controller for local editing and recovery; remote discovery
may still be loading or failed. Early input retains unknown ancestry even after
discovery succeeds. Render `state.error?.code === 'reconciliation_required'` as
an explicit review action, and handle load errors and save results separately.
See the [early-edit reconciliation guide and runnable example](early-edit-reconciliation.md)
for fresh snapshot review, cancellation, retry and conflict handling.
