# Recovery engine implementation plan

**Goal:** Implement issue #3's framework-independent recovery controller and deterministic concurrency/retry tests.

**Spec:** `docs/api-contract.md` and issue #3; the existing contract is the approved design.

**Architecture:** Compose the existing local recovery primitive with a remote state machine. Track remote acknowledged generations independently of local persistence. Serialize remote mutations, retain a detached request across retries, and invalidate completion effects on disposal. Local writes continue independently of remote failures.

**Tech stack:** TypeScript, Node.js 24 native test runner; no new dependencies.

## Tasks

- [x] Add failing tests in `tests/recovery-engine.test.mjs` for creation, background discovery, dirty generations, mutation guards, conflicts, retries, replay expiry, local recovery and disposal. Use deferred adapter responses and an injected monotonic clock; no sleeps.
- [x] Implement `createRecovery` in `src/recovery-engine.ts`, conforming to `RecoveryController`. Add optional runtime clock/operation ID injection, and `persistLocal()` for explicit local storage retry/durability. Use capped backoff for explicit retries; no automatic network retry loop.
- [x] Test competing controllers with an atomic in-memory revision/idempotency adapter, including response loss, reordered responses and tombstones. Add edge tests for observer reentrancy, failures, and disposal.
- [x] Update contract/README and add engine documentation with observable transitions, timing policy, and remaining limitations.
- [x] Run typecheck, all tests, repository checks, and independent code review.

Delivery: commit and push the feature branch, then create a PR against `main` closing #3.

## Review focus

- Adapter exceptions during mutations are ambiguous; never invent a new key on retry.
- New edits, restore and local persistence must not become clean when an older save completes.
- Notifications can reenter actions; guards must exist before notifying observers.
- Caller mutation must not alter frozen request identity, scope or payload.
- Disposed controllers and old-account completions must never update current state.

## Execution notes

The user requested implementation and a PR after reviewing the existing contract in the investigation. Proceed directly using that contract. The engine retains explicit save/retry actions; debounce and React integration remain separate. `persistLocal()` fills the contract's missing explicit retry action for local write failures without conflating local durability with remote acknowledgement.

## Verification record

- Initial controller tests: 13 expected failures against the unimplemented factory, then 13 passes.
- Dependency validation, scope capture and immutable input tests: 3 observed failures, fixed; full suite 62/62.
- Clock rollback regression: observed failure, fixed; full suite 67/67.
- Independent review found codec reentry acknowledging unpublished generations, two-read retry clock safety, and mutable error return values. All three reproduced as failing tests and fixed; full suite 70/70.
- Locked dependency installation, strict typecheck, repository metadata check and whitespace validation pass.
- No review findings deferred.

## Review feedback follow-up

- Reproduced five failures covering stale restore ancestry, local edits during removal, dirty reloads, edits during reload, and stale restore during an in-flight save.
- Separate the active input base from observed remote state. Preserve restored revision metadata, including null/unknown ancestry; reconciliation explicitly chooses a new base.
- Serialize local persistence behind an engine-managed removal task, retaining automatic writes requested during removal.
- Added eight regression tests in total, including automatic persistence, unknown-base recovery and disabled-remote guards. Strict typecheck and full suite pass (78/78).
- Independent review confirmed one additional missing remote guard for null-base reconciliation; regression reproduced and fixed. No findings deferred.
