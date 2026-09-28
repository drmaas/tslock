# Plan: Scheduler Adapters (node-cron, bree, AWS Lambda)

## Goal

Implement `docs/specs/29-scheduler-adapters.md`: shared `@tslock/scheduler-core` plus thin `@tslock/node-cron`, `@tslock/bree`, and `@tslock/aws-lambda` packages that wrap callbacks with `DefaultLockingTaskExecutor`, matching NestJS skip semantics. Core stays scheduler-free.

## Dependencies

- `@tslock/core` APIs already shipped: `createLockConfig`, `DefaultLockingTaskExecutor`, `parseDuration`, `LockException`, `Utils.validateLockName`.
- Patterns: `@tslock/nestjs` (`runWithSchedulerLock`), `@tslock/middleware-core` (shared package + thin adapters).
- No storage provider or Docker required.

## Ordered steps

### 1. Scaffold packages

Create four packages under `packages/` with the standard dual-format layout (mirror `packages/otel` / `packages/nestjs`):

| Path | Package name |
|---|---|
| `packages/scheduler-core/` | `@tslock/scheduler-core` |
| `packages/node-cron/` | `@tslock/node-cron` |
| `packages/bree/` | `@tslock/bree` |
| `packages/aws-lambda/` | `@tslock/aws-lambda` |

Each package gets: `package.json` (version `2.0.1`, `engines.node >= 22`, dual exports, `sideEffects: false`, repository directory), `tsconfig.json` extending `../../tsconfig.base.json`, `tsup.config.ts` (`format: ['esm','cjs']`, `dts`, `clean`, `sourcemap`, `target: 'node20'`), `src/`, `__tests__/`, `README.md`.

`pnpm-workspace.yaml` already includes `packages/*` — no edit.

Peer / dependency matrix:

| Package | dependencies | peerDependencies | devDependencies (extra) |
|---|---|---|---|
| scheduler-core | `@tslock/core` workspace | — | vitest, tsup, typescript, `@tslock/in-memory` |
| node-cron | `@tslock/core`, `@tslock/scheduler-core` | `node-cron` `^3 \|\| ^4` | `node-cron` ^4, in-memory |
| bree | `@tslock/core`, `@tslock/scheduler-core` | `bree` `^9` | `bree` ^9, in-memory |
| aws-lambda | `@tslock/core`, `@tslock/scheduler-core` | — | in-memory |

Use `workspace:*` for internal `@tslock/*` deps (same as express/nestjs).

### 2. Implement `@tslock/scheduler-core`

Files:

- `src/scheduler-lock-config.ts` — `SchedulerLockConfig`, `ResolvedSchedulerLockConfig`, `JobLockOptions`, `resolveSchedulerLockConfig`, `validateJobLockOptions`.
- `src/scheduler-lock-lifecycle.ts` — `createSchedulerLock`, `SchedulerLockLifecycle` (`wrap` / `run`).
- `src/index.ts` — public exports.

Implementation notes:

- Validation mirrors `packages/nestjs/src/tslock-module.ts` / `scheduler-lock.ts`.
- `wrap` closes over executor + resolved defaults; builds `createLockConfig` per call; returns `result.wasExecuted ? result.getResult() : undefined`.
- No comments in source.
- Do not export Nest-specific runtime binding.

Tests (`__tests__/scheduler-lock.unit.test.ts`):

- config validation (missing provider, inverted durations, missing defaultLockAtMostFor)
- wrap acquire / skip / unlock-on-throw / provider error
- duration override vs defaults
- preserve `0` and `false` results
- `run` smoke

### 3. Implement `@tslock/node-cron`

Files:

- `src/node-cron-lock.ts` — `createNodeCronLock`, `createRunCoordinator` helper (or colocated).
- `src/index.ts`

`createNodeCronLock` delegates wrap to `createSchedulerLock`. `schedule(cron, expression, task, job)` calls `cron.schedule(expression, wrap(task, job), job.taskOptions)`.

`createRunCoordinator`:

