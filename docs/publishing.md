# Development, changelog and publishing

The repository has local recovery source and tests, but is not yet an installable library. Automation is staged for the future package; enabling it is not a substitute for the README's acceptance criteria.

## Development

Use Node.js 24. Run `node scripts/check-repository.mjs` for repository checks, then
`npm ci --prefix contracts --ignore-scripts`, `npm run --prefix contracts typecheck`
and `npm run --prefix contracts test` to compile the contracts/local source and run
example and local recovery tests. Development CI runs these on PRs and pushes to
main. Full package/build verification remains unavailable while root package.json
is absent.

When implementing the package, commit an exact `packageManager: pnpm@X.Y.Z` pin and pnpm-lock.yaml. CI will then require `lint`, `typecheck`, `test`, `build`, and `test:package`, run after `pnpm install --frozen-lockfile`. Tests must exit rather than watch. The package test must pack the build and install that tarball into independent npm and pnpm consumers, exercising declarations, supported exports, React rendering and server imports. Define the supported React/Node/TypeScript matrix and expand CI accordingly before advertising compatibility.

## Changelog and versions

Use Conventional Commits for squash merge titles (`feat:`, `fix:`, `docs:`, `chore:`; `!` for breaking changes). Release Please opens a PR updating package.json, CHANGELOG.md and its manifest; merging that PR produces a GitHub tag/release. Review the version and notes before merging.

The initial manifest seed is 0.1.0-beta.0, with beta prerelease versioning. It does not indicate a real release. Align it to the actual last version if a bootstrap release has already happened. Check the first generated version before merging. When graduating to stable, change the prerelease configuration and explicitly select the intended stable version in a reviewed release PR.

Enable the repository variable `RELEASE_ENABLED=true` only once package.json and the implementation are ready. Permit Actions to create PRs in repository settings. Set `RELEASE_PLEASE_TOKEN` to a suitably scoped GitHub App/user token if automated PRs need to trigger CI. The fallback GITHUB_TOKEN cannot trigger new workflow runs for its own PR events; manually dispatch Development on the release PR branch if using that fallback. Required checks must still pass before merge.

## npm preparation

1. Resolve issues [1–6](https://github.com/frank-mendez/react-draft-recovery/issues). Confirm the package name is available and that the npm account owns it (or the intended scope). Name availability was not established by this audit.
2. Choose a license and add LICENSE; add package metadata, repository URL, files allowlist, export map, declaration entry points, supported engines, and React peer dependencies. Keep React external to the build. Set publishConfig.access to public and use the npm registry.
3. Inspect the actual packed tarball and run both consumer installations. Ensure the README's examples work, and exclude credentials, fixtures and unnecessary source/build files. A metadata check alone cannot establish a working release.
4. Set up the npm maintainer account and its required authentication. If the new package cannot yet have a trusted publisher configured, publish the first tested real beta from an authenticated maintainer session (`npm publish <verified-tarball> --access public --tag beta`). Do not publish a placeholder merely to enable automation. Record the corresponding source tag/version and align the release manifest.
5. Configure npm trusted publishing for GitHub owner `frank-mendez`, repository `react-draft-recovery`, workflow filename `release.yml`, environment `npm`, with publishing allowed. Use GitHub-hosted runners. The workflow uses Node 24 and OIDC (`id-token: write`); npm requires CLI >=11.5.1 and Node >=22.14.0. No NPM_TOKEN is needed for this path.
6. Create/protect the GitHub `npm` environment, restrict it to main, and configure required reviewers if desired. Protect main and release tags. Enable `NPM_PUBLISH_ENABLED=true` after setup and verification.

## Publishing and recovery

Run **Publish npm release** manually from **main**, supplying the reviewed tag (for example `v0.1.0-beta.1`). The workflow requires that the tag is on main, checks out its exact source, verifies version/metadata, runs all package checks, packs, then publishes the tarball. Beta versions use the `beta` dist-tag; stable versions use `latest`. npm provenance is requested. Changelog generation and publication are separate deliberately: tags created with GITHUB_TOKEN do not start another workflow automatically.

After publication, check the registry version, dist-tag and provenance, then install the version in clean npm and pnpm applications. If publishing fails, inspect npm first: a network error may occur after a successful upload. If that exact version is absent, fix the external configuration and dispatch the same tag again. Published versions cannot be overwritten; source changes require a new version/tag and release PR. A GitHub release can exist while npm publication is still pending.

There is one publication destination: the npm registry. pnpm is a package manager that consumes it. Once the name is confirmed and the beta exists, users can run `npm install <confirmed-name>@beta` or `pnpm add <confirmed-name>@beta`. These placeholders are not current installation instructions.

## References

- [npm trusted publishers](https://docs.npmjs.com/trusted-publishers/)
- [Release Please Action and token behavior](https://github.com/googleapis/release-please-action)
- [pnpm action setup](https://github.com/pnpm/action-setup)
