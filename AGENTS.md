# Repository instructions for agents

## Branch naming

- Do not use `codex/` as a branch prefix in this repository.
- Name branches for the kind of work, using a descriptive lowercase, hyphen-separated suffix:
  - `feat/<description>` or `feature/<description>` for new features.
  - `bugfix/<description>` for bug fixes.
  - `hotfix/<description>` for urgent fixes.
- Prefer `feat/` for new feature work unless the user requests another prefix.
- Follow an exact branch name supplied by the user.

Examples: `feat/local-recovery`, `feature/recovery-dialog`,
`bugfix/stale-candidate`, and `hotfix/storage-data-loss`.
