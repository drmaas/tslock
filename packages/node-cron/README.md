# @tslock/node-cron

> TSLock adapter for [node-cron](https://www.npmjs.com/package/node-cron).

Wraps scheduled callbacks with `executeWithLock` so only one instance runs each tick. Optional `createRunCoordinator` plugs into node-cron v4 `distributed: true`.

## Installation

```bash
pnpm add @tslock/core @tslock/node-cron node-cron
```

Install any TSLock storage provider in place of the in-memory example below.

## Usage

```typescript
import cron from 'node-cron';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createNodeCronLock } from '@tslock/node-cron';

const lock = createNodeCronLock({
  lockProvider: new InMemoryLockProvider(),
  defaultLockAtMostFor: '50s',
});

lock.schedule(cron, '* * * * *', async () => {
  // one instance runs this body; others skip
}, { name: 'minute-job', lockAtMostFor: '50s' });
```

Or wrap a callback yourself:

```typescript
cron.schedule('* * * * *', lock.wrap(async () => {
  // ...
}, { name: 'minute-job' }));
```

When the lock is held elsewhere, the wrapper skips and resolves `undefined`.

### node-cron v4 RunCoordinator

Use either the wrap/`schedule` path **or** `createRunCoordinator` with `distributed: true` for a given job — not both, or you will double-lock.

```typescript
import cron, { setRunCoordinator } from 'node-cron';

setRunCoordinator(lock.createRunCoordinator({ keyPrefix: 'myapp:' }));

cron.schedule('0 3 * * *', runNightlyBackup, {
  name: 'nightly-backup',
  distributed: true,
  distributedLease: 60_000,
});
```

## Requirements

- Node.js >= 22
- Peer: `node-cron` ^3 or ^4

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
