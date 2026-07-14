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

## Exports

| Export | Description |
|---|---|
| `LockProvider`, `ExtensibleLockProvider` | The lock acquisition interfaces. |
| `SimpleLock`, `AbstractSimpleLock` | The lock handle (`unlock`, `extend`). |
| `LockConfiguration`, `createLockConfig` | Immutable config + builder helper. |
| `DefaultLockingTaskExecutor`, `TaskResult` | Wraps a task in acquire/release. |
| `LockAssert` | Assert code runs inside a lock context. |
| `LockExtender` | Extend the active lock from within a task. |
| `KeepAliveLockProvider` | Auto-renewing wrapper. |
| `TrackingLockProviderWrapper` | Introspect currently-held locks. |
| `StorageBasedLockProvider`, `AbstractStorageAccessor` | Base classes for provider authors. |
| `ClockProvider`, `parseDuration`, `Utils` | Time, duration parsing, and helpers. |
| `LockException` and subclasses | Error hierarchy. |

## Requirements

- Node.js >= 22
- TypeScript 5.x (optional, but recommended)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
