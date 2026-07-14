# @tslock/cassandra

> TSLock provider backed by [Cassandra](https://cassandra.apache.org/).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` over the `cassandra-driver`. Locks use Lightweight Transactions (LWT) — `INSERT … IF NOT EXISTS` for first-time locks and `UPDATE … IF` conditions for updates — giving compare-and-set atomicity via Paxos.

## Installation

```bash
pnpm add @tslock/core @tslock/cassandra cassandra-driver
```

## Setup

Create the lock table once (or use the included helper):

```typescript
import { createLockTable } from '@tslock/cassandra';
await createLockTable(client, { keyspace: 'my_keyspace' });
```

The equivalent CQL:

```sql
CREATE TABLE IF NOT EXISTS my_keyspace.shedlock (
  name        text PRIMARY KEY,
  lock_until  timestamp,
  locked_at   timestamp,
  locked_by   text
);
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { CassandraLockProvider } from '@tslock/cassandra';
import cassandra from 'cassandra-driver';

const client = new cassandra.Client({
  contactPoints: ['localhost:9042'],
  localDataCenter: 'datacenter1',
});

const provider = new CassandraLockProvider(client, { keyspace: 'my_keyspace' });
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new CassandraLockProvider(client, options)` accepts a required `options`:

| Option | Default | Description |
|---|---|---|
| `keyspace` | — (required) | The Cassandra keyspace. |
| `tableName` | `'shedlock'` | Lock table name. |
| `columnNames` | see below | Override any of `name`, `lockUntil`, `lockedAt`, `lockedBy`. |
| `lockedByValue` | `os.hostname()` | Identifier written to `locked_by`. |
| `consistencyLevel` | `LOCAL_QUORUM` (6) | Consistency for non-LWT statements. |
| `serialConsistencyLevel` | `SERIAL` (9) | Consistency for LWT. |

Default column names: `name`, `lock_until`, `locked_at`, `locked_by`.

## Requirements

- Node.js >= 22
- Peer: `cassandra-driver`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
