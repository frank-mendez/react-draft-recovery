# Opt-in autosave and browser lifecycle

`createRecovery()` still schedules **no remote saves** on its own. Opt in with
`createAutosaveScheduler` from `react-draft-recovery/core`. Attach one scheduler
per controller and disconnect it before disposing that controller.

```ts
import { createRecovery, createAutosaveScheduler } from 'react-draft-recovery/core';

const result = await createRecovery({
  ...options, // scope, initialValue, codec, storage, and optional remote adapter
  localWritePolicy: 'manual',
});
if (result.kind !== 'ok') throw new Error(result.message);
const controller = result.value;
const autosave = createAutosaveScheduler(controller, {
  debounceMs: 1000,
  localDebounceMs: 150,
  onResult(action, result) {
    // Render errors in the application's status UI; do not silently claim saved.
    if (result.kind !== 'ok') console.warn(action, result);
  },
});
controller.update({ title: 'New input' });
// Save button: bypass the debounce, retaining safety gates.
await autosave.save();
// Before a controlled teardown, while the controller is still alive:
await autosave.flushLocal();
autosave.dispose();
controller.dispose();
```

The default engine `localWritePolicy: 'immediate'` preserves every edit (coalescing
writes already in flight). Leave it enabled for the smallest loss window and omit
`localDebounceMs`. With `'manual'`, edit-time writes happen only when the application
or scheduler calls `persistLocal()`/`flushLocal()`. The local debounce is independent
of remote debounce and remains active while remote scheduling is paused or offline.
Restoration, reconciliation, remote acknowledgements, and authoritative submissions
still persist as required by engine safety rules; this policy only changes `update()`.
Manual/debounced persistence increases the possible loss window. If you omit the
local timer in manual mode, you must provide regular local writes yourself.

Local write failures are observable through controller state and `onResult`. They
do not erase active input. Automatic remote saves conservatively wait while the
controller reports an error; retry local preservation with `flushLocal()` after
storage becomes available. The scheduler does not continuously retry storage.

## Scheduling and resolution

- Remote debounce restarts when input changes, not on every storage notification.
  It uses the newest input when it fires. In-flight requests are not cancelled;
  input typed during a save gets another debounce after acknowledgement.
- No automatic dispatch while a local candidate awaits a choice, remote discovery
  is incomplete, an external save is running, or status is conflict/unknown/error.
  Engine ancestry and operation guards also apply to every dispatch.
- `setPaused(true)` gates remote actions for application-owned dialogs, discovery
  candidates outside this controller, or unresolved authoritative document saves.
  Resume only after resolution. Local preservation continues.
- `setOnline(false)` cancels the remote timer. Reconnection schedules dirty, ready
  input after the configured debounce; it does not treat connectivity as proof
  that an earlier operation failed. Browser `navigator.onLine` is only a hint.
- Remote discovery failures require an explicit `controller.reloadRemote()` after
  connectivity returns. A load is not a substitute for resolving an outstanding
  mutation. Conflicts and unknown ancestry require explicit reconciliation.
- `dispose()` unsubscribes and clears timers. It does not flush, dispose the
  controller, or cancel a request already sent. Reattach to the same controller to
  schedule remaining dirty input. A newly created controller discovers local
  candidates and waits for the user's recovery choice.

### Frozen retries versus saving newer input

There are **no automatic mutation retries**. After a retryable or unknown result,
show a Retry action that calls `autosave.retry()`. It reuses the engine's original
operation ID, revision and captured value, even if the user has since typed more.
It deliberately skips validation of newer input. Engine exponential backoff,
`retryAfterMs`, and replay-window expiry remain authoritative: an early retry
returns `retry_not_ready`, an expired one `replay_window_expired`, without sending.
Do not busy-loop on these results. Let the user retry later or supply an application
retry UI/timer that handles these guards. Never replace `retry()` with `save()`.

After retry succeeds, remaining newer input gets its own debounced save. After
expiry, verify remote state and explicitly reconcile; do not generate fresh IDs
for the uncertain operation. Permanent errors require application correction and
an explicit engine `controller.save()` to clear error status; the scheduler's
`save()` deliberately refuses unresolved error state. Results from direct engine
actions must be handled by the caller rather than `onResult`.

## UTF-8 remote limits

Keep remote size validation out of the shared codec so oversized drafts can still
be preserved locally. `validateRemote(value)` returns a `Failure` or `null`:

```ts
const autosave = createAutosaveScheduler(controller, {
  validateRemote(value) {
    const bytes = new TextEncoder().encode(JSON.stringify({ value })).byteLength;
    return bytes > 64 * 1024
      ? { kind: 'permanent', code: 'payload_too_large', message: 'Draft is too large for remote recovery.' }
      : null;
  },
});
```

Count the adapter's actual wire payload, including any envelope, rather than JS
string length. The adapter/backend must independently enforce its limit (including
calls made directly through the engine). Local storage still has its own quotas.
Report `payload_too_large` through `onResult`; later smaller input can autosave.

## Browser and router composition

The typechecked, executable [browser example](../contracts/browser-autosave-example.ts)
exports `connectBrowserAutosave(controller, window, session)`. Its integration is
covered by `tests/autosave.test.mjs` using browser events. Copy it into your app,
connect after mounting, and call `disconnect()` in effect cleanup. Keep
`session = createBrowserAutosaveSession()` with the editor session across reconnects.
Use immediate local writes with this example; it adds a `pagehide` flush rather
than a local debounce. Supply your status UI via the scheduler's `onResult` when
adapting the example.

The example demonstrates:

- `pagehide` starts a local flush. A browser need not wait for promises or fire the
  event at all. This is best effort, especially with asynchronous storage and on
  mobile/process termination. Regular local persistence is the primary defense.
- `beforeunload` requests the browser's generic warning only when work needs
  attention. Browsers may require prior user interaction or suppress the warning.
  No remote save is attempted during unload and no delivery guarantee is made.
- `confirmNavigation(confirm)` is called from an application-owned router blocker,
  navigation action, or link handler. It asks for confirmation and awaits local
  preservation before allowing navigation; it refuses on storage failure. Wire it
  to every relevant router entry point. It cannot universally intercept routes.
- `saveDocument(submit)` pauses autosave and retains a session gate for unknown
  authoritative outcomes. `documentResolutionComplete()` is only called after
  verifying the backend result and reconciling document identity in the app. If
  identity must change, recreate the controller with the verified document
  reference and preserve the appropriate local recovery choice.

For React, an effect may own this connection around an application-owned core
controller, with cleanup disconnecting the scheduler rather than destroying that
controller during effect replay. The current `useDraftRecovery` hook exposes
state/actions, not its internal controller; do not pass the hook result into this
factory or create a second controller for the same writer merely to attach it.
Keep session gates alive when hiding/remounting the editor; use a new controller
and session on a real scope/account change.

The package supplies debounce, local-write policy, explicit flush/retry actions,
and engine coordination. Applications supply adapters, status/recovery UI,
connectivity signals, retry policy, authoritative-outcome verification, and router
integration. No universal navigation blocker or guaranteed unload persistence is
implemented.
