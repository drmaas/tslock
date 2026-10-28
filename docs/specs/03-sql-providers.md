# Spec: @tslock/sql, @tslock/kysely, @tslock/drizzle

## Overview

This document specifies three SQL provider packages that implement `StorageBasedLockProvider` against SQL databases. All three share the `@tslock/sql-support` infrastructure (`DatabaseProduct`, `SqlConfiguration`, `SqlStatementsSource`) for SQL statement generation and parameter computation. They differ only in how they execute SQL and translate parameters:

- **`@tslock/sql`** — thin `SqlConnection` adapters for raw Node.js drivers (`pg`, `mysql2`, `mssql`). The user installs only the driver they need (peer deps). The `SqlStorageAccessor` executes raw SQL strings via the adapter.
- **`@tslock/kysely`** — uses Kysely's type-safe query execution (`db.executeQuery()` with compiled raw SQL). Peer dep: `kysely`.
- **`@tslock/drizzle`** — uses Drizzle ORM's `sql` template tag and `db.execute()` / `db.run()`. Peer dep: `drizzle-orm`.

All three use `StorageBasedLockProvider` from `@tslock/core` and implement `StorageAccessor` via a provider-specific accessor class.

## Package Summary

| Package | Peer Deps | Supports | Mechanism |
|---|---|---|---|
| `@tslock/sql` | `pg`, `mysql2`, `mssql` (install one) | PostgreSQL, CockroachDB, MySQL, MariaDB, SQL Server | Raw driver adapters |
| `@tslock/kysely` | `kysely` | PostgreSQL, MySQL, SQLite (Kysely dialects) | `db.executeQuery()` |
| `@tslock/drizzle` | `drizzle-orm` | PostgreSQL, MySQL, SQLite (Drizzle dialects) | `db.execute()` / `db.run()` |

All three also depend on `@tslock/core` and `@tslock/sql-support` (peer).

---

## Part 1: @tslock/sql

### 1.1 Package

| Field | Value |
|---|---|
| **Name** | `@tslock/sql` |
| **Dependencies** | `@tslock/core` (peer), `@tslock/sql-support` (peer) |
| **Peer deps** | `pg` or `mysql2` or `mssql` (user installs one) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |

### 1.2 SqlConnection Interface

The core abstraction that all driver adapters implement. It normalizes query execution and error detection across drivers.

```typescript
interface QueryResult {
  readonly affectedRows: number;
}

interface SqlConnection {
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
  isDuplicateKeyError(error: unknown): boolean;
  getDatabaseProduct(): DatabaseProduct;
}
```

**Contract:**
- `query(sql, params)`: executes a SQL string with `:name`-style named params. The adapter translates to the driver's native param style internally. Returns `affectedRows` (0 if no rows matched/modified).
- `isDuplicateKeyError(error)`: returns `true` if the error represents a unique constraint violation (duplicate key). Used by `SqlStorageAccessor` to distinguish "record already exists" from real errors.
- `getDatabaseProduct()`: returns the `DatabaseProduct` this adapter corresponds to. Used for auto-detection when the user does not specify `databaseProduct` in `SqlConfiguration`.

### 1.3 Connection Adapters

Three adapter classes ship in `@tslock/sql`. Each wraps a driver pool/connection and implements `SqlConnection`.

#### PgConnection (PostgreSQL / CockroachDB via `pg`)

```typescript
class PgConnection implements SqlConnection {
  constructor(pool: import('pg').Pool);
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
  isDuplicateKeyError(error: unknown): boolean;  // error.code === '23505'
  getDatabaseProduct(): DatabaseProduct;          // POSTGRES
}
```

**Param translation:** `:name` → `$1, $2, ...` (positional, 1-indexed). Values collected in order of first appearance in the SQL string.

**Duplicate key detection:** `pg` error with `code === '23505'` (unique_violation).

#### Mysql2Connection (MySQL / MariaDB via `mysql2`)