- Hold `Map<string, SimpleLock>`.
- `shouldRun(key, ttlMs)` → lock with `createLockConfig(prefix+key, ttlMs, lockAtLeastForMs)`; store on success.
- `onComplete(key)` → unlock + delete.

Use `import type` for `RunCoordinator` from `node-cron` so v3 installs still typecheck when types are optional; if v3 has no `RunCoordinator` type, define a local structural interface matching the v4 shape and document it.

Tests:

- wrap acquire/skip (reuse mock provider pattern from nestjs unit tests)
- schedule invokes `cron.schedule` with wrapped fn (mock cron module)
- RunCoordinator acquire / miss / onComplete unlock / keyPrefix

### 4. Implement `@tslock/bree`

Files:

- `src/bree-lock.ts` — `createBreeLock` → thin facade over `createSchedulerLock`.
- `src/index.ts`

Do not import `bree` at runtime. Peer is install contract only.

Tests: wrap acquire/skip; factory exposes config/executor.

### 5. Implement `@tslock/aws-lambda`

Files:

- `src/aws-lambda-lock.ts` — `createAwsLambdaLock` with `wrapHandler`.
- `src/index.ts`

`wrapHandler` is `lifecycle.wrap(handler, job)` with event/context args.

Tests: handler called with args when locked; skipped when not; unlock after throw.

### 6. Documentation and changeset

- Package READMEs with install + usage (node-cron schedule example, bree worker wrap, Lambda EventBridge handler).
- Update root `README.md`: add **Scheduler adapters** table after Middleware integrations.
- Update `AGENTS.md` Framework integrations row / note for scheduler adapters.
- Add `.changeset/scheduler-adapters.md`:

```md
---
'@tslock/scheduler-core': minor
'@tslock/node-cron': minor
'@tslock/bree': minor
'@tslock/aws-lambda': minor
---

Add thin scheduler adapters (`node-cron`, `bree`, AWS Lambda) backed by `@tslock/scheduler-core` so cron and scheduled handlers wrap with `executeWithLock` without putting a scheduler in core.
```

Do not edit historical specs/plans/reviews.

### 7. Install and verify

```bash
nvm use
corepack enable pnpm
pnpm install
pnpm --filter @tslock/scheduler-core --filter @tslock/node-cron --filter @tslock/bree --filter @tslock/aws-lambda typecheck
pnpm --filter @tslock/scheduler-core --filter @tslock/node-cron --filter @tslock/bree --filter @tslock/aws-lambda test
pnpm --filter @tslock/scheduler-core --filter @tslock/node-cron --filter @tslock/bree --filter @tslock/aws-lambda build
pnpm check
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

Integration suite is out of scope (no containers). Record if any unrelated packages fail pre-existing checks.

## File checklist

Create:

- `docs/specs/29-scheduler-adapters.md` (done in Stage 2)
- `docs/plans/29-scheduler-adapters.md` (this file)
- `docs/reviews/29-scheduler-adapters.md` (Stage 6)
- `packages/scheduler-core/**`
- `packages/node-cron/**`
- `packages/bree/**`
- `packages/aws-lambda/**`
- `.changeset/scheduler-adapters.md`

Modify:

- `README.md` (package matrix)
- `AGENTS.md` (integration note)
- `pnpm-lock.yaml` (via install)

## Rollback / risks

- Additive packages only; remove the four dirs + docs/changeset/README/AGENTS entries to roll back.
- Review risks: node-cron v3 vs v4 `RunCoordinator` typing; peer range too narrow; accidental core import of cron; skip semantics diverging from Nest (`TaskResult` leak).
- `createRunCoordinator` must not leave dangling map entries if unlock throws — still delete after unlock attempt in `finally`-style.

## Implementation order for a fresh builder

1. scheduler-core + tests
2. node-cron + tests
3. bree + tests
4. aws-lambda + tests
5. README / AGENTS / changeset
6. pnpm install + verification commands above
7. Independent review → `docs/reviews/29-scheduler-adapters.md`
