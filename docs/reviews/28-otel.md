# Review: @tslock/otel

## Scope

Independent review of `docs/specs/28-otel.md`, `docs/plans/28-otel.md`, and `@tslock/otel` against issue #41. `@tslock/core` source is unchanged.

## Findings

1. **Medium, fixed.** The package README claimed the OpenTelemetry metrics API would forward instruments to a `MeterProvider` registered after `createOpenTelemetryLockMetrics()`. `@opentelemetry/api` 1.9 returns a no-op meter when no global provider is set, and those instruments stay no-op. The README now requires `metrics.setGlobalMeterProvider` or SDK startup before the factory, and says a meter from an already started provider is the explicit alternative. The copy-paste example already creates the helper after startup.

2. **Low.** `docs/00-vision.md` section 5.2 still sits in the out-of-scope table. Its Prometheus row states that official OpenTelemetry metrics ship as `@tslock/otel`, and section 7 says the same. Root README, `AGENTS.md`, architecture, and the core README point at the package.

3. **Low.** Unlock and extend failure tests assert the counter, `outcome`, and `error.type`. They do not assert the duration histograms recorded in the same `finally`. Bucket boundaries are passed as histogram advice and are not asserted.

4. **Low.** Keep-alive coverage includes a successful renewal and a renewal that returns `undefined`. It does not cover the core path that retries a thrown extend once and then calls `onKeepAliveFailure`.

5. **Note, not a defect in this package.** After `LockExtender.extendActiveLock`, `DefaultLockingTaskExecutor` unlocks the original handle. `AbstractSimpleLock` has already invalidated that handle, so the wrapper records unlock `outcome=failure` with `error.type=LockException`. The README states that. Keep-alive unlocks the current handle, so a normal keep-alive release records unlock success.

## What matches

- Acquire, skip, attempt, task duration, and the active-task up-down counter come from `LockingTaskExecutorListener`.
- Unlock and extend are recorded on the wrapped `SimpleLock`. `onUnlockError` is not a second counter.
- Keep-alive failure uses the existing callback. The README instruments the storage provider, then passes that wrapper and `onKeepAliveFailure` into `KeepAliveLockProvider`.
- Metric `add` and `record` failures are swallowed independently, so one throwing instrument does not skip the other or fail unlock.
- Attributes include `lock.name`, `lock.at_most_for_ms`, and `lock.at_least_for_ms`. Extend success uses the requested durations.
- Package layout matches the plan: `@tslock/core` dependency, required `@opentelemetry/api` peer, SDK only in devDependencies, dual ESM/CJS, Node `>=22`, minor changeset.

## Verification

- `pnpm check`
- `pnpm -r build`
- `pnpm -r typecheck`
- `pnpm -r test` (`@tslock/otel`: 8 tests)

Integration tests were not run. `@tslock/otel` has no container suite, and this change does not touch provider storage.

## Decision

**Approved.** The medium README defect is corrected. Remaining notes do not block the package.
