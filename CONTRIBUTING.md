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

### Clone and install

```bash
git clone https://github.com/drmaas/tslock.git
cd tslock
corepack enable
pnpm install
```

The workspace intentionally denies install scripts for the transitive `cpu-features` and `ssh2` packages used by testcontainers. Standard local Docker-socket integration tests do not require these optional native builds. Docker-over-SSH is not supported by the default policy; if you need it locally, change both entries to `true` in `pnpm-workspace.yaml`, reinstall, and ensure your machine has the required native build toolchain. Do not commit that local override unless the policy is intentionally changing.

### Verify your environment

```bash
pnpm -r typecheck
pnpm -r test
pnpm check
pnpm -r build
```

If all of those pass, you're good to go.

## Ways to contribute

- 🐛 **Fix a bug** — check the issue tracker for `bug` labels and use `tslock-bugfix` when working with an agent.
- 📦 **Add a provider** — see [Adding a new provider](#adding-a-new-provider). Open an issue first to claim it; use `tslock-sdd` with an agent.
- 📝 **Improve docs** — READMEs, comments, and design docs; use `tslock-doc-improver` with an agent.
- ✅ **Improve tests** — especially integration test coverage for providers with emulators; use `tslock-test-improver` with an agent.
- 🔧 **Refactor** — keep the code lean. Use `tslock-sdd` for a substantial refactor and the fast track for a local mechanical refactor (see [`AGENTS.md`](./AGENTS.md)).
- 🌍 **Report issues** — clear reproduction steps and environment details go a long way.

### Agent workflow routing

The repository provides OpenCode skills under [`.opencode/skills/`](./.opencode/skills/) for repeatable contribution workflows. Use the skill that matches the primary intent:

| Contribution | Skill | Use when | Do not use when |
|---|---|---|---|
| Fix a bug | `tslock-bugfix` | A reproducible defect, regression, race, or incorrect behavior needs a focused fix | The primary work is a new feature, docs audit, or test-only coverage improvement |
| Add a feature/provider | `tslock-sdd` | New behavior, public API, provider, concept, cross-package contract, or substantial refactor | The change is an isolated bug, docs-only update, or test-only improvement |
| Improve docs | `tslock-doc-improver` | Docs, READMEs, specs/plans references, examples, links, or contributor guidance need reconciliation | The primary problem is incorrect runtime behavior or a new design |
| Improve tests | `tslock-test-improver` | Coverage, assertions, integration tests, fuzz tests, or test infrastructure need improvement | The primary task is fixing production behavior or designing a new feature |
| Refactor | `tslock-sdd` for substantial changes; fast track for local mechanical changes | The refactor changes architecture, public contracts, or multiple packages | Do not use SDD for a trivial rename or mechanical cleanup |

The skill names are canonical. `tsock-doc-improver` and `tslock-sd` are treated as typos; use `tslock-doc-improver` and `tslock-sdd`. If you are not using an agent, follow the workflow below directly.

## Development workflow

TSLock uses two levels of rigor:

- **Fast track:** a small, well-understood change that follows existing patterns—such as a typo, isolated mechanical cleanup, or one-function bug fix. Reproduce or characterize the issue, implement the smallest change, run targeted verification, and review the diff.
- **Full SDD:** a new concept, feature/provider, public or cross-package contract, architectural change, or substantial refactor. Use the `tslock-sdd` skill when working with an agent.

### Full workflow (architecturally substantial changes)

1. **Interview and discovery** — resolve scope, constraints, compatibility, edge cases, and test expectations.
2. **Spec** — write `docs/specs/<NN>-<name>.md` describing behavior, API, edge cases, errors, and tests.
3. **Plan** — write `docs/plans/<NN>-<name>.md` with ordered implementation steps, files, verification, and documentation updates.
4. **Implement** — implement from the spec and plan, including unit/integration tests and relevant docs.
5. **Verify** — run the relevant targeted checks and the full suite where required; fix failures.
6. **Review** — obtain an independent review against the spec, plan, architecture, code, tests, and docs.
7. **Repeat** — route findings back to the lowest affected stage and repeat verification/review until done (maximum three rounds before escalating).

> **Immutable docs:** specs, plans, and reviews in `docs/` are written once and not edited after the fact. New work gets new files. The only exception is an explicit maintainer decision.

The complete executable instructions are in [`.opencode/skills/tslock-sdd/SKILL.md`](./.opencode/skills/tslock-sdd/SKILL.md). The focused bug, documentation, and test workflows are in the neighboring skill files.

### Verification suite

Before opening a PR, run:

```bash
pnpm check             # format check + lint (Biome)
pnpm -r typecheck      # tsc --noEmit across all packages
pnpm -r test           # vitest run (unit tests)
pnpm test:integration  # in-memory, MongoDB, and PostgreSQL; Redis is opt-in
pnpm -r build          # tsup build across all packages
pnpm check:packed-peers # verify packed peer dependency ranges
```

Integration tests (MongoDB/PostgreSQL require Docker; Redis requires a running Redis service):

```bash
pnpm test:integration
TSLOCK_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration
```

CI runs `pnpm check && pnpm typecheck && pnpm test && pnpm build` plus a non-blocking `pnpm audit --prod` and the integration job on every push.

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
