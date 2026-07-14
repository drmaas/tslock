# @tslock/sql

> TSLock provider for raw SQL drivers — PostgreSQL (`pg`), MySQL/MariaDB (`mysql2`), and SQL Server (`mssql`).

A [TSLock](../../README.md) provider built on the shared SQL infrastructure in [`@tslock/sql-support`](../sql-support/README.md). It ships thin `SqlConnection` adapters for the three most common Node SQL drivers and a `SqlLockProvider` that executes the standard ShedLock insert-or-update SQL through whichever adapter you choose.

You only install the driver you actually use (declared as a peer dependency).

## Installation

```bash
pnpm add @tslock/core @tslock/sql @tslock/sql-support pg
# or: mysql2 / mssql instead of pg
```

## Setup

Create a `shedlock` table once per database:

```sql
-- PostgreSQL / MySQL / SQL Server
-- Column names match the defaults in SqlConfiguration.
CREATE TABLE shedlock (
  name       VARCHAR(64)  NOT NULL,
  lockUntil  TIMESTAMP    NOT NULL,
  lockedAt   TIMESTAMP    NOT NULL,
  lockedBy   VARCHAR(255) NOT NULL,
  PRIMARY KEY (name)
);
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { SqlLockProvider, PgConnection } from '@tslock/sql';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';
import { Pool } from 'pg';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

const provider = new SqlLockProvider(
  new PgConnection(pool),
  new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
);

const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => runBatchJob(),
  createLockConfig({ name: 'batch-job', lockAtMostFor: '30m', lockAtLeastFor: '1m' }),
);
```

### Adapters

| Class | Driver | `DatabaseProduct` |
|---|---|---|
| `PgConnection` | `pg` | `POSTGRES` |
| `Mysql2Connection` | `mysql2` | `MYSQL` / `MARIA_DB` |
| `MssqlConnection` | `mssql` | `SQL_SERVER` |

## Configuration

`SqlConfiguration` (from `@tslock/sql-support`) accepts:

| Option | Default | Description |
|---|---|---|
| `databaseProduct` | — (required) | The DB flavor, drives SQL dialect. |
| `tableName` | `'shedlock'` | Lock table name. |
| `columnNames` | see below | Override any of `name`, `lockUntil`, `lockedAt`, `lockedBy`. |
| `lockedByValue` | `os.hostname()` | Identifier written to `locked_by`. |
| `timeZone` | `undefined` | Store timestamps in a specific timezone. |
| `useDbTime` | `false` | Use the DB server's clock (`now()` / `GETUTCDATE()`). Cannot be combined with `timeZone`. |

Default column names: `name`, `lockUntil`, `lockedAt`, `lockedBy`.

## Requirements

- Node.js >= 22
- One peer driver: `pg`, `mysql2`, or `mssql`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
