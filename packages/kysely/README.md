# @tslock/kysely

> TSLock SQL provider via the [Kysely](https://kysely.dev/) type-safe query builder.

A [TSLock](../../README.md) provider that runs the standard ShedLock insert-or-update SQL through Kysely's `db.executeQuery()` API, sharing configuration and statement generation with [`@tslock/sql-support`](../sql-support/README.md). Supports PostgreSQL, MySQL, and SQLite.

## Installation

```bash
pnpm add @tslock/core @tslock/kysely @tslock/sql-support kysely pg
# or mysql2 / better-sqlite3 instead of pg
```

## Setup

Create a `shedlock` table (same schema as the raw SQL provider — see [`@tslock/sql`](../sql/README.md#setup)).

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { KyselyLockProvider } from '@tslock/kysely';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';

const db = new Kysely<any>({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
});

const provider = new KyselyLockProvider(
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

The second argument is the dialect name: `'postgresql' | 'mysql' | 'sqlite'`. The third is a standard `SqlConfiguration` — see [`@tslock/sql-support`](../sql-support/README.md#configuration) for all options (table name, column overrides, `useDbTime`, etc.).

## Requirements

- Node.js >= 22
- Peer: `kysely` + a driver (`pg`, `mysql2`, or `better-sqlite3`)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