```typescript
class Mysql2Connection implements SqlConnection {
  constructor(pool: import('mysql2/promise').Pool);
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
  isDuplicateKeyError(error: unknown): boolean;  // error.errno === 1062
  getDatabaseProduct(): DatabaseProduct;          // MYSQL (or MARIA_DB if detected)
}
```

**Param translation:** `:name` → `?` (positional). Values collected in order of first appearance.

**Duplicate key detection:** `mysql2` error with `errno === 1062` (ER_DUP_ENTRY).

**Product detection:** `getDatabaseProduct()` returns `MARIA_DB` if the connection reports MariaDB in its server version string, otherwise `MYSQL`. This is determined at construction time by querying the server version.

#### MssqlConnection (SQL Server via `mssql`)

```typescript
class MssqlConnection implements SqlConnection {
  constructor(pool: import('mssql').ConnectionPool);
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
  isDuplicateKeyError(error: unknown): boolean;  // error.number === 2627 or 2601
  getDatabaseProduct(): DatabaseProduct;          // SQL_SERVER
}
```

**Param translation:** `:name` → `@name` (named, `@`-prefixed). The params object is passed directly as the `mssql` request's input parameters. No positional translation needed — `mssql` supports named params natively.

**Duplicate key detection:** `mssql` error with `number === 2627` (unique constraint violation) or `number === 2601` (cannot insert duplicate key row).

### 1.4 SqlStorageAccessor

```typescript
class SqlStorageAccessor extends AbstractStorageAccessor {
  constructor(
    connection: SqlConnection,
    statementsSource: SqlStatementsSource,
  );

  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration): Promise<boolean>;
}
```

**Implementation:**

```typescript
async insertRecord(config): Promise<boolean> {
  const sql = this.statementsSource.getInsertStatement();
  const params = this.statementsSource.params(config);
  try {
    const result = await this.connection.query(sql, params);
    return result.affectedRows > 0;
  } catch (e) {
    if (this.connection.isDuplicateKeyError(e)) return false;
    throw e;
  }
}

async updateRecord(config): Promise<boolean> {
  const sql = this.statementsSource.getUpdateStatement();
  const params = this.statementsSource.params(config);
  const result = await this.connection.query(sql, params);
  return result.affectedRows > 0;
}

async unlock(config): Promise<void> {
  const sql = this.statementsSource.getUnlockStatement();
  const params = this.statementsSource.params(config);
  await this.connection.query(sql, params);
}

async extend(config): Promise<boolean> {
  const sql = this.statementsSource.getExtendStatement();
  const params = this.statementsSource.params(config);
  const result = await this.connection.query(sql, params);
  return result.affectedRows > 0;
}
```

**`insertRecord` logic:**
- For Postgres/SQLite: the INSERT uses `ON CONFLICT DO NOTHING` / `INSERT OR IGNORE`, so duplicate keys produce 0 affected rows (no exception). `affectedRows > 0` → inserted.
- For MySQL/SQL Server: the INSERT is plain, so duplicate keys throw. `isDuplicateKeyError` catches it → `false` (record exists).
- Both paths converge to the same boolean result.

### 1.5 SqlLockProvider

```typescript
class SqlLockProvider extends StorageBasedLockProvider {
  constructor(
    connection: SqlConnection,
    config: SqlConfiguration,
  );
}
```

Convenience class that wires `SqlStorageAccessor` + `StorageBasedLockProvider`. Internally:

```typescript
class SqlLockProvider extends StorageBasedLockProvider {
  constructor(connection: SqlConnection, config: SqlConfiguration) {
    const statementsSource = SqlStatementsSource.create(config);
    const accessor = new SqlStorageAccessor(connection, statementsSource);
    super(accessor);
  }
}
```

This is an `ExtensibleLockProvider` (via `StorageBasedLockProvider`) — `extend()` is supported.

### 1.6 Usage Example

