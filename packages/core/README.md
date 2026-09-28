# @tslock/core

> Core abstractions for TSLock — distributed locks for scheduled tasks in TypeScript.

This is the heart of [TSLock](../../README.md). It defines the lock model (`LockProvider`, `SimpleLock`, `LockConfiguration`), the task executor that wraps your scheduled work in a lock, and the `AsyncLocalStorage`-based helpers for asserting and extending locks from within a task. It has **zero runtime dependencies** and is required by every provider package.

## Installation

```bash
pnpm add @tslock/core
```

You'll also install a [provider package](../../README.md#packages) (e.g. `@tslock/redis`) that supplies a concrete `LockProvider`.

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createNodeRedisLockProvider } from '@tslock/redis';
import { createClient } from 'redis';

const redisClient = createClient({ url: 'redis://localhost:6379' });
await redisClient.connect();

const provider = createNodeRedisLockProvider(redisClient);
const executor = new DefaultLockingTaskExecutor(provider);

// Wrap a scheduled task. If another instance already holds the lock,
// this call skips the task and returns wasExecuted: false.
const result = await executor.executeWithLock(
  async () => {
    console.log('Running the task on exactly one instance…');
    // ... your batch job, cleanup, webhook, etc.
  },
  createLockConfig({
    name: 'nightly-cleanup',
    lockAtMostFor: '5m', // safety net: auto-expires if the holder crashes
    lockAtLeastFor: '1m', // prevents immediate re-run from clock drift
  }),
);

console.log(result.wasExecuted); // true on the winner, false on everyone else
```

### Asserting and extending from within a task

```typescript
import { LockAssert, LockExtender } from '@tslock/core';

await executor.executeWithLock(
  async () => {
    LockAssert.assertLocked(); // throws if called outside a lock context
    // ... do some work ...
    await LockExtender.extendActiveLock('10m', 0); // push the deadline out
    // ... keep going ...
  },
  createLockConfig({ name: 'long-task', lockAtMostFor: '5m' }),
);
```

### Auto-renewing long tasks

`KeepAliveLockProvider` wraps an extensible provider and renews the lock on a timer so long-running tasks don't hit their deadline:

```typescript
import { KeepAliveLockProvider } from '@tslock/core';
const provider = new KeepAliveLockProvider(extensibleProvider);
```

### Metrics

[`@tslock/otel`](../otel/README.md) records OpenTelemetry metrics from `LockingTaskExecutorListener`, unlock and extend calls, and the keep-alive failure callback. Prometheus and other systems can implement the listener directly. Core does not depend on a metrics library.

### Lock health snapshot (ops)

`TrackingLockProviderWrapper` plus `createLockHealthMonitor` expose a **read-only**, process-local snapshot for operators when `lockAtMostFor` looks wrong or a node wedges. This is point-in-time introspection; use `@tslock/otel` for continuous metrics. There is no admin unlock API.

```typescript
import {
  createLockConfig,
  createLockHealthMonitor,
  DefaultLockingTaskExecutor,
  KeepAliveLockProvider,
  TrackingLockProviderWrapper,
} from '@tslock/core';
import http from 'node:http';

const tracking = new TrackingLockProviderWrapper(storage);
const health = createLockHealthMonitor({ tracking });
// Wrap tracking with keep-alive so renewals refresh tracking metadata.
const provider = new KeepAliveLockProvider(tracking, undefined, health.onKeepAliveFailure);
const executor = new DefaultLockingTaskExecutor(provider, health);

http.createServer((req, res) => {
  if (req.url === '/health/locks') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(health.snapshot()));
    return;
  }
  res.writeHead(404);
  res.end();
}).listen(8080);

// CLI / operator dump
console.log(health.formatSnapshot());
```

When also using `@tslock/otel`, instrument the storage provider before tracking, and forward listener / keep-alive callbacks to both helpers yourself.

#### Stable snapshot shape

| Field | Meaning |
|---|---|
| `takenAt` | Epoch millis when the snapshot was taken. |
| `activeLocks` | Locks this process currently holds (`name`, durations, `acquiredAt`, `updatedAt`), sorted by name. |
| `lastAcquired` / `lastSkipped` | Most recent executor acquire / skip event, if any. |
| `recentKeepAliveFailures` | Ring buffer of keep-alive stop events (`errorType`, default capacity 16). |
| `overdueLocks` | Active locks where `takenAt - updatedAt > lockAtMostFor` (lease should have expired or been renewed). |

## Exports

| Export | Description |
|---|---|
| `LockProvider`, `ExtensibleLockProvider` | The lock acquisition interfaces. |
| `SimpleLock`, `AbstractSimpleLock` | The lock handle (`unlock`, `extend`). |
| `LockConfiguration`, `createLockConfig` | Immutable config + builder helper. |
| `DefaultLockingTaskExecutor`, `TaskResult` | Wraps a task in acquire/release. |
| `LockingTaskExecutorListener` | Callbacks for attempt, acquire, skip, task start/finish, and unlock errors. |
| `LockAssert` | Assert code runs inside a lock context. |
| `LockExtender` | Extend the active lock from within a task. |
| `KeepAliveLockProvider` | Auto-renewing wrapper. |
| `TrackingLockProviderWrapper`, `ActiveLockRecord` | Introspect currently-held locks and metadata. |
| `createLockHealthMonitor`, `LockHealthSnapshot` | Read-only ops snapshot (active / skip / keep-alive / overdue). |
| `StorageBasedLockProvider`, `AbstractStorageAccessor` | Base classes for provider authors. |
| `ClockProvider`, `parseDuration`, `Utils` | Time, duration parsing, and helpers. |
| `LockException` and subclasses | Error hierarchy. |

## Requirements

- Node.js >= 22
- TypeScript 5.x (optional, but recommended)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
