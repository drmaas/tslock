# Implementation Plan: NestJS Module and SchedulerLock

## Overview

Implement `docs/specs/28-nestjs.md` as a new `@tslock/nestjs` package. Core and the existing HTTP middleware packages stay unchanged except for discoverability edits in the root README and `AGENTS.md`.

## Files

Create:

- `packages/nestjs/package.json`
- `packages/nestjs/tsconfig.json`
- `packages/nestjs/tsup.config.ts`
- `packages/nestjs/vitest.config.ts`
- `packages/nestjs/vitest.integration.config.ts`
- `packages/nestjs/README.md`
- `packages/nestjs/src/index.ts`
- `packages/nestjs/src/tokens.ts`
- `packages/nestjs/src/scheduler-lock-runtime.ts`
- `packages/nestjs/src/scheduler-lock.ts`
- `packages/nestjs/src/scheduler-lock-interceptor.ts`
- `packages/nestjs/src/tslock-module.ts`
- `packages/nestjs/__tests__/scheduler-lock.unit.test.ts`
- `packages/nestjs/__tests__/nestjs-module.integration.test.ts`
- `.changeset/nestjs-scheduler-lock.md`

Update:

- `README.md` — middleware/framework matrix and design-doc counts
- `AGENTS.md` — framework integration row and design-doc counts
- `pnpm-lock.yaml` — install the new package's Nest, rxjs, and reflect-metadata dependencies

Do not edit `docs/00-vision.md`, `docs/01-architecture.md`, existing specs/plans/reviews, or provider packages.

## Steps

1. Add the package manifest. Depend on `@tslock/core` via `workspace:*`. Peer `@nestjs/common`, `@nestjs/core`, and `rxjs`. Dev-depend on Nest 11, `@nestjs/testing`, `rxjs`, `reflect-metadata`, `@tslock/in-memory`, and the shared TypeScript/tsup/vitest toolchain. Mirror the Express adapter's exports, `files`, `engines`, and `publishConfig`.
2. Add the runtime binder: `bindSchedulerLockRuntime`, `unbindSchedulerLockRuntime`, and `getSchedulerLockRuntime`. Unbind is identity-sensitive.
3. Add `@SchedulerLock` with decoration-time validation, metadata copy, WeakMap lookup, and `runWithSchedulerLock` delegating to `createLockConfig` plus `executeWithLock`.
4. Add `SchedulerLockInterceptor` with the three handler cases from the spec. Use `lastValueFrom(..., { defaultValue: undefined })` so a handler that completes without a value does not surface RxJS `EmptyError`.
5. Add `TslockModule.forRoot` and `forRootAsync`. Bind the runtime inside the executor provider factory so it exists before `onModuleInit`. Register an `onModuleDestroy` object that unbinds that runtime. Optionally register `APP_INTERCEPTOR`.
6. Apply `@Module` and `@Injectable` through `reflect-metadata`. Keep decorator emit working under tsup by setting `experimentalDecorators` on the package tsconfig and tsup esbuild options. If the bundle strips decorator metadata, call `Module({})` and `Injectable()` as functions instead of relying on decorator syntax.
7. Add unit tests and Nest testing-module integration tests listed in the spec.
8. Write the package README schedule example and the changeset. Link the package from the root README.

## Verification

From the repo root, after `pnpm install`:

```bash
pnpm --filter @tslock/nestjs test
pnpm --filter @tslock/nestjs test:integration
pnpm --filter @tslock/nestjs typecheck
pnpm --filter @tslock/nestjs build
pnpm check
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

`pnpm test:integration` for this package does not need Docker. The repo-wide integration command remains optional for this change because no storage adapter is modified; run it when the environment already has the required containers.

`pnpm check:packed-peers` must show no `workspace:*` peer range for `@tslock/nestjs`.

## Risks

- tsup/esbuild can drop TypeScript experimental decorators. The module must still be recognizable to Nest after the build, and tests must execute the decorator against the source via Vitest.
- A process-global runtime races if two applications call `forRoot` in one process. The spec accepts last-registration-wins and requires destroy to unbind only the runtime it owns.
- `@Cron` above `@SchedulerLock` stores metadata on the original function unless it is copied. The copy path has to be tested in both orders.
- Global `APP_INTERCEPTOR` plus the method wrapper could double-lock. The interceptor must detect the wrapper and delegate.

## Rollback

Remove `packages/nestjs`, the changeset, and the README / `AGENTS.md` rows. No core migration is required.
