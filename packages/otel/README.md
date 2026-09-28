# @tslock/otel

> OpenTelemetry metrics for TSLock.

`@tslock/otel` records lock acquire, skip, unlock, extend, and keep-alive failure on an OpenTelemetry meter. It uses the existing `LockingTaskExecutorListener`, a thin wrapper around the storage provider's lock handle, and `KeepAliveLockProvider`'s failure callback. `@tslock/core` is unchanged.

The package depends on the OpenTelemetry API only. You install the SDK and exporter you already use.

## Installation

```bash
pnpm add @tslock/core @tslock/otel @opentelemetry/api
```

Install one lock provider as well, plus `@opentelemetry/sdk-metrics` (or the Node SDK) and an exporter.

`@opentelemetry/api` is a peer dependency. Keep a single copy in the application so `metrics.setGlobalMeterProvider` is visible to this package.

## Usage

Start the SDK, then create the metrics helper. Pass `listener` to `DefaultLockingTaskExecutor`. Pass the storage provider through `instrument` before the executor, or before `KeepAliveLockProvider`, so unlock and extend calls are visible.

```typescript
import { metrics } from '@opentelemetry/api';
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createOpenTelemetryLockMetrics } from '@tslock/otel';

const otel = createOpenTelemetryLockMetrics({
  meter: metrics.getMeter('@tslock/otel'),
});

const storage = new InMemoryLockProvider();
const executor = new DefaultLockingTaskExecutor(otel.instrument(storage), otel.listener);

const result = await executor.executeWithLock(async () => {
  // one instance runs this body
}, createLockConfig('nightly-cleanup', '5m', '1m'));
```

Omit `meter` to use `metrics.getMeter('@tslock/otel')`. Call `metrics.setGlobalMeterProvider`, or start the SDK, before `createOpenTelemetryLockMetrics()`. Instruments are created in the factory. The metrics API does not attach those instruments to a provider registered later; pass `meter` from a provider that is already started when you need an explicit meter.

### Keep-alive

Instrument the storage provider. Pass `onKeepAliveFailure` as the third `KeepAliveLockProvider` argument. Wrapping the keep-alive provider itself counts the outer unlock and misses the renewals keep-alive performs on the inner handle.

```typescript
import { KeepAliveLockProvider } from '@tslock/core';

const provider = new KeepAliveLockProvider(
  otel.instrument(storage),
  undefined,
  otel.onKeepAliveFailure,
);
const executor = new DefaultLockingTaskExecutor(provider, otel.listener);
```

`lockAtMostFor` must be at least 30 seconds for keep-alive. A renewal that returns no lock, or whose single retry throws, increments `tslock.lock.keepalive.failure` and also records the failed extend.

`instrument` returns a `LockProvider`. Provider-specific methods stay on the original instance. Calling `instrument` again with that wrapper returns the same object.

## Metrics

Every instrument has `lock.name`, `lock.at_most_for_ms`, and `lock.at_least_for_ms`. Unlock and extend also have `outcome` (`success` or `failure`). Failures add `error.type` (the error `name`, or `NotExtended` when `extend` returns `undefined`). Error messages are not attributes. Lease attributes stay low-cardinality when each lock name uses stable durations.

| Instrument | Type | When |
|---|---|---|
| `tslock.lock.attempt` | Counter | `onLockAttempt` |
| `tslock.lock.acquired` | Counter | Lock acquired |
| `tslock.lock.skipped` | Counter | Lock held elsewhere |
| `tslock.task.duration` | Histogram (`ms`) | Task finished, value is execution time |
| `tslock.task.active` | UpDownCounter | `+1` when the task starts, `-1` when it finishes |
| `tslock.lock.unlocked` | Counter | `unlock()` resolved or rejected |
| `tslock.lock.unlock.duration` | Histogram (`ms`) | `unlock()` call duration |
| `tslock.lock.extend` | Counter | `extend()` success, `undefined`, or throw |
| `tslock.lock.extend.duration` | Histogram (`ms`) | `extend()` call duration. Attributes use the requested durations |
| `tslock.lock.keepalive.failure` | Counter | Keep-alive stopped because the lock was lost or the retry failed |

Duration histograms use millisecond bucket boundaries from 5ms through 5 minutes. `onUnlockError` is not a second unlock counter; the wrapper records the failed `unlock()` and the executor still reports the error to other listeners you compose yourself.

`DefaultLockingTaskExecutor` unlocks the handle it acquired. After `LockExtender.extendActiveLock`, that handle is already spent, so the unlock series records `outcome=failure` and `error.type=LockException`. The extend series still records success. Keep-alive renews through the wrapped handle and unlocks the current one, so a normal keep-alive release records unlock success.

Names and attribute keys are exported as `TSLOCK_METRIC_NAMES` and `TSLOCK_METRIC_ATTRIBUTES`.

## Requirements

- Node.js >= 22
- Peer: `@opentelemetry/api` ^1.9.0

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
