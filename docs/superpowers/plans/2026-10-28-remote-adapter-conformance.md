# Remote Adapter Conformance Implementation Plan

**Goal:** Implement issue #19 without weakening the existing RemoteAdapter contract.
**Architecture:** A reusable Node assertion suite accepts an isolated backend fixture;
a typed in-memory reference backend demonstrates transactions, receipts, tombstones,
and authenticated identity. A deliberately naive conditional-write fixture proves
that current-row retry recognition is insufficient.
**Tech stack:** Existing TypeScript and Node 24 test runner; no new dependencies.
**Spec:** GitHub issue #19 and docs/api-contract.md.

## Constraints and review focus

- Preserve the exact user/document/editor tuple and separate authenticated identity.
- Exercise both mutation kinds, concurrent CAS, retained conflict/permanent receipts,
  canonical payload identity, denied replays, scope isolation, and detached results.
- Keep consumer database migrations and authorization policy outside the library.
- Source-level reusable tooling; no new runtime package exports.

## Tasks

- [x] Add contracts/remote-adapter-conformance.mjs with independent, named cases and
  a factory lifecycle (fresh fixture and optional cleanup per case). Verify failures
  against tests/fixtures/naive-remote-adapter.mjs before adding the reference adapter.
- [x] Add contracts/reference-remote-adapter.ts, implementing RemoteAdapter with
  synchronous atomic sections, canonical JSON fingerprints and detached receipts.
  Run the same cases against it from tests/remote-adapter-conformance.test.mjs.
- [x] Document fixture integration, limitations, stream mapping, transaction schema,
  replay retention, failure classification and migration in docs/remote-adapters.md;
  link from README and the API contract.
- [x] Run targeted tests, full tests, lint, typecheck, build and package smoke checks;
  review the final diff for acceptance coverage and unintended changes.

## Verification

127 tests passed; lint, typecheck, build and package smoke checks passed.
Independent review identified validation-before-cloning and frozen-clock fixture
requirements; both were addressed, with regression cases for unsupported values.
