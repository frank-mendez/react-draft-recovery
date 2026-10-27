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
and disposal are owned by React and are not exposed as actions.

Before discovery finishes, `ready` is false, `actions` is null, and `state` has
the supplied initial value, no candidate, and status `loading`. Disable editing
until ready. Initialization failures return status `error` and `state.error`;
remount or replace the invalid configuration to retry initialization. Storage
read failures handled by the core may still yield a ready session with an error.

```tsx
const recovery = useDraftRecovery({ scope, initialValue, codec, storage, remote });
if (!recovery.ready) return <p>{recovery.state.error?.message ?? 'Loading draft…'}</p>;
return <textarea value={recovery.state.value.title}
  onChange={event => recovery.actions.update({ title: event.target.value })} />;
```

Keep adapter, codec, clock, and operation-ID function references stable (module
constants or `useMemo`). Changing any of those identities starts a new session.
Scope is compared by its user, document, and editor strings, so inline scope
objects are safe. `initialValue` is a seed for each session; changing it alone
does not reset edits. To deliberately reset the same scope, remount with a React
key. Do not mutate the seed object. Each mounted hook owns a separate controller.

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

Cleanup unsubscribes and disposes each controller. Effect replay creates a fresh
session; a controller whose asynchronous initialization finishes after cleanup
is immediately disposed. Late completions cannot update the current hook state.
A scope change renders the new seed immediately and disposes the old session on
commit. Already-issued adapter I/O cannot be cancelled by this API and may finish
against its original scope; adapters must retain the supplied scope. Pending local
reads can temporarily retain resources until they resolve. Cleanup does not flush
or save remotely; call and await persistence before intentional navigation when
that is required. Retained actions from a disposed session must not be reused.

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
unmount during discovery, adapter replacement, initialization failures, retries,
and conflict reconciliation. Compile-only consumers check generic action types.
The existing independent core tests continue to run from `contracts`.
