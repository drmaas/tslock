# @tslock/mongo

> TSLock provider backed by [MongoDB](https://www.mongodb.com/).

A [TSLock](../../README.md) provider that uses the official `mongodb` driver and the `findOneAndUpdate` atomic operation (single round-trip) rather than the insert-then-update pattern. Locks use `WriteConcern.MAJORITY` and `ReadConcern.MAJORITY` so writes are replicated to a majority before acknowledgement — matching ShedLock's `MongoLockProvider`.

## Installation

```bash
pnpm add @tslock/core @tslock/mongo mongodb
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createMongoLockProvider } from '@tslock/mongo';
import { MongoClient } from 'mongodb';

const client = new MongoClient(process.env.MONGODB_URI!);
const db = client.db('my-app');

const provider = createMongoLockProvider(db);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createMongoLockProvider(db, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `collection` | `'shedLock'` | The collection used for lock documents. |
| `collectionOptions.writeConcern` | `{ w: 'majority' }` | MongoDB write concern. |
| `collectionOptions.readConcern` | `{ level: 'majority' }` | MongoDB read concern. |

The lock document's `_id` is the lock name; it also stores `lockUntil`, `lockedAt`, and `lockedBy` (hostname).

## Requirements

- Node.js >= 22
- Peer: `mongodb`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
