# @tslock/couchbase

> TSLock provider backed by [Couchbase](https://www.couchbase.com/).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` over the Couchbase Node SDK. Locks are acquired with `Collection.insert()` (fails atomically with `DocumentExistsException` for first-time locks) and updated/released with `Collection.replace()` using CAS (fails with `CasMismatchException` on contention).

## Installation

```bash
pnpm add @tslock/core @tslock/couchbase couchbase
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { CouchbaseLockProvider } from '@tslock/couchbase';
import { Cluster } from 'couchbase';

const cluster = await Cluster.connect('couchbase://localhost', { username: 'admin', password: 'password' });
const bucket = cluster.bucket('default');
const collection = bucket.defaultCollection();

const provider = new CouchbaseLockProvider(collection);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new CouchbaseLockProvider(collection, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `documentIdPrefix` | `'shedlock:'` | Prefix for lock document IDs. |
| `columnNames` | see below | Override any of `name`, `lockUntil`, `lockedAt`, `lockedBy`. |
| `lockedByValue` | `'unknown'` | Identifier written to `lockedBy`. |

Default field names: `name`, `lockUntil`, `lockedAt`, `lockedBy`. A lock document's ID is `${documentIdPrefix}${lockName}`.

## Requirements

- Node.js >= 22
- Peer: `couchbase` (npm `couchbase@4.x` = Couchbase SDK 3.x)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
