# React Draft Recovery

Flexible autosave and draft recovery for React forms and editors, with configurable storage, backend adapters, and explicit conflict handling.

> **Status: early development.** This repository currently describes the planned library. An installable package and public API are not available yet.

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

The package has not been published. Installation instructions will be added after the first release and package name are confirmed.

The plan is to publish one package to the npm registry, installable with either npm or pnpm.

## Roadmap

- [ ] Define the public API and persistence adapter contract.
- [ ] Implement versioned local recovery storage.
- [ ] Implement and test the recovery engine, including overlapping saves and retries.
- [ ] Add React hooks and a minimal example application.
- [ ] Verify account isolation, competing tabs, storage failures, and server rendering.
- [ ] Validate the packed package in independent consumer applications.
- [ ] Publish a beta with documentation and a repeatable release workflow.
- [ ] Stabilize the API based on real usage and feedback.

## Contributing

The project is in its design phase. Use [GitHub Issues](https://github.com/frank-mendez/react-draft-recovery/issues) to share use cases, expected recovery behavior, and integration requirements.

Development setup, contribution guidelines, and compatibility details will be added alongside the implementation. Please discuss substantial changes in an issue before starting a pull request.
