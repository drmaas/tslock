# Contributing to TSLock

Thanks for your interest in contributing to TSLock! 🎉 This document explains how to get set up and how to contribute effectively.

TSLock is a TypeScript port of [ShedLock](https://github.com/lukas-krecan/ShedLock) — a distributed lock library for scheduled tasks. It's a pnpm-workspaces monorepo with a small core package and 23+ provider packages.

## Table of contents

- [Code of conduct](#code-of-conduct)
- [Before you start](#before-you-start)
- [Getting set up](#getting-set-up)
- [Ways to contribute](#ways-to-contribute)
- [Development workflow](#development-workflow)
- [Coding conventions](#coding-conventions)
- [Adding a new provider](#adding-a-new-provider)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Releasing](#releasing)

## Code of conduct

Be kind and professional. Treat everyone with respect. Harassment, personal attacks, and trolling are not tolerated. If you witness unacceptable behavior, email the maintainers.

## Before you start

- **Check existing issues and PRs** before opening a new one — your topic may already be in progress.
- **Open an issue first** for new providers, breaking changes, or large architectural changes. A quick discussion up front saves everyone time.
- Small fixes (typos, bug fixes in one function, docs tweaks) don't need an issue — just open a PR.

## Getting set up

### Prerequisites

- **Node.js >= 22** (the repo pins `22.x` in [`.nvmrc`](./.nvmrc); use [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) to match it)
- **pnpm 11+** (enable via corepack: `corepack enable`)
- **Docker** — only needed for integration tests (which use testcontainers / emulators)

### Clone and install

```bash
git clone https://github.com/drmaas/tslock.git
cd tslock
corepack enable
pnpm install
```

### Verify your environment

```bash
pnpm -r typecheck
pnpm -r test
pnpm check
pnpm -r build
```

If all of those pass, you're good to go.

## Ways to contribute

- 🐛 **Fix a bug** — check the issue tracker for `bug` labels.
- 📦 **Add a provider** — see [Adding a new provider](#adding-a-new-provider). Open an issue first to claim it.
- 📝 **Improve docs** — READMEs, code comments, design docs.
- ✅ **Improve tests** — especially integration test coverage for providers with emulators.
- 🔧 **Refactor** — keep the code lean. No unrequested abstractions (see [`AGENTS.md`](./AGENTS.md)).
- 🌍 **Report issues** — clear reproduction steps and environment details go a long way.

## Development workflow

TSLock classifies changes into two tracks (see [`AGENTS.md`](./AGENTS.md) for the full version):

| If the change... | Then... |
|---|---|
| Touches only existing patterns, fixes a bug in one function, docs typos, chores | **Fast track** — implement directly |
| Adds new concepts, changes cross-package contracts, requires 3+ files, or is architecturally substantial | **Full workflow** below |

### Full workflow (architecturally substantial changes)

1. **Interview** — open an issue and discuss scope until unknowns are resolved.
2. **Spec** — write `docs/specs/<NN>-<name>.md` describing behavior, API, edge cases.
3. **Plan** — write `docs/plans/<NN>-<name>.md` with step-by-step implementation order.
4. **Implement** — write the code + unit and integration tests.
5. **Verify** — run the full suite (below) and fix failures.
6. **Review** — request a review against the spec, plan, and architecture.

> **Immutable docs:** specs, plans, and reviews in `docs/` are written once and not edited after the fact. New work gets new files. The only exception is an explicit maintainer decision.

### Verification suite

Before opening a PR, run:

```bash
pnpm check          # format check + lint (Biome)
pnpm -r typecheck   # tsc --noEmit across all packagespnpm -r test            # vitest run (unit tests)
pnpm -r test:integration # integration tests (requires Docker; only some packages define this script)
pnpm -r build           # tsup build across all packages
```

Integration tests (require Docker):

```bash
pnpm -r test:integration
```

CI runs `pnpm check && pnpm typecheck && pnpm test && pnpm build` on every push.

## Coding conventions

- **TypeScript strict mode** — `tsconfig.base.json` enables `strict`, `noUncheckedIndexedAccess`, `noImplicitOverride`, and `noFallthroughCasesInSwitch`.
- **No comments in code** unless explicitly requested or the logic is genuinely non-obvious.
- **Dual format** — every package uses `tsup` with `format: ['esm', 'cjs']`, `dts: true`, `clean: true`, `sourcemap: true`.
- **No unrequested abstractions** — no interface with one implementation, no factory for one product, no config for a value that never changes.
- **Peer dependencies, not bundled** — provider packages declare their driver as a peer dep so users install the version they want.
- **Config API** — plain typed objects + `parseDuration()`. No builder classes.
- **Async-native** — all lock operations return `Promise`. `AsyncLocalStorage` replaces Java's `ThreadLocal`.
- **ISO timestamps** — use `Utils.toIsoString(epochMillis)` for ISO-8601 with exactly 3 fractional digits.
- **Linting** — Biome. Run `pnpm check:fix` to auto-format and apply safe fixes.

## Adding a new provider

1. **Open an issue** to claim the provider and confirm it's in scope.
2. Read [`docs/00-vision.md`](./docs/00-vision.md), [`docs/01-architecture.md`](./docs/01-architecture.md), and an existing provider's spec/plan/review as a template.
3. Write `docs/specs/<NN>-<name>.md` and `docs/plans/<NN>-<name>.md` (pick the next free `NN`).
4. Implement under `packages/<name>/` following the package conventions in [`AGENTS.md`](./AGENTS.md):
   - `src/index.ts` (exports), `src/<provider>-configuration.ts`, `src/<provider>-lock-provider.ts`, `__tests__/`.
   - `engines.node >= 22`, dual ESM + CJS, `@types/node` peer.
   - Peer deps: `@tslock/core` + the canonical driver.
5. Add the shared integration test contract from [`@tslock/test-support`](./packages/test-support/README.md).
6. Add a `README.md` to the package (see any existing provider README for the format).
7. Add the package to the matrix tables in [`README.md`](./README.md#packages).
8. Run the full verification suite and fix any failures.

## Commit messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

Common types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `style`, `perf`, `build`, `ci`.

Examples:

```
feat(redis): add safeUpdate config option
fix(s3): throw on 404 in updateRecord to self-heal cache
docs(core): clarify LockExtender semantics
chore: bump Node minimum to 22
```

Scope is usually the provider name (e.g. `redis`, `s3`, `core`, `sql-support`) or `deps` / `ci` / `release`.

## Pull requests

1. **Branch from `main`** and name it descriptively: `feat/redis-safeupdate`, `fix/s3-404-selfheal`, `docs/readme-localdev`.
2. **Keep PRs focused** — one logical change per PR. Large refactors should be split.
3. **Include tests** for bug fixes and new features. Unit tests are required; integration tests where a backend is available.
4. **Update docs** — if you change a public API, update the relevant package README and the main README.
5. **Run the verification suite** locally (above) and ensure it's green.
6. **Add a changeset** for user-facing changes:

   ```bash
   pnpm changeset
   ```

   Describe the change and pick the semver bump. Breaking changes require a major bump. All `@tslock/*` packages share one version (lockstep via Changesets fixed mode).
7. **Reference the issue** in the PR description (`Closes #123`).
8. **Be responsive** to review feedback.

### PR template checklist

- [ ] Branch is up to date with `main`
- [ ] `pnpm check` passes
- [ ] `pnpm -r typecheck` passes
- [ ] `pnpm -r test` passes
- [ ] `pnpm -r build` passes
- [ ] Tests added/updated for the change
- [ ] Relevant READMEs updated
- [ ] Changeset added (for user-facing changes)
- [ ] Commit messages follow Conventional Commits

## Releasing

Releases are **admin only** and performed locally (npm 2FA is interactive). See the [Publishing section of the README](./README.md#publishing). Contributors don't need to worry about this — maintainers cut releases from accumulated changesets.

## Questions?

- Open a [discussion](https://github.com/drmaas/tslock/discussions) for questions.
- Open an [issue](https://github.com/drmaas/tslock/issues) for bugs and feature requests.
- Read [`AGENTS.md`](./AGENTS.md) for the detailed AI-agent and contributor conventions.

Thanks for contributing! 💚
