# Changelog

## [0.1.0-beta.2](https://github.com/frank-mendez/react-draft-recovery/compare/v0.1.0-beta.1...v0.1.0-beta.2) (2026-10-27)


### Bug Fixes

* tolerate npm registry propagation after publication ([#17](https://github.com/frank-mendez/react-draft-recovery/issues/17)) ([65e8c3c](https://github.com/frank-mendez/react-draft-recovery/commit/65e8c3cdd74a65a77cfb175ab4b874672ae87ba4))

## [0.1.0-beta.1](https://github.com/frank-mendez/react-draft-recovery/compare/v0.1.0-beta.0...v0.1.0-beta.1) (2026-10-27)


### Features

* add publishable package and packed consumer validation ([#14](https://github.com/frank-mendez/react-draft-recovery/issues/14)) ([25b3123](https://github.com/frank-mendez/react-draft-recovery/commit/25b3123359c5f4c865471ec8e0eb86b3c9b6fea4))
* add typed React recovery hook and lifecycle coverage ([a3b8e4e](https://github.com/frank-mendez/react-draft-recovery/commit/a3b8e4ef3970b87202e561a2c7ee1dc62fc2d598))
* add typed React recovery hook and SSR-safe lifecycle ([de982de](https://github.com/frank-mendez/react-draft-recovery/commit/de982de9172977077e7787aa27929bbab78716f5))
* implement recovery engine with deterministic concurrency and retries ([2c7bee9](https://github.com/frank-mendez/react-draft-recovery/commit/2c7bee9749ae78c958b1688cc48868a92bfe1052))
* implement recovery engine with deterministic save coordination ([26e4907](https://github.com/frank-mendez/react-draft-recovery/commit/26e49073e7f7e41b3a0e8a7e37d7a6b2a834e9af))
* implement scoped local draft recovery ([dbc6011](https://github.com/frank-mendez/react-draft-recovery/commit/dbc601167759771f28626433ffa7d08b85b637fa))
* implement versioned scoped local draft recovery ([3696604](https://github.com/frank-mendez/react-draft-recovery/commit/3696604078950135b0a600a0fd0b9a3b7f13a34a))


### Bug Fixes

* clarify recovery states and secure contract checks ([291eb35](https://github.com/frank-mendez/react-draft-recovery/commit/291eb35a7c74624f4a3bbb68e60f7ac5b91cda8d))
* handle retryable storage failures and session lifecycle races ([4a805fd](https://github.com/frank-mendez/react-draft-recovery/commit/4a805fde230b9b3d1a6ae2e74aebeb6ba3f087da))
* preserve draft ancestry and queue edits during local discard ([b5fdab8](https://github.com/frank-mendez/react-draft-recovery/commit/b5fdab84098960e69245248c96391665cc956344))
* preserve recovery sessions across React effect replay ([40a8e49](https://github.com/frank-mendez/react-draft-recovery/commit/40a8e49fdbb112bb1f7186e4bd833662b70cb4a3))

## 0.1.0-beta.0 (2026-10-27)

Initial beta published to npm from [v0.1.0-beta.0](https://github.com/frank-mendez/react-draft-recovery/tree/v0.1.0-beta.0) (`2890d88`).

- Framework-independent draft recovery engine, typed storage contracts and local storage helpers.
- React hook with autosave coordination and recovery lifecycle support.
- ESM exports for the core and React, TypeScript declarations, and optional React peer dependency.

This bootstrap release has no registry provenance attestation. Future releases use trusted publishing. Release Please maintains subsequent entries through reviewed release PRs; see [publishing](docs/publishing.md).