```typescript
import { Pool } from 'pg';
import { SqlLockProvider } from '@tslock/sql';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';
import { createLockConfig, LockingTaskExecutor } from '@tslock/core';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const connection = new PgConnection(pool);
const provider = new SqlLockProvider(
  connection,
  new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
);

const executor = new DefaultLockingTaskExecutor(provider);
await executor.executeWithLock(
  async () => { /* scheduled task */ },
  createLockConfig('my-task', 30 * 60 * 1000, 5 * 1000),
);
```

### 1.7 File Structure

```
packages/sql/
├── src/
│   ├── index.ts                       # public exports
│   ├── sql-connection.ts              # SqlConnection, QueryResult interfaces
│   ├── connections/
│   │   ├── pg-connection.ts           # PgConnection adapter
│   │   ├── mysql2-connection.ts       # Mysql2Connection adapter
│   │   └── mssql-connection.ts        # MssqlConnection adapter
│   ├── sql-storage-accessor.ts        # SqlStorageAccessor
│   ├── sql-lock-provider.ts           # SqlLockProvider
│   └── param-translator.ts            # :name → native param translation utilities
├── __tests__/
│   ├── unit/
│   │   ├── pg-connection.test.ts
│   │   ├── mysql2-connection.test.ts
│   │   ├── mssql-connection.test.ts
│   │   ├── sql-storage-accessor.test.ts
│   │   └── param-translator.test.ts
│   └── integration/
│       ├── postgres.integration.test.ts
│       ├── mysql.integration.test.ts
│       └── mssql.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Part 2: @tslock/kysely

### 2.1 Package

| Field | Value |
|---|---|
| **Name** | `@tslock/kysely` |
| **Dependencies** | `@tslock/core` (peer), `@tslock/sql-support` (peer) |
| **Peer deps** | `kysely` |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |

### 2.2 KyselyStorageAccessor

```typescript
class KyselyStorageAccessor extends AbstractStorageAccessor {
  constructor(
    db: import('kysely').Kysely<unknown>,
    statementsSource: SqlStatementsSource,
    dialect: KyselyDialect,
  );

  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration): Promise<boolean>;
}
```

**`dialect` parameter:** Needed for two reasons:
1. Determining the native param placeholder style (PostgreSQL uses `$1`, MySQL uses `?`, SQLite uses `?`).
2. Detecting duplicate key errors (error codes differ by dialect).

```typescript
type KyselyDialect = 'postgresql' | 'mysql' | 'sqlite';

interface KyselyDialectInfo {
  dialect: KyselyDialect;
  isDuplicateKeyError(error: unknown): boolean;
  translateParams(sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] };
}
```

**Param translation:** The `SqlStatementsSource` produces SQL with `:name` params. The `KyselyStorageAccessor` translates to the dialect's positional style:
- `postgresql`: `:name` → `$1, $2, ...`
- `mysql`: `:name` → `?`
- `sqlite`: `:name` → `?`

**Execution:** Uses Kysely's `sql` template tag to compile a raw SQL query, then executes via `db.executeQuery()`:

```typescript
import { sql } from 'kysely';

