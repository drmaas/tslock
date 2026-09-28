# Spec: @tslock/otel

## Problem

TSLock exposes `LockingTaskExecutorListener` so applications can record lock metrics, and `KeepAliveLockProvider` already accepts an `onKeepAliveFailure` callback. There is no official package that turns those signals into OpenTelemetry instruments. Issue #41 asks for that package.

## Goals

- Publish `@tslock/otel`, a thin integration that records OpenTelemetry metrics for lock acquired, lock skipped, unlock, extend success and failure, and keep-alive failure.
- Attach the lock name and the configured lock durations as attributes. Record observed durations as histogram measurements.
- Depend on the OpenTelemetry API only. Do not depend on an SDK, exporter, or Prometheus client.
- Leave `@tslock/core` unchanged.

## Non-goals

- Prometheus helpers, tracing spans, and the OpenTelemetry logs/events signal. Counters are the events.
- Pre-registering zero-valued series for known lock names.
- Middleware `listener` configuration. Callers pass `listener` to `DefaultLockingTaskExecutor` themselves.
- Changing acquire, skip, unlock, extend, or keep-alive behavior.

## Core hook investigation

`@tslock/core` already exposes every signal this package needs:

| Signal | Existing hook | Why a new core hook is unnecessary |
|---|---|---|
| Lock attempt, acquired, skipped | `LockingTaskExecutorListener` | The executor already emits these. |
| Task duration and in-flight tasks | `onTaskStarted` / `onTaskFinished(config, executionTimeMillis)` | Duration is already measured. |
| Unlock success, unlock failure, unlock duration | `SimpleLock.unlock()` on the lock the executor and keep-alive wrapper call | `onUnlockError` reports executor unlock failures only. Successful unlock, unlock duration, direct `unlock()` calls, and keep-alive unlocks are visible on the lock handle. |
| Extend success and failure | `SimpleLock.extend()` | `LockExtender` and `KeepAliveLock` both call the current handle. A listener method on the executor would not see keep-alive renewals. |
| Keep-alive failure | `KeepAliveLockProvider` constructor callback | Fired when a renewal returns no lock or when the single retry also throws. Distinct from one failed extend attempt. |

Recording unlock or extend inside the listener alone would miss keep-alive renewals. Wrapping the storage provider's `SimpleLock` covers the executor, `LockExtender`, and keep-alive with one path.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/otel` |
| **Dependencies** | `@tslock/core` |
| **Peer dependency** | `@opentelemetry/api` `^1.9.0` (required) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS via tsup |

`@opentelemetry/api` is a peer dependency so the application and this package share one API instance. A private copy would not observe `metrics.setGlobalMeterProvider`.

## Public API

```typescript
interface OpenTelemetryLockMetricsOptions {
  readonly meter?: Meter;
}

interface OpenTelemetryLockMetrics {
  readonly listener: LockingTaskExecutorListener;
  onKeepAliveFailure(config: LockConfiguration, error: unknown): void;
  instrument(provider: LockProvider): LockProvider;
}

function createOpenTelemetryLockMetrics(
  options?: OpenTelemetryLockMetricsOptions,
): OpenTelemetryLockMetrics;
```

`TSLOCK_METRIC_NAMES` and `TSLOCK_METRIC_ATTRIBUTES` export the instrument names and attribute keys below.

### Factory

- `options.meter`, when provided, is used as-is.
- When `meter` is omitted, the factory uses `metrics.getMeter('@tslock/otel')` from the global API.
- Instruments are created when the factory runs.
- The returned object is frozen. `onKeepAliveFailure` and `instrument` do not depend on `this`.

### `listener`

Implements `LockingTaskExecutorListener` and records:

| Callback | Instrument | Type | Unit |
|---|---|---|---|
| `onLockAttempt` | `tslock.lock.attempt` | Counter | `{attempt}` |
| `onLockAcquired` | `tslock.lock.acquired` | Counter | `{lock}` |
| `onLockNotAcquired` | `tslock.lock.skipped` | Counter | `{lock}` |
| `onTaskStarted` | `tslock.task.active` | UpDownCounter | `{task}` |
| `onTaskFinished` | `tslock.task.duration` | Histogram | `ms` |
| `onTaskFinished` | `tslock.task.active` | UpDownCounter | `{task}` |

`onTaskFinished` records `executionTimeMillis` and adds `-1` to the active counter. `onUnlockError` is not a second unlock counter. Unlock is recorded by `instrument`.

Listener behavior follows the executor. A reentrant `executeWithLock` emits task start and finish only. A skipped lock emits attempt and skipped, and does not change the active counter.

### `instrument`

