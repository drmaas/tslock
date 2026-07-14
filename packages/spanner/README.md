# @tslock/spanner

> TSLock provider backed by Google Cloud [Spanner](https://cloud.google.com/spanner).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` that runs inside Spanner `readWriteTransaction`s and uses mutations for inserts/updates.

## Installation

```bash
pnpm add @tslock/core @tslock/spanner @google-cloud/spanner
```

## Setup

Create the lock table once:

```sql
-- Column names match the defaults passed to createSpannerProvider below.
CREATE TABLE shedlock (
  name       STRING(64)  NOT NULL,
  lockUntil  TIMESTAMP    NOT NULL,
  lockedAt   TIMESTAMP    NOT NULL,
  lockedBy   STRING(255) NOT NULL,
) PRIMARY KEY (name);
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createSpannerProvider } from '@tslock/spanner';
import { Spanner } from '@google-cloud/spanner';

const spanner = new Spanner({ projectId: process.env.GCP_PROJECT_ID });
const instance = spanner.instance('my-instance');
const database = instance.database('my-database');

const provider = createSpannerProvider(database, 'shedlock', {
  name: 'name',
  lockUntil: 'lockUntil',
  lockedAt: 'lockedAt',
  lockedBy: 'lockedBy',
}, 'my-hostname');

const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m' }),
);
```

## Configuration

`createSpannerProvider(database, tableName, columnNames, lockedByValue)` takes:

| Argument | Default / notes |
|---|---|
| `database` | A Spanner `Database` instance (required). |
| `tableName` | e.g. `'shedlock'`. |
| `columnNames` | `{ name, lockUntil, lockedAt, lockedBy }` (all required). |
| `lockedByValue` | Identifier written to `lockedBy`. |

Use `resolveSpannerConfiguration()` if you prefer defaults + `Partial<SpannerColumnNames>` overrides.

## Requirements

- Node.js >= 22
- Peer: `@google-cloud/spanner`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
