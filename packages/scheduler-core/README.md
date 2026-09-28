# @tslock/scheduler-core

> Shared lock wrap lifecycle for TSLock scheduler adapters.

Framework/library adapters (`@tslock/node-cron`, `@tslock/bree`, `@tslock/aws-lambda`) use this package to resolve defaults and wrap callbacks with `DefaultLockingTaskExecutor`. `@tslock/core` stays free of schedulers.

## Installation

```bash
pnpm add @tslock/core @tslock/scheduler-core
```

Most applications install an adapter package instead of depending on this package directly.

## Usage

```typescript
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createSchedulerLock } from '@tslock/scheduler-core';

const lock = createSchedulerLock({
  lockProvider: new InMemoryLockProvider(),
  defaultLockAtMostFor: '5m',
});

const job = lock.wrap(async () => {
  // runs on at most one instance
}, { name: 'nightly-cleanup' });

await job();
```

When the lock is already held, the wrapper skips the callback and resolves `undefined`. Storage and task errors propagate. `LockAssert` and `LockExtender` work inside the wrapped body.

## Requirements

- Node.js >= 22

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
