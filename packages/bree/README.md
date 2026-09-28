# @tslock/bree

> TSLock adapter for [Bree](https://github.com/breejs/bree) job workers.

Wraps job functions with `executeWithLock` so worker ticks skip when another instance holds the lock. Bree itself is unchanged — keep configuring jobs as usual and wrap the work inside the worker.

## Installation

```bash
pnpm add @tslock/core @tslock/bree bree
```

## Usage

Inside a Bree job worker (or any job function Bree runs):

```typescript
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createBreeLock } from '@tslock/bree';

const lock = createBreeLock({
  lockProvider: new InMemoryLockProvider(),
  defaultLockAtMostFor: '5m',
});

export default lock.wrap(async () => {
  // one instance runs this body
}, { name: 'cleanup', lockAtMostFor: '5m' });
```

Register the job with Bree as you normally would (`path`, `cron`, `interval`, and so on). When the lock is held elsewhere, the wrapper skips and resolves `undefined`.

Use a real TSLock provider in the worker process (each worker needs access to the same lock store).

## Requirements

- Node.js >= 22
- Peer: `bree` ^9

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