async insertRecord(config): Promise<boolean> {
  const rawSql = this.statementsSource.getInsertStatement();
  const params = this.statementsSource.params(config);
  const { sql: translatedSql, values } = this.dialectInfo.translateParams(rawSql, params);
  try {
    const compiled = sql.raw(translatedSql, values).compile(this.db);
    const result = await this.db.executeQuery(compiled);
    return numAffectedRows(result) > 0;
  } catch (e) {
    if (this.dialectInfo.isDuplicateKeyError(e)) return false;
    throw e;
  }
}
```

**`numAffectedRows(result)`:** Kysely's `QueryResult` has `numAffectedRows` as `bigint | undefined` for MySQL/PostgreSQL. Converts to number for comparison.

**Duplicate key detection by dialect:**
- `postgresql`: error code `'23505'` (in `e.code` or `e.nativeError.code`)
- `mysql`: errno `1062` (in `e.errno` or `e.nativeError.errno`)
- `sqlite`: error message contains `UNIQUE constraint failed` (SQLite doesn't use numeric codes; `e.message` check)

### 2.3 KyselyLockProvider

```typescript
class KyselyLockProvider extends StorageBasedLockProvider {
  constructor(
    db: import('kysely').Kysely<unknown>,
    config: SqlConfiguration,
    dialect: KyselyDialect,
  );
}
```

Internally:
```typescript
class KyselyLockProvider extends StorageBasedLockProvider {
  constructor(db, config, dialect) {
    const statementsSource = SqlStatementsSource.create(config);
    const accessor = new KyselyStorageAccessor(db, statementsSource, dialect);
    super(accessor);
  }
}
```

The `dialect` parameter is needed because Kysely's `Kysely` instance does not expose its dialect at runtime (it's a compile-time type). The user must specify which dialect they're using. The `config.databaseProduct` and `dialect` should be consistent (e.g., `POSTGRES` ↔ `'postgresql'`), but they serve different purposes: `databaseProduct` determines SQL statement generation; `dialect` determines param translation and error detection.

### 2.4 Usage Example

```typescript
import { Kysely, PostgresDialect } from 'kysely';
import { Pool } from 'pg';
import { KyselyLockProvider } from '@tslock/kysely';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';

const db = new Kysely({
  dialect: new PostgresDialect({ pool: new Pool({ connectionString: process.env.DATABASE_URL }) }),
});

const provider = new KyselyLockProvider(
  db,
  new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
  'postgresql',
);
```

### 2.5 File Structure

```
packages/kysely/
├── src/
│   ├── index.ts                       # public exports
│   ├── kysely-storage-accessor.ts      # KyselyStorageAccessor
│   ├── kysely-lock-provider.ts         # KyselyLockProvider
│   ├── dialect-info.ts                 # KyselyDialect type, per-dialect info (param translation, error detection)
│   └── param-translator.ts             # :name → positional translation (shared logic, same as @tslock/sql)
├── __tests__/
│   ├── unit/
│   │   ├── kysely-storage-accessor.test.ts
│   │   └── dialect-info.test.ts
│   └── integration/
│       ├── postgres.integration.test.ts
│       ├── mysql.integration.test.ts
│       └── sqlite.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Part 3: @tslock/drizzle

### 3.1 Package

| Field | Value |
|---|---|
| **Name** | `@tslock/drizzle` |
| **Dependencies** | `@tslock/core` (peer), `@tslock/sql-support` (peer) |
| **Peer deps** | `drizzle-orm` |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |

### 3.2 DrizzleStorageAccessor

```typescript
class DrizzleStorageAccessor extends AbstractStorageAccessor {
  constructor(
    db: DrizzleDatabase,
    statementsSource: SqlStatementsSource,
    dialect: DrizzleDialect,
  );

  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration): Promise<boolean>;
}
```

**Types:**
```typescript
type DrizzleDatabase = import('drizzle-orm/node-postgres').NodePgDatabase
  | import('drizzle-orm/mysql2').DrizzleMysqlDatabase
  | import('drizzle-orm/better-sqlite3').BetterSQLite3Database
  | import('drizzle-orm/libsql').LibSQLDatabase;

type DrizzleDialect = 'postgresql' | 'mysql' | 'sqlite';
```

**Param translation and execution:** Drizzle's `sql` template tag is used to build parameterized queries. The `SqlStatementsSource` SQL string (with `:name` params) is parsed: `:name` placeholders are replaced with Drizzle parameter nodes, and the param values are bound:

```typescript
import { sql } from 'drizzle-orm';

function buildDrizzleQuery(
  rawSql: string,
  params: Record<string, unknown>,
): import('drizzle-orm').SQL {
  const segments = rawSql.split(/:(\w+)/);
  const chunks: import('drizzle-orm').SQL[] = [];
  for (let i = 0; i < segments.length; i += 2) {
    if (segments[i]) chunks.push(sql.raw(segments[i]));
    if (i + 1 < segments.length) {
      const paramName = segments[i + 1];
      chunks.push(sql.param(params[paramName]));
    }
  }
  return sql.join(chunks, sql.raw(''));
}
```