Returns a `LockProvider` whose `lock` delegates to the given provider. A returned lock is wrapped. `undefined` is returned unchanged.

Calling `instrument` with a provider it already returned returns that same object.

The wrapper implements `LockProvider` only. Provider-specific methods stay on the original instance. Callers that use `KeepAliveLockProvider` instrument the storage provider, then pass the wrapper into `KeepAliveLockProvider`. Instrumenting the keep-alive wrapper instead of the storage provider counts the outer unlock and misses internal renewals.

Wrapped `unlock`:

- Awaits the delegate.
- On fulfillment, records `tslock.lock.unlocked` with `outcome=success` and `tslock.lock.unlock.duration` in milliseconds.
- On rejection or throw, records both instruments with `outcome=failure` and `error.type`, then rethrows. The executor still swallows unlock failures and may call `onUnlockError`.

Wrapped `extend(lockAtMostFor, lockAtLeastFor)`:

- Awaits the delegate.
- A returned lock is wrapped again. The metric attributes use the requested durations. The wrapper records `tslock.lock.extend` and `tslock.lock.extend.duration` with `outcome=success`.
- `undefined` records both instruments with `outcome=failure` and `error.type=NotExtended`, then returns `undefined`.
- A throw records both instruments with `outcome=failure` and `error.type` set from the error, then rethrows.

Duration histograms use explicit bucket boundaries in milliseconds: 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 30000, 60000, 300000.

### `onKeepAliveFailure`

Records `tslock.lock.keepalive.failure` with `error.type` taken from the error. This is the callback passed as the third argument of `KeepAliveLockProvider`. It does not replace extend metrics: a lost renewal records an extend failure and then this counter when keep-alive stops.

## Attributes

| Key | Value | Applied to |
|---|---|---|
| `lock.name` | `LockConfiguration.name` | Every instrument |
| `lock.at_most_for_ms` | `lockAtMostFor` | Every instrument |
| `lock.at_least_for_ms` | `lockAtLeastFor` | Every instrument |
| `outcome` | `success` or `failure` | Unlock and extend counters and histograms |
| `error.type` | Error `name`, `NotExtended`, or `Error` | Failure outcomes and keep-alive failure |

`error.type` uses `error.name` when `error` is an `Error` with a non-empty name. Otherwise it is `Error`. Extend returning `undefined` uses `NotExtended`. Error messages are not attributes.

`lock.at_most_for_ms` and `lock.at_least_for_ms` are low-cardinality only when a lock name uses stable durations. The active-task add and subtract use the same configuration object the executor passed, so the series returns to zero.

## Error and concurrency behavior

- Metric recording failures are swallowed. They do not change acquire, skip, unlock, extend, or keep-alive results.
- The wrapper does not catch provider failures except to record them and rethrow.
- No process-global registry is mutated except through the `Meter` the caller supplied or the global OpenTelemetry meter.
- The wrapper is safe for concurrent `lock` calls on different names. It does not add locking of its own.

## Compatibility

- `@tslock/core` public types are unchanged.
- Existing listeners, providers, and keep-alive callers behave the same when this package is not installed.
- Instrument names and attribute keys in `TSLOCK_METRIC_NAMES` and `TSLOCK_METRIC_ATTRIBUTES` are stable for this package version.

## Tests

Unit tests with an in-memory OpenTelemetry metric reader and `@tslock/in-memory`:

- Acquired, skipped, attempt, task duration, active returning to zero, and successful unlock, including `lock.name` and duration attributes.
- `LockExtender.extendActiveLock` records extend success and the requested durations.
- Extend returning `undefined` records `outcome=failure` and `error.type=NotExtended`.
- Extend throwing records `outcome=failure`, `error.type`, and rethrows.
- Unlock throwing records failure, rethrows into the executor, and the task result is preserved.
- Keep-alive loss records extend failure and keep-alive failure. A successful renewal records extend success and no keep-alive failure.
- A meter that throws does not fail `unlock`.
- `instrument` on its own result returns the same object and does not double-count unlock.

No container or network tests.

## Documentation

- `packages/otel/README.md` with install, SDK setup, the executor example, the keep-alive wiring, and the metric table.
- Root `README.md` package table.
- Short pointers from the core README, vision, architecture, and `AGENTS.md` so metrics are no longer described as entirely deferred.

## Assumptions

- Counters satisfy the issue's "events/metrics" wording. A separate OpenTelemetry log event is out of scope.
- `@tslock/core` stays a normal dependency, matching `@tslock/middleware-core`, because the integration cannot run without it.
- Version stays lockstep with the other `@tslock/*` packages (`2.0.1` until the next release).
