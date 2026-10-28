# Review: NestJS Module and SchedulerLock

**Spec:** `docs/specs/28-nestjs.md`
**Plan:** `docs/plans/28-nestjs.md`
**Issue:** #42

## Outcome

Pass.

`@tslock/nestjs` registers a caller-supplied `LockProvider` and a `DefaultLockingTaskExecutor`, and `@SchedulerLock` runs the method through `executeWithLock`. `@tslock/core` has no Nest import. Contention skips the method and resolves `undefined`. Provider and task errors propagate, and the executor still unlocks after a task error.

## Findings

| Severity | Finding | Evidence |
|---|---|---|
| INFO | The decorator runtime is process-global. The latest module to construct its providers wins, and destroy unbinds only that runtime. | `packages/nestjs/src/scheduler-lock-runtime.ts` |
| INFO | `registerInterceptor` is covered by the dynamic-module provider list and by resolving `SchedulerLockInterceptor` from the testing module. Nest's testing context does not expose `APP_INTERCEPTOR` registered inside an imported module, so this test does not boot an HTTP server. | `packages/nestjs/__tests__/nestjs-module.integration.test.ts` |
| INFO | Vitest 4 transforms tests with oxc. The package Vitest config sets `oxc.decorator.legacy` so `@SchedulerLock` and Nest decorators parse. The plan's esbuild `tsconfigRaw` option conflicts with tsup and is not used. | `packages/nestjs/vitest.config.ts`, `packages/nestjs/tsup.config.ts` |
| INFO | `pnpm-lock.yaml` had a duplicated `@types/node@22.20.2` key, which made pnpm refuse the lockfile. The duplicate entry was removed so the Nest dependencies could be added. | `pnpm-lock.yaml` |

No spec or architecture mismatch required a code change. Core stays framework-agnostic. Lock acquire, skip, unlock, and reentrancy stay in `DefaultLockingTaskExecutor`.

## Verification

Passed locally:

- `pnpm install --frozen-lockfile`
- `pnpm check`
- `pnpm -r build`
- `pnpm -r typecheck`
- `pnpm -r test`
- `pnpm --filter @tslock/nestjs test:integration` (5 tests; Nest testing module, no Docker)

Repo-wide `pnpm test:integration` was not re-run. This change does not touch a storage provider. Spanner's existing live integration file stays skipped without its backend.