Then execute:
- PostgreSQL/MySQL: `await this.db.execute(drizzleSql)` → result with `rowsAffected`
- SQLite: `await this.db.run(drizzleSql)` → result with `changes`

```typescript
async insertRecord(config): Promise<boolean> {
  const rawSql = this.statementsSource.getInsertStatement();
  const params = this.statementsSource.params(config);
  const query = buildDrizzleQuery(rawSql, params);
  try {
    const result = await this.execute(query);
    return this.getAffectedRows(result) > 0;
  } catch (e) {
    if (this.isDuplicateKeyError(e)) return false;
    throw e;
  }
}
```

**`execute(query)`:** calls `this.db.execute(query)` for PostgreSQL/MySQL, `this.db.run(query)` for SQLite. Dispatch based on `dialect`.

**`getAffectedRows(result)`:**
- PostgreSQL: `result.rowsAffected` (Drizzle node-postgres result)
- MySQL: `result[0].affectedRows` (Drizzle mysql2 result)
- SQLite: `result.changes` (Drizzle better-sqlite3 / libsql result)

**Duplicate key detection by dialect:**
- `postgresql`: error with `code === '23505'`
- `mysql`: error with `errno === 1062`
- `sqlite`: error message contains `UNIQUE constraint failed`

### 3.3 DrizzleLockProvider

```typescript
class DrizzleLockProvider extends StorageBasedLockProvider {
  constructor(
    db: DrizzleDatabase,
    config: SqlConfiguration,
    dialect: DrizzleDialect,
  );
}
```

Internally:
```typescript
class DrizzleLockProvider extends StorageBasedLockProvider {
  constructor(db, config, dialect) {
    const statementsSource = SqlStatementsSource.create(config);
    const accessor = new DrizzleStorageAccessor(db, statementsSource, dialect);
    super(accessor);
  }
}
```

### 3.4 Usage Example

```typescript
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { DrizzleLockProvider } from '@tslock/drizzle';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';

const db = drizzle(new Pool({ connectionString: process.env.DATABASE_URL }));

const provider = new DrizzleLockProvider(
  db,
  new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
  'postgresql',
);
```

### 3.5 File Structure

