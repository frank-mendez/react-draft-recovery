# React Draft Recovery

Flexible autosave and draft recovery for React forms and editors, with configurable storage, backend adapters, and explicit conflict handling.

> **Status: early development.** The repository includes a tested [local recovery primitive](docs/local-recovery.md) and a framework-independent [recovery engine](docs/recovery-engine.md). A typed [React hook and runnable example](docs/react.md) are available in source; the initial ESM beta is available on npm. The initial [typed API contract](docs/api-contract.md) is defined for implementation.

## Why this library?

Long forms and editors need more than a debounced save. A failed request, page reload, or competing browser tab can leave users unsure whether their work is safe.

React Draft Recovery aims to preserve unfinished work, make recovery explicit, and keep newer edits intact when earlier saves finish. Its design draws on draft recovery patterns developed in a working CMS and will generalize them for other React applications.

## Planned capabilities

- **Local recovery:** preserve drafts on the device and offer restoration after interruption.
- **Optional remote autosave:** connect your own persistence API through an adapter.
- **Safe save coordination:** preserve input typed while another save is in flight.
- **Explicit conflicts:** surface competing revisions instead of silently overwriting them.
- **Scoped drafts:** separate records by user, document, and editor instance.
- **Recoverable failures:** expose save and storage errors with retry actions.
- **Custom interfaces:** provide state and actions so applications control recovery dialogs, status indicators, and styling.
- **TypeScript support:** typed data, adapters, and recovery state.

These are development goals, not guarantees of a released implementation.

## Designed for flexibility

The planned architecture separates a framework-independent recovery engine from its React integration.

| Boundary | Application controls |
| --- | --- |
| Draft data | Serializable form or editor values and runtime validation |
| Form integration | Plain React state or a form-library adapter |
| Local storage | A replaceable storage adapter, initially localStorage |
| Remote persistence | Loading, saving, and discarding through your own backend |
| User experience | Recovery choices, confirmations, errors, and navigation behavior |

The core will not require Next.js, Supabase, a particular editor, or a particular form library. React Hook Form integration is planned as an example rather than a required dependency.

## Persistence and safety boundaries

The library is intended to coordinate recovery; the application and backend remain responsible for authentication, authorization, validation, and atomic revision checks.

- Browser storage is best-effort persistence, not an encrypted vault or guaranteed backup.
- User-scoped storage keys do not replace access controls.
- Remote conflict detection and safe retries require the persistence adapter to implement the documented revision and idempotency contract.
- Recovery should require an explicit choice before replacing active input.
- Real-time collaboration and automatic conflict merging are outside the initial scope.
- Navigation integration will be documented per environment; universal route blocking is not an initial promise.

## Installation

The package name is `react-draft-recovery`, licensed under MIT. Install the initial beta with either package manager:

```sh
npm install react-draft-recovery@beta
# or
pnpm add react-draft-recovery@beta
```

React applications must also install React 18.3.1+ or 19. To build and verify a local tarball:

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test:package
npm pack
```

Install the generated `react-draft-recovery-0.1.0-beta.0.tgz` in another project
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
22.14+ is supported for consumers in the next release; published beta.0 requires
Node 24. Development and source tests use Node 24+. React 18.3.1+ and 19 are supported;
the tarball is tested with 18.3.1 and 19.2.0, and TypeScript 5.9.3 using NodeNext
and Bundler resolution. Browser applications need a modern ES2022-capable runtime
and bundler; browser storage remains optional through the storage adapter.

## Roadmap

- [x] Define the [public API and persistence adapter contract](docs/api-contract.md).
- [x] Implement versioned local recovery storage.
- [x] Implement and test the recovery engine, including overlapping saves and retries.
- [x] Add React hooks and a minimal example application.
- [ ] Verify account isolation, competing tabs, storage failures, and server rendering.
- [x] Validate the packed package in independent npm and pnpm consumer applications.
- [x] Publish the initial beta with documentation.
- [ ] Configure and verify trusted publishing for repeatable automated releases.
- [ ] Stabilize the API based on real usage and feedback.

## Contributing

The project is in early implementation. Use [GitHub Issues](https://github.com/frank-mendez/react-draft-recovery/issues) to share use cases, expected recovery behavior, and integration requirements.

Development setup, contribution guidelines, and compatibility details will be added alongside the implementation. Please discuss substantial changes in an issue before starting a pull request.

## Repository verification and release process

See the [README goal audit](docs/repository-audit.md) for findings and linked implementation issues, and the [development and publishing guide](docs/publishing.md) for CI, changelog automation, npm setup and pnpm installation guidance. The workflows verify the package; publication remains a separate release step.
