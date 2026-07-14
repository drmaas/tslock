# @tslock/sql-support

> Shared SQL infrastructure for the TSLock SQL providers.

This package contains the dialect-aware SQL statements and configuration shared by [`@tslock/sql`](../sql/README.md), [`@tslock/kysely`](../kysely/README.md), and [`@tslock/drizzle`](../drizzle/README.md). You rarely use it directly — it's consumed by those three packages — but it's published separately so each SQL package can stay lean and so you can build your own SQL adapter on top of the same statements if you need to.

It has no driver dependencies; it only depends on [`@tslock/core`](../core/README.md).

## Installation

```bash
pnpm add @tslock/sql-support
```

## What's inside

| Export | Description |
|---|---|
| `DatabaseProduct` | Enum of supported SQL databases (`POSTGRES`, `MYSQL`, `SQL_SERVER`, `ORACLE`, `DB2`, …). |
| `SqlConfiguration` | Typed config object: table name, column names, `lockedByValue`, `timeZone`, `useDbTime`. |
| `SqlStatementsSource` + `createSqlStatementsSource()` | Produces the dialect-correct `INSERT` / `UPDATE` / `EXTEND` / `UNLOCK` statements. |
| `ServerTimeStatementsSource` variants | DB-server-clock statement sources (e.g. `PostgresServerTimeStatementsSource`). |
| `timestamp()` | Helper for the `timeZone` option. |

## Usage (building a custom adapter)

```typescript
import { SqlConfiguration, DatabaseProduct, createSqlStatementsSource } from '@tslock/sql-support';

const config = new SqlConfiguration({
  databaseProduct: DatabaseProduct.POSTGRES,
  tableName: 'shedlock',
});

const source = createSqlStatementsSource(config);
const insertSql = source.getInsertStatement(); // parameterized INSERT statement
```

## Requirements

- Node.js >= 22

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
