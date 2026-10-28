# Implementation Plan: @tslock/otel

## Overview

Add `@tslock/otel` from `docs/specs/28-otel.md`. The package records OpenTelemetry metrics from the existing listener, a `SimpleLock` wrapper, and the keep-alive failure callback. `@tslock/core` is not modified.

## Files

Create:

- `packages/otel/package.json`
- `packages/otel/tsconfig.json`
- `packages/otel/tsup.config.ts`
- `packages/otel/src/index.ts`
- `packages/otel/src/open-telemetry-lock-metrics.ts`
- `packages/otel/__tests__/open-telemetry-lock-metrics.test.ts`
- `packages/otel/README.md`
- `.changeset/otel-metrics.md`

Update:

- `README.md` — observability package row and doc counts
- `packages/core/README.md` — listener export and pointer to `@tslock/otel`
- `docs/00-vision.md` — OpenTelemetry is provided by `@tslock/otel`; Prometheus stays user-wired
- `docs/01-architecture.md` — package tree, dependency rule, listener paragraph
- `AGENTS.md` — metrics row

Do not edit existing specs, plans, or reviews. Do not change `packages/core/src`.

## Steps

1. Add the package with the same tsup/tsconfig shape as `packages/middleware-core`.
   - `dependencies`: `@tslock/core` at `workspace:*`
   - `peerDependencies`: `@opentelemetry/api` `^1.9.0`, required
   - `devDependencies`: `@opentelemetry/api`, `@opentelemetry/sdk-metrics`, `@tslock/in-memory`, `tsup`, `typescript`, `vitest`
   - `version`: `2.0.1`
   - `engines.node`: `>=22`
   - `publishConfig.access`: `public`
2. Implement `createOpenTelemetryLockMetrics` as specified: listener instruments, `instrument`, and `onKeepAliveFailure`. Swallow metric-recording failures. Keep the wrapper idempotent.
3. Export the factory, option and result types, `TSLOCK_METRIC_NAMES`, and `TSLOCK_METRIC_ATTRIBUTES` from `src/index.ts`.
4. Add the unit tests listed in the spec. Use `MeterProvider` plus `InMemoryMetricReader` from `@opentelemetry/sdk-metrics` for assertions. Use a throwing fake `Meter` for the isolation test.
5. Write the package README with copy-paste setup for the executor and for `KeepAliveLockProvider`.
6. Update the root README, core README, vision, architecture, and `AGENTS.md` rows named above.
7. Add a minor changeset for `@tslock/otel`.

## Verification

```bash
pnpm install
pnpm --filter @tslock/otel typecheck
pnpm --filter @tslock/otel test
pnpm --filter @tslock/otel build
pnpm check
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

`pnpm test:integration` and `pnpm check:packed-peers` are unchanged by this package. Run them when the environment can. `@tslock/otel` has no integration suite and no `workspace:*` peer dependency.

## Rollback

Removing `packages/otel` and the doc pointers restores the previous surface. No stored data and no core migration.

## Review risks

- Instrumenting `KeepAliveLockProvider` instead of the storage provider misses renewals and can double-count unlock. The README has to show the storage-provider order.
- Lease duration attributes multiply series when durations vary per call.
- Unlock failures are recorded by the wrapper and also delivered to `onUnlockError`. The listener must not count them again.
