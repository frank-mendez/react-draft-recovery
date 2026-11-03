# Consumer Adoption Gate Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete issue #26 with executable evidence from an independent packed React consumer, a safe legacy-import example, and an adoption checklist enforced in CI.

**Architecture:** Keep existing engine and adapter semantics in the source test suites. Add a small browser consumer that installs the packed tarball and exercises the React hook with real browser storage and lifecycle behavior. Add a compatibility checklist mapping each claim to its evidence and naming app-owned responsibilities.

**Tech Stack:** Node.js 24, pnpm, React 18.3.1 and 19.2.0 consumer fixtures, Vite, Playwright Chromium, existing node:test suites.

**Spec:** https://github.com/frank-mendez/react-draft-recovery/issues/26

## Global Constraints

- Do not use production databases or real-user draft data.
- Keep legacy source cleanup explicit and conditional; never restore application approval fields from draft data.
- Document that browser storage and unload persistence are best effort and navigation blocking remains application-owned.
- Preserve the existing React 18.3.1 and React 19 packed-consumer checks.

## Review Focus

- Quota and blocked storage retain active editor input and surface failure.
- A-to-B-to-A account changes do not leak or auto-restore data across accounts.
- Separate browser tabs surface competing edits without replacing active input.
- Delayed and uncertain backend outcomes retain the frozen request and newer edits.
- Legacy cleanup failure leaves both copies available and cannot restore approval state.

---

### Task 1: Safe legacy-import consumer example

**Files:** `adoption/consumer/legacy-adapter.mjs`, `adoption/consumer/main.jsx`, `adoption/legacy-adapter.test.mjs`

- [x] Add an example adapter that validates account/document/writer ownership, converts only body text, and removes the source only after explicit import, restore, and successful destination persistence.
- [x] Test that an `approved` legacy field is excluded, mismatched storage-key ownership is rejected, and failed persistence or cleanup preserves the source.
- [x] Run the focused example test and the existing discovery tests.

### Task 2: Packed browser consumer

**Files:** `adoption/consumer/index.html`, `adoption/consumer/main.jsx`, `scripts/test-adoption.mjs`, `package.json`, `pnpm-lock.yaml`

- [x] Add Playwright scenarios for reload/restore, distinct editor scopes, live competing-tab storage events, A-to-B-to-A accounts, blocked/quota storage, stale/delayed remote responses, and navigation behavior.
- [x] Pack the current package, install the tarball into temporary independent React/Vite consumers with committed React 18 and React 19 npm lockfiles, and run both in Chromium StrictMode.
- [x] Run the new browser test locally and fix failures before wiring it into CI.

### Task 3: Compatibility gate and CI

**Files:** `docs/adoption-checklist.md`, `README.md`, `.github/workflows/development.yml`

- [x] Map library, adapter, and application guarantees to the executable evidence already present in the repository.
- [x] State the browser reference environment and navigation limitations; require consumer-specific backend/auth/router checks before replacement readiness claims.
- [x] Install Playwright Chromium and run the adoption suite in the development workflow.
- [x] Run lint, typecheck, all tests, build, package-consumer validation, and adoption validation; update issue #26 with evidence. Keep the issue open until the branch is integrated.

## Verification results

- `pnpm lint`, `pnpm typecheck`, and `pnpm test`: passed (216 tests).
- `pnpm build` and `pnpm test:package`: passed, including npm/pnpm consumers, React 18.3.1 and 19.2.0 SSR/type checks, and core-only imports.
- `pnpm test:adoption`: passed (11 Chromium scenarios each against the packed tarball under React 18.3.1 and React 19.2.0, with StrictMode enabled).
- Consumer readiness still requires the consuming application's real backend, authentication, legacy schema, router, and supported-browser checks listed in `docs/adoption-checklist.md`.
