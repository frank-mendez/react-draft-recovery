# React Draft Recovery

Flexible autosave and draft recovery for React forms and editors, with configurable storage, backend adapters, and explicit conflict handling.

> **Status: prerelease.** The npm beta includes the recovery engine, local storage helpers and React hook. Source on `main` can be ahead of npm; check the registry version before evaluating compatibility. See [release policy](docs/publishing.md#prerelease-channels-and-installation).

## Why this library?

Long forms and editors need more than a debounced save. A failed request, page reload, or competing browser tab can leave users unsure whether their work is safe.

React Draft Recovery aims to preserve unfinished work, make recovery explicit, and keep newer edits intact when earlier saves finish. Its design draws on draft recovery patterns developed in a working CMS and will generalize them for other React applications.

## Capabilities

- **Local recovery:** preserve drafts on the device and offer restoration after interruption.
- **Optional remote autosave:** connect your own persistence API through an adapter.
- **Safe save coordination:** preserve input typed while another save is in flight.
- **Explicit conflicts:** surface competing revisions instead of silently overwriting them.
- **Scoped drafts:** separate records by user, document, and editor instance.
- **Recoverable failures:** expose save and storage errors with retry actions.
- **Custom interfaces:** provide state and actions so applications control recovery dialogs, status indicators, and styling.
- **TypeScript support:** typed data, adapters, and recovery state.

APIs may change during the beta period. Check the release notes for your installed version.

## Designed for flexibility

The architecture separates a framework-independent recovery engine from its React integration.

| Boundary | Application controls |
| --- | --- |
| Draft data | Serializable form or editor values and runtime validation |
| Form integration | Plain React state or a form-library adapter |
| Local storage | A replaceable storage adapter, initially localStorage |
| Remote persistence | Loading, saving, and discarding through your own backend |
| User experience | Recovery choices, confirmations, errors, and navigation behavior |

The core does not require Next.js, Supabase, a particular editor, or a particular form library. React Hook Form integration is planned as an example rather than a required dependency.

## Persistence and safety boundaries

The library is intended to coordinate recovery; the application and backend remain responsible for authentication, authorization, validation, and atomic revision checks.

- Browser storage is best-effort persistence, not an encrypted vault or guaranteed backup.
- User-scoped storage keys do not replace access controls.
- Remote conflict detection and safe retries require the persistence adapter to implement the documented revision and idempotency contract.
- Recovery should require an explicit choice before replacing active input.
- Real-time collaboration and automatic conflict merging are outside the initial scope.
- Navigation integration will be documented per environment; universal route blocking is not an initial promise.

For backend integration, use the [remote adapter conformance suite and migration guide](docs/remote-adapters.md), including an executable reference adapter and tests showing why conditional writes alone are insufficient.

## Installation

The package name is `react-draft-recovery`, licensed under MIT. Install the current npm beta explicitly with either package manager:

```sh
npm install react-draft-recovery@beta
# or
pnpm add react-draft-recovery@beta
```

An unversioned install uses `latest`, which remains on the historical bootstrap
`0.1.0-beta.0` until a reviewed stable release. Beta publications advance only
`beta`; neither tag is inferred from the version in this repository.

For reproducible consumer compatibility evaluation, inspect the channel and pin
its exact version (the example below was verified on 2026-11-03):

```sh
npm view react-draft-recovery dist-tags --json
npm install --save-exact react-draft-recovery@0.1.0-beta.1
# or
pnpm add --save-exact react-draft-recovery@0.1.0-beta.1
```

Commit the consumer lockfile. See the [beta.0 → beta.1 migration notes](CHANGELOG.md#beta0-to-beta1-migration).

React applications must also install React 18.3.1+ or 19. To build and verify a local tarball:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:package
pnpm exec playwright install chromium
pnpm test:adoption
npm pack
```

The [consumer adoption checklist](docs/adoption-checklist.md) explains the
repository verification gate and the application-specific checks needed before
replacing an existing recovery feature. Its browser fixture uses Chromium; it does
not certify every browser, backend, authentication system, or router.

Install the generated tarball reported by `npm pack` in another project
with `npm install /path/to/package.tgz` or `pnpm add /path/to/package.tgz`.
React applications must also install React separately.

```ts
import { useDraftRecovery } from 'react-draft-recovery';
// Equivalent hook entry: 'react-draft-recovery/react'
import { createRecovery, createLocalStorageAdapter } from 'react-draft-recovery/core';
import type { Codec, RecoveryEngineOptions } from 'react-draft-recovery/core';
```

The core entry does not import React or access browser globals during import.
React is an optional peer so core-only applications do not install it; it is
required when using the hook. The React entry preserves its `"use client"` directive.

Supported package format is ESM (no CommonJS export), targeting ES2022. Node.js
22.14+ is supported for consumers starting with published beta.1; beta.0 requires
Node 24. Development and source tests use Node 24+. React 18.3.1+ and 19 are supported;
the tarball is tested with 18.3.1 and 19.2.0, and TypeScript 5.9.3 using NodeNext
and Bundler resolution. Browser applications need a modern ES2022-capable runtime
and bundler; browser storage remains optional through the storage adapter.

## Developing from source

Use Node 24+ for repository development and source tests (`nvm use` reads the
provided `.nvmrc`). The package `engines.node >=22.14` floor applies to consumers
of compiled package exports; it does not promise that uncompiled TypeScript tests
run on Node 22.14. CI tests source on Node 24 and packed consumers on Node 22.14.

```sh
nvm use
pnpm install --frozen-lockfile
pnpm test
```

## Roadmap

- [x] Define the [public API and persistence adapter contract](docs/api-contract.md).
- [x] Implement versioned local recovery storage.
- [x] Implement and test the recovery engine, including overlapping saves and retries.
- [x] Add React hooks and a minimal example application.
- [x] Verify account isolation, competing tabs, storage failures, and server rendering in the [consumer adoption gate](docs/adoption-checklist.md).
- [x] Validate the packed package in independent npm and pnpm consumer applications.
- [x] Publish the initial beta with documentation.
- [ ] Configure and verify trusted publishing for repeatable automated releases.
- [ ] Stabilize the API based on real usage and feedback.

## Contributing

The project is in early implementation. Use [GitHub Issues](https://github.com/frank-mendez/react-draft-recovery/issues) to share use cases, expected recovery behavior, and integration requirements.

Development setup, contribution guidelines, and compatibility details will be added alongside the implementation. Please discuss substantial changes in an issue before starting a pull request.

## Repository verification and release process

See the [README goal audit](docs/repository-audit.md) for findings and linked implementation issues, the [consumer adoption checklist](docs/adoption-checklist.md) for compatibility evidence and replacement readiness, and the [development and publishing guide](docs/publishing.md) for CI, changelog automation, npm setup and pnpm installation guidance. The workflows verify the package; publication remains a separate release step.

### Cross-writer recovery discovery

Use `createRecoveryDiscovery` from `react-draft-recovery/core` with the built-in
storage adapter's `discovery` capability to offer drafts from earlier editor
instances or build an account-scoped unfinished-document list. Candidates have
stable IDs and explicit restore/discard actions; discovery preserves active input.
Consumer adapters can expose legacy records for import to independent writer keys.
See the [discovery and migration guide](docs/recovery-discovery.md).

### Authoritative document saves and publication

Use `saveDocument(submit)` to pause and drain recovery autosave around an external
save. It acknowledges the submitted snapshot, preserves later edits, and tracks
the document ID/version separately from working-copy revisions. Validation and
editorial approval remain application-owned. See the [external-save guide](docs/external-saves.md).

### Opt-in autosave scheduling

Use `createAutosaveScheduler` from `react-draft-recovery/core` for configurable
remote debounce and optional local debounce. The engine defaults to immediate
local preservation; remote scheduling is opt-in and retries stay explicit.
See the [autosave and browser lifecycle guide](docs/autosave.md) for frozen retries,
UTF-8 payload limits, pagehide flushing, unload warnings, and route confirmation.

Equivalent local copies remain stored after remote saves. On reopening, the engine
suppresses redundant recovery candidates only when the initial value, remote value,
and local value have identical codec encodings and matching revision evidence.
See the [clean-copy policy](docs/recovery-engine.md#save-acknowledgements-and-initial-discovery)
for loading behavior, competing writers, and local persistence failures.

For typing before remote discovery finishes, see the [early-edit reconciliation guide and runnable example](docs/early-edit-reconciliation.md). Local/hook readiness does not imply remote save readiness.
