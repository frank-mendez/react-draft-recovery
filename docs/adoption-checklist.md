# Consumer adoption checklist

Use this gate before describing the library as ready to replace an existing
application's recovery feature. It combines package checks, source-level
conformance tests, and a small browser consumer; it does not certify a particular
CMS, database, authentication system, or router.

## Repository gate

Run these checks on the proposed release commit:

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
pnpm exec playwright install chromium
pnpm test:adoption
```

CI runs the same checks, installing Chromium with its system dependencies. The
packed-package check installs the generated tarball into separate npm and pnpm
consumers, verifies React 18.3.1 and 19.2.0, SSR rendering, TypeScript resolution,
exports, and core-only imports. The browser fixture installs the tarball into a
separate Vite consumer and runs under React 18.3.1 and 19.2.0 in Chromium with
React StrictMode enabled.

The fixture covers reload recovery with an explicit restore, separate editor
scopes, a live competing-tab storage event, A-to-B-to-A account changes with a
late response, blocked and quota-exceeded storage, delayed and uncertain remote
saves, external document creation, legacy import, cleanup failure, and the
reference beforeunload handler, router, and pagehide flow. It uses synthetic
local storage and an in-memory remote service; it never connects to a production
database or loads user drafts.

## Guarantee boundaries

| Boundary | Evidence in this repository | Consumer still owns |
| --- | --- | --- |
| Package and React integration | [Packed-consumer checks](../scripts/test-package.mjs), including React 18/19 SSR and types; [browser consumer](../adoption/consumer.browser.mjs) uses the built tarball under React 18.3.1 and 19.2.0 with StrictMode | Validate the exact version and React/runtime matrix used by the application |
| Recovery engine | [Engine tests](../tests/recovery-engine.test.mjs), [storage tests](../tests/local-recovery.test.mjs), and [discovery tests](../tests/recovery-discovery.test.mjs) cover frozen retries, stale results, account scope, storage failures, local contention, and explicit restore | Choose product recovery prompts and handle each returned result |
| Remote adapter contract | [Conformance suite](../tests/remote-adapter-conformance.test.mjs) and [adapter guide](remote-adapters.md) exercise revision, idempotency, authorization, conflicts, and response-loss behavior against an isolated reference fixture | Run the suite against the application's real transactional test backend and trusted authentication boundary |
| Legacy import | [Example adapter](../adoption/consumer/legacy-adapter.mjs), [normalization tests](../adoption/legacy-adapter.test.mjs), and browser import flow whitelist editable content and retain the source after failed cleanup | Map and validate the application's real legacy schema; explicitly decide when source cleanup is appropriate |
| External document save | [Document-save tests](../tests/document-save.test.mjs) and browser fixture cover delayed acknowledgement, creation identity, and edits made during publication | Verify application validation, authorization, publication, and identity reconciliation |
| Browser navigation | [Chromium adoption tests](../adoption/consumer.browser.mjs) check the beforeunload handler, router confirmation, and pagehide behavior | Integrate every router entry point and test the actual browsers and devices the application supports |

## Application-specific checks before replacement readiness

- Run remote conformance against a real test database and application auth rules;
  never treat client-supplied scope as authorization.
- Test import against the application's legacy formats. Whitelist editable fields
  so draft data cannot restore review, approval, publication, ownership, or other
  application workflow state.
- Exercise account logout, account switching, separate editor identities, reload,
  competing tabs, storage quota, unavailable storage, delayed saves, response loss,
  external saves, and cleanup failures with the application's adapters.
- Verify recovery choices, validation errors, conflict resolution, and retry UI in
  the actual form or editor.
- Test route blocking in each router entry point. `pagehide` is best effort;
  browsers may suppress `beforeunload` prompts, and neither event guarantees an
  asynchronous write will finish.
- Record the application's browser matrix. Chromium is the reference browser
  exercised here. Firefox, WebKit, mobile lifecycle behavior, and browser versions
  outside the CI-managed Chromium build are not certified by this repository.

## Adoption decision

Claim replacement readiness only when the repository gate passes and the consuming
application has recorded passing results for its backend, authentication boundary,
legacy migration, approval-field isolation, router integration, and supported
browsers. The library coordinates recovery state; it does not prove those
application-owned behaviors on its own.
