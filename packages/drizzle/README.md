# @tslock/drizzle

> TSLock SQL provider via the [Drizzle ORM](https://orm.drizzle.team/).

A [TSLock](../../README.md) provider that runs the standard ShedLock insert-or-update SQL through Drizzle's `db.execute()` / `db.run()` APIs, sharing configuration and statement generation with [`@tslock/sql-support`](../sql-support/README.md). Supports PostgreSQL, MySQL, and SQLite.

## Installation

```bash
pnpm add @tslock/core @tslock/drizzle @tslock/sql-support drizzle-orm pg
# or mysql2 / better-sqlite3 instead of pg
```

## Setup

Create a `shedlock` table (same schema as the raw SQL provider — see [`@tslock/sql`](../sql/README.md#setup)).

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { DrizzleLockProvider } from '@tslock/drizzle';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const db = drizzle(pool);

const provider = new DrizzleLockProvider(
  db,
  'postgresql',
  new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
);

const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => runBatchJob(),
  createLockConfig({ name: 'batch-job', lockAtMostFor: '30m' }),
);
```

The second argument is the dialect name: `'postgresql' | 'mysql' | 'sqlite'`. The third is a standard `SqlConfiguration` — see [`@tslock/sql-support`](../sql-support/README.md#configuration) for all options.

## Requirements

- Node.js >= 22
- Peer: `drizzle-orm` + a driver (`pg`, `mysql2`, or `better-sqlite3`)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
