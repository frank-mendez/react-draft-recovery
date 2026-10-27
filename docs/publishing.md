# Development, changelog and publishing

The repository builds the MIT-licensed `react-draft-recovery` ESM package.
`0.1.0-beta.0` was published with the `beta` tag from tag [`v0.1.0-beta.0`](https://github.com/frank-mendez/react-draft-recovery/tree/v0.1.0-beta.0)
(commit `2890d88`). This tag preserves the exact published source even if the PR is squash-merged.
Future automated releases still require the trusted publisher configuration below.

## Development

Use Node.js 24+ and pnpm 10.29.3 (the exact `packageManager` pin).

```sh
pnpm install --frozen-lockfile
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm test:package
```

`build` cleans `dist` and emits JavaScript plus declarations with TypeScript.
React stays an external optional peer, required for the hook but unnecessary for
`react-draft-recovery/core`. The root and `/react` exports expose the hook;
`/core` exports the engine, local storage helpers and public contracts.
Only `dist`, README, LICENSE and package metadata enter the tarball. `prepack`
rebuilds it to prevent stale output.

`test:package` packs the real artifact and installs it in temporary projects
outside the repository using both npm and pnpm. Each manager tests a core-only
installation without React, plus React 18.3.1 and 19.2.0 consumers with SSR and
TypeScript 5.9.3 in NodeNext and Bundler modes. It checks the packed license,
file allowlist, declarations, exports and preserved client directive. Temporary
projects are removed even on failure. The existing React suite tests browser
lifecycle behavior separately. ESM/ES2022 and Node 22.14+ consumers are supported; no CommonJS
entry or older TypeScript compatibility is advertised. CI runs packed consumer checks
on Node 22.14 as well as Node 24. The already-published beta.0 manifest requires
Node 24; the broader engine range applies to the next release.

## Changelog and versions

Use Conventional Commits for squash merge titles (`feat:`, `fix:`, `docs:`, `chore:`; `!` for breaking changes). Release Please opens a PR updating package.json, CHANGELOG.md and its manifest; merging that PR produces a GitHub tag/release. Review the version and notes before merging.

The manifest records the published 0.1.0-beta.0, with beta prerelease versioning. Keep it aligned with the latest released version. Check the first generated version before merging. When graduating to stable, change the prerelease configuration and explicitly select the intended stable version in a reviewed release PR.

Enable the repository variable `RELEASE_ENABLED=true` only once package.json and the implementation are ready. Permit Actions to create PRs in repository settings. Set `RELEASE_PLEASE_TOKEN` to a suitably scoped GitHub App/user token if automated PRs need to trigger CI. The fallback GITHUB_TOKEN cannot trigger workflows through its own PR events. The changelog workflow explicitly dispatches Development on the generated PR branch using its actions:write permission; workflow_dispatch is supported with GITHUB_TOKEN. This also reruns validation when the release PR changes. If dispatch fails, manually run Development on that branch. Required checks must still pass before merge.

## npm preparation

1. Review release readiness in [issue 6](https://github.com/frank-mendez/react-draft-recovery/issues/6). Registry ownership is confirmed as frankmendez8, matching the authenticated maintainer. Account 2FA is enabled for auth-and-writes and the email is verified (checked 2026-10-27).
2. Review the confirmed MIT license and package metadata, supported runtimes, exports and optional React peer before release.
3. Inspect the actual packed tarball and run both consumer installations. Ensure the README's examples work, and exclude credentials, fixtures and unnecessary source/build files. A metadata check alone cannot establish a working release.
4. Set up the npm maintainer account and its required authentication. If the new package cannot yet have a trusted publisher configured, publish the first tested real beta from an authenticated maintainer session (`npm publish <verified-tarball> --access public --tag beta`). Do not publish a placeholder merely to enable automation. Record the corresponding source tag/version and align the release manifest.
5. Configure npm trusted publishing for GitHub owner `frank-mendez`, repository `react-draft-recovery`, workflow filename `release.yml`, environment `npm`, with publishing allowed. Use GitHub-hosted runners. The workflow uses Node 24 and OIDC (`id-token: write`); npm requires CLI >=11.5.1 and Node >=22.14.0. No NPM_TOKEN is needed for this path.
6. Create/protect the GitHub `npm` environment, restrict it to main, and configure required reviewers if desired. Protect main and release tags. Enable `NPM_PUBLISH_ENABLED=true` after setup and verification.

## Publishing and recovery

Run **Publish npm release** manually from **main**, supplying the reviewed tag (for example `v0.1.0-beta.1`). The workflow requires that the tag is on main, checks out its exact source, verifies version/metadata, runs all package checks, packs, then publishes the tarball. Beta versions use the `beta` dist-tag; stable versions use `latest`. npm provenance is requested. Changelog generation and publication are separate deliberately: tags created with GITHUB_TOKEN do not start another workflow automatically.

After publication, the workflow runs scripts/verify-registry.mjs with --require-provenance. It checks the version, beta/latest dist-tag, owner and attestation metadata, installs the published version using npm and pnpm, exercises core recovery and React SSR, and verifies registry signatures/attestations with npm audit signatures. If publishing fails, inspect npm first: a network error may occur after a successful upload. If that exact version is absent, fix the external configuration and dispatch the same tag again. Published versions cannot be overwritten; source changes require a new version/tag and release PR. A GitHub release can exist while npm publication is still pending.

There is one publication destination: the npm registry. pnpm is a package manager that consumes it. Users can run `npm install react-draft-recovery@beta` or `pnpm add react-draft-recovery@beta`. The initial published version is `0.1.0-beta.0`.

## References

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [Release Please Action and token behavior](https://github.com/googleapis/release-please-action)
- [pnpm action setup](https://github.com/pnpm/action-setup)

## Readiness record (2026-10-27)

- Published beta.0 and owner `frankmendez8` confirmed against npm; the authenticated maintainer has verified email and 2FA for sign-in and writes.
- The bootstrap release currently has both `beta` and `latest` dist-tags. Subsequent beta publishes explicitly target `beta` and do not move `latest`. Install `@beta` during prerelease development.
- beta.0 has no provenance attestation. This cannot be added retroactively by editing the changelog; the next version must be published through OIDC.
- GitHub Actions may create release PRs. Default token permissions remain read-only; workflow jobs request only their required permissions.
- GitHub environment `npm` exists and accepts deployments only from the `main` branch.
- The maintainer configured the npm trusted publisher for frank-mendez/react-draft-recovery, release.yml, environment npm, with publish permission. npm shows Pending validation: a successful workflow publication is required before October 29, 2026 at 15:47 UTC. Release variables remain unset until the workflow merge and readiness review are complete. No release PR token is stored: the explicit validation dispatch supports the built-in token.

Configure the npm trusted publisher on the package settings page, or with npm >=11.15:

```sh
npm trust github react-draft-recovery --repo frank-mendez/react-draft-recovery --file release.yml --env npm --allow-publish
npm trust list react-draft-recovery
```

Complete npm's browser/2FA prompt yourself. Confirm the exact repository, workflow, environment and publish permission. After merging and reviewing readiness, set `RELEASE_ENABLED=true` and `NPM_PUBLISH_ENABLED=true` in repository Actions variables. Run **Changelog and release PR**, review its generated beta version/changelog and passing Development checks, then merge the release PR. Release Please creates the version tag and GitHub release with changelog notes; run **Publish npm release** on main for that tag.

To verify an already published version without attempting another upload:

```sh
node scripts/verify-registry.mjs v0.1.0-beta.0
# Future OIDC releases must also pass provenance verification:
node scripts/verify-registry.mjs v0.1.0-beta.1 --require-provenance
```

If the post-publish check fails, inspect the registry before retrying. If the version exists, rerun only verification; do not republish. Allow registry propagation time before repeating checks. Missing provenance on a new release requires investigating the OIDC publishing path and a new version; never overwrite tags or published versions.

## Stable promotion

In a reviewed change to release-please-config.json, remove `prerelease-type`, set `prerelease` to false and `versioning` to `default`, and temporarily set `release-as` to the intended stable version (for example `0.1.0`). Review the generated release PR, package version and changelog; merge only after validation passes. Remove the one-time `release-as` override afterward. Publish its stable tag through release.yml; the workflow selects `latest`. Verify the stable version with `--require-provenance`. Retain the beta channel for prerelease consumers; do not move it to stable implicitly.

### Registry propagation after publishing

npm may accept an upload before its read endpoints expose the version. Metadata
verification retries npm E404 responses up to 12 attempts, ten seconds apart.
Authentication, malformed responses and verification failures still fail immediately.
If publication succeeded but verification failed, run **Verify published npm release**
(`verify-release.yml`) from main with the published tag. This workflow uses current
verification tooling and performs no publication. Do not rerun the original publish
job for a version that already exists.
