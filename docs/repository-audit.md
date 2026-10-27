# README goal audit — 2026-10-27

Baseline: commit `24877fa`. The clean checkout contained only README.md. The README accurately labels all capabilities as planned, makes no installability claim, and explicitly excludes collaboration, automatic merging and universal navigation blocking. There is no contradiction between its stated status and the repository.

No implementation, dependency manifest, build, tests, license or workflows existed at baseline. Consequently, runtime correctness, compatibility, performance and security properties cannot be verified. The reference to patterns from a working CMS cannot be independently validated from this repository.

| README goal | Evidence / verification needed | Issue |
| --- | --- | --- |
| Flexible core and backend adapters | Missing API; specify revision/idempotency and validation contracts before implementation | [#1](https://github.com/frank-mendez/react-draft-recovery/issues/1) |
| Local recovery, scoped drafts, recoverable storage failures | Missing storage; test schema upgrades, corrupt records, quota failures, account changes and competing tabs | [#2](https://github.com/frank-mendez/react-draft-recovery/issues/2) |
| Preserve newer edits, explicit conflicts, retry | Missing engine; deterministic overlapping-save and stale-completion tests are the critical acceptance evidence | [#3](https://github.com/frank-mendez/react-draft-recovery/issues/3) |
| Custom UI, React hooks, TypeScript, SSR | Missing hooks/example; verify lifecycle, Strict Mode, server imports and typed adapters | [#4](https://github.com/frank-mendez/react-draft-recovery/issues/4) |
| Installable independent package | Missing manifest/license/build; verify actual packed exports and clean npm/pnpm consumers | [#5](https://github.com/frank-mendez/react-draft-recovery/issues/5) |
| Repeatable beta releases | Missing registry setup; establish ownership, trusted publisher and release checks | [#6](https://github.com/frank-mendez/react-draft-recovery/issues/6) |

Follow-up: issue #1 now has a [typed API and adapter contract](api-contract.md),
with compiler-checked examples. The table above records the original baseline;
runtime conformance remains work for the engine and concrete adapters.

Recommended order: settle the contracts and package foundation; implement storage and engine with adversarial tests; add React integration and examples; validate consumers; configure and publish beta. Stabilization requires real usage feedback after beta.

This change adds development checks, changelog/release PR automation, a gated manual npm publish workflow and a publishing runbook. It deliberately does not implement the library or mark README roadmap items complete. Release configuration is inert until repository variables are enabled. Workflow execution in GitHub and real publishing still require a pushed change and account setup.

Follow-up for issue #2: [local recovery](local-recovery.md) now has a concrete
localStorage adapter and tested session implementation, including scoped envelopes,
codec migration, expiration, failures, account cleanup and explicit competing-tab
recovery. The original table remains a baseline record. Remote coordination, React
integration and independent packaged consumers remain outstanding.

Follow-up for issue #3: the [recovery engine](recovery-engine.md) now implements
remote save/discard coordination, frozen retries, explicit reconciliation and
generation-based dirty tracking. Deterministic tests cover reordered responses,
response loss, tombstones and lifecycle isolation. Production backend conformance,
React integration and packaged-consumer checks remain separate work.