```
packages/drizzle/
├── src/
│   ├── index.ts                       # public exports
│   ├── drizzle-storage-accessor.ts     # DrizzleStorageAccessor
│   ├── drizzle-lock-provider.ts        # DrizzleLockProvider
│   ├── dialect-info.ts                 # DrizzleDialect type, per-dialect execute/affectedRows/error logic
│   └── query-builder.ts                # buildDrizzleQuery() — :name → sql.param()
├── __tests__/
│   ├── unit/
│   │   ├── drizzle-storage-accessor.test.ts
│   │   ├── dialect-info.test.ts
│   │   └── query-builder.test.ts
│   └── integration/
│       ├── postgres.integration.test.ts
│       ├── mysql.integration.test.ts
│       └── sqlite.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

---

## Shared SQL Statement Templates

All three providers execute the same SQL statement strings from `SqlStatementsSource`. The statements are defined in `@tslock/sql-support` (see spec `02-sql-support.md`). Each provider only differs in:
1. How `:name` params are translated to the driver's native format.
2. How the query is executed (driver API).
3. How affected rows are read from the result.
4. How duplicate key errors are detected.

| Provider | Param style | Execution API | Affected rows | Duplicate key detection |
|---|---|---|---|---|
| `@tslock/sql` (pg) | `$1, $2, ...` | `pool.query(sql, values)` | `result.rowCount` | `error.code === '23505'` |
| `@tslock/sql` (mysql2) | `?` | `pool.query(sql, values)` | `result.affectedRows` | `error.errno === 1062` |
| `@tslock/sql` (mssql) | `@name` | `request.input(name, value).query(sql)` | `result.rowsAffected[0]` | `error.number === 2627 \|\| 2601` |
| `@tslock/kysely` (pg) | `$1, $2, ...` | `db.executeQuery(sql.raw(...).compile(db))` | `result.numAffectedRows` (bigint) | `error.code === '23505'` |
| `@tslock/kysely` (mysql) | `?` | same | same | `error.errno === 1062` |
| `@tslock/kysely` (sqlite) | `?` | same | same | message contains `UNIQUE constraint failed` |
| `@tslock/drizzle` (pg) | `sql.param()` | `db.execute(query)` | `result.rowsAffected` | `error.code === '23505'` |
| `@tslock/drizzle` (mysql) | `sql.param()` | `db.execute(query)` | `result[0].affectedRows` | `error.errno === 1062` |
| `@tslock/drizzle` (sqlite) | `sql.param()` | `db.run(query)` | `result.changes` | message contains `UNIQUE constraint failed` |

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock record already exists (insert) | `insertRecord` returns `false` (caught duplicate key or 0 affected rows) |
| Update matches 0 rows (lock held by other) | `updateRecord` returns `false` |
| Extend matches 0 rows (lock expired or held by other) | `extend` returns `false` |
| Unlock matches 0 rows | `unlock` returns `void` (no error — best-effort) |
| Connection error during any operation | Propagate the error (throw) |
| Non-duplicate-key constraint violation | Propagate the error (throw) |
| `affectedRows` not available in result | Treat as `0` (return `false`) — log a warning |
| Driver not installed (peer dep missing) | `import` throws at adapter construction time — user sees clear error |

## Dependencies

### @tslock/sql
- **Peer**: `@tslock/core`, `@tslock/sql-support`, `pg` (optional), `mysql2` (optional), `mssql` (optional)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `pg`, `mysql2`, `mssql`, `testcontainers`

### @tslock/kysely
- **Peer**: `@tslock/core`, `@tslock/sql-support`, `kysely`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `kysely`, `pg`, `mysql2`, `better-sqlite3`, `testcontainers`

### @tslock/drizzle
- **Peer**: `@tslock/core`, `@tslock/sql-support`, `drizzle-orm`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `drizzle-orm`, `pg`, `mysql2`, `better-sqlite3`, `testcontainers`

## Exports

### @tslock/sql exports
- `SqlConnection`, `QueryResult` (interfaces)
- `PgConnection`, `Mysql2Connection`, `MssqlConnection` (classes)
- `SqlStorageAccessor` (class)
- `SqlLockProvider` (class)
- `translateToPositional`, `translateToNamed` (utility functions, exported for advanced use)

### @tslock/kysely exports
- `KyselyStorageAccessor` (class)
- `KyselyLockProvider` (class)
- `KyselyDialect` (type)
- `KyselyDialectInfo` (interface)

### @tslock/drizzle exports
- `DrizzleStorageAccessor` (class)
- `DrizzleLockProvider` (class)
- `DrizzleDialect` (type)
- `buildDrizzleQuery` (utility function, exported for advanced use)

## Non-Goals (for these packages)

- **No schema management.** Users create the `shedlock` table themselves. No DDL generation, no migrations.
- **No connection pooling.** Users configure their own driver pool and pass it to the connection adapter / Kysely / Drizzle instance.
- **No ORM-specific schema definitions.** The lock table is not defined as a Drizzle/Kysely schema object — it's referenced by name in raw SQL. Users do not need to define the table in their ORM schema.
- **No multi-database routing.** One provider instance uses one database. Users who need multiple databases create multiple provider instances.
- **No `useDbTime` auto-detection.** The user explicitly sets `useDbTime` in `SqlConfiguration`. The provider does not probe the DB for clock capabilities.
- **No Oracle/DB2/HSQL/H2 driver support in `@tslock/sql`.** Only `pg`, `mysql2`, `mssql` are supported. The server-time statement sources for Oracle/DB2/HSQL/H2 exist in `@tslock/sql-support` for completeness but are not wired to a raw driver adapter. Users on these databases should use `@tslock/kysely` or `@tslock/drizzle` if a dialect is available, or implement a custom `SqlConnection` adapter.
