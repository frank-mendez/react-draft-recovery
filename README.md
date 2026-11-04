# React Draft Recovery

Flexible autosave and draft recovery for React forms and editors, with configurable storage, backend adapters, and explicit conflict handling.

> **Status: stable 0.x.** `0.1.0` is the first stable release of the recovery engine, local storage helpers and React hook. See [compatibility and versioning](#compatibility-and-versioning) for what 0.x releases promise.

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

The public API follows [Semantic Versioning for 0.x releases](#compatibility-and-versioning). Check the release notes before upgrading across minor versions.

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

The package name is `react-draft-recovery`, licensed under MIT. Install the stable release with either package manager:

```sh
npm install react-draft-recovery
# or
pnpm add react-draft-recovery
```

Unversioned installs use the `latest` dist-tag, which carries stable releases.
Prereleases, when published, use the `beta` dist-tag and never move `latest`.
Commit the consumer lockfile. Upgrading from a `0.1.0-beta.*` version? See the
[changelog](CHANGELOG.md), including the [beta.0 → beta.1 migration notes](CHANGELOG.md#beta0-to-beta1-migration).

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
22.14+ is supported for consumers. Development and source tests use Node 24+. React 18.3.1+ and 19 are supported;
the tarball is tested with 18.3.1 and 19.2.0, and TypeScript 5.9.3 using NodeNext
and Bundler resolution. Browser applications need a modern ES2022-capable runtime
and bundler; browser storage remains optional through the storage adapter.

## Compatibility and versioning

The public API is everything exported from the three package entry points:

| Entry | Contents |
| --- | --- |
| `react-draft-recovery` and `react-draft-recovery/react` | `useDraftRecovery` and its types |
| `react-draft-recovery/core` | `createRecovery`, `createLocalRecovery`, `createLocalStorageAdapter`, `storageKey`, `createRecoveryDiscovery`, `createAutosaveScheduler`, and the contract types in [docs/api-contract.md](docs/api-contract.md) |

Deep imports into `dist/` are not supported. Releases follow Semantic Versioning
with the usual 0.x convention:

- **Patch (`0.1.x`)**: bug fixes and documentation only; no changes to public
  types, result codes or the persisted local record format.
- **Minor (`0.x.0`)**: may add features and may include breaking API changes.
  Breaking changes are marked `!` in commit titles and called out in the changelog.
- **Local record format**: stored drafts written by an earlier release remain
  readable, or are reported through the documented codec/version failure
  instead of being silently dropped.

`1.0.0` will follow once the API has held steady through real-world adoption.

Supported environments: ESM only (ES2022), Node.js 22.14+, React 18.3.1+ or 19,
and TypeScript 5.9+ with NodeNext or Bundler resolution.

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
- [x] Configure and verify trusted publishing for repeatable automated releases.
- [x] Publish the first stable 0.x release.
- [ ] Gather real-world adoption feedback before committing to a 1.0 API.

## Contributing

Use [GitHub Issues](https://github.com/frank-mendez/react-draft-recovery/issues) to share use cases, expected recovery behavior, and integration requirements.

See [Developing from source](#developing-from-source) for setup and [compatibility and versioning](#compatibility-and-versioning) for support policy. Please discuss substantial changes in an issue before starting a pull request.

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
