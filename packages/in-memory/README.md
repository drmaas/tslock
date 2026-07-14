# @tslock/in-memory

> In-memory lock provider for TSLock — **testing and local development only.**

> ⚠️ **Not for production distributed locking.** This provider locks only within a single Node.js process. Multiple instances of your application will each have their own `Map` and will **not** coordinate. Use this for unit tests, local development, and single-process demos. For any deployment with more than one instance, use a real distributed backend — see the [provider matrix](../../README.md#packages).

A [TSLock](../../README.md) provider backed by a plain `Map<string, number>`. Node.js is single-threaded, so no synchronization is needed. It implements `ExtensibleLockProvider`, so it supports `extend()`.

## Installation

```bash
pnpm add @tslock/core @tslock/in-memory
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';

const provider = new InMemoryLockProvider();
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

It's also handy for unit-testing code that depends on a `LockProvider` without standing up a real backend:

```typescript
const provider = new InMemoryLockProvider();
provider.isLocked('my-task'); // false until a lock is held
```

## Requirements

- Node.js >= 22

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
