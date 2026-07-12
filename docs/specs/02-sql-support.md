# Spec: @tslock/sql-support

## Overview

The `@tslock/sql-support` package provides the shared SQL infrastructure used by all three SQL provider packages (`@tslock/sql`, `@tslock/kysely`, `@tslock/drizzle`). It has zero driver dependencies — it depends only on `@tslock/core`. It defines the `DatabaseProduct` enum, `SqlConfiguration`, and `SqlStatementsSource` hierarchy that generates the SQL statements and parameter maps for lock operations.

This is a direct port of ShedLock's `shedlock-sql` module, adapted for TypeScript: abstract classes become concrete/abstract TS classes, Spring's `NamedParameterJdbcTemplate` param style (`:name`) is retained as the canonical param format, and the config is a concrete class taking a plain typed options object (no fluent builder).

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/sql-support` |
| **Dependencies** | `@tslock/core` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. DatabaseProduct

```typescript
enum DatabaseProduct {
  POSTGRES = 'POSTGRES',
  COCKROACH_DB = 'COCKROACH_DB',
  SQL_SERVER = 'SQL_SERVER',
  ORACLE = 'ORACLE',
  MYSQL = 'MYSQL',
  MARIA_DB = 'MARIA_DB',
  HSQL = 'HSQL',
  H2 = 'H2',
  DB2 = 'DB2',
  SQLITE = 'SQLITE',
  UNKNOWN = 'UNKNOWN',
}
```

`SQLITE` is a TSLock-specific addition (ShedLock does not support SQLite). It is needed for `@tslock/kysely` and `@tslock/drizzle`, both of which support SQLite.

```typescript
namespace DatabaseProduct {
  function matchProductName(productName: string): DatabaseProduct;
}
```

**`matchProductName`** maps a database product name string (e.g., from a connection metadata query or user config) to the enum. Matching is case-insensitive and substring-based:

| Pattern (case-insensitive) | Result |
|---|---|
| contains `"postgresql"` or `"postgres"` | `POSTGRES` |
| contains `"cockroach"` | `COCKROACH_DB` |
| contains `"microsoft sql server"` or `"sql server"` | `SQL_SERVER` |
| contains `"oracle"` | `ORACLE` |
| contains `"mariadb"` | `MARIA_DB` |
| contains `"mysql"` | `MYSQL` |
| contains `"hsql"` or `"hsqldb"` | `HSQL` |
| contains `"h2"` | `H2` |
| contains `"db2"` | `DB2` |
| contains `"sqlite"` | `SQLITE` |
| no match | `UNKNOWN` |

**Order matters:** `mariadb` is checked before `mysql` (MariaDB connections may report a name containing "mysql"). `cockroach` is checked before `postgres` (CockroachDB may report a Postgres-compatible name).

### 2. ColumnNames

```typescript
interface ColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}
```

Defaults: `{ name: 'name', lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy' }`.

### 3. SqlConfiguration

```typescript
interface SqlConfigurationOptions {
  databaseProduct: DatabaseProduct;
  tableName?: string;                 // default: DEFAULT_TABLE_NAME
  columnNames?: Partial<ColumnNames>; // default: see above
  lockedByValue?: string;             // default: Utils.getHostname()
  timeZone?: string;                  // IANA timezone, e.g. 'UTC', 'America/New_York'
  useDbTime?: boolean;                // default: false
}

class SqlConfiguration {
  static readonly DEFAULT_TABLE_NAME: string; // 'shedlock'

  readonly databaseProduct: DatabaseProduct;
  readonly tableName: string;
  readonly columnNames: ColumnNames;
  readonly lockedByValue: string;
  readonly timeZone?: string;
  readonly useDbTime: boolean;

  constructor(options: SqlConfigurationOptions);
}
```

**Constructor behavior:**
1. `databaseProduct` is required (no default).
2. `tableName` defaults to `DEFAULT_TABLE_NAME` (`'shedlock'`).
3. `columnNames` defaults are merged with user-provided overrides.
4. `lockedByValue` defaults to `Utils.getHostname()`.
5. `useDbTime` defaults to `false`.
6. **Uppercasing:** if `databaseProduct` is one of `ORACLE`, `DB2`, `HSQL` (databases that uppercase identifiers by default), `tableName` and all `columnNames` values are uppercased. This matches ShedLock's `dbUpperCase` logic.
7. **Validation:** if both `useDbTime` and `timeZone` are set, throw `LockException('Cannot set both useDbTime and timeZone')`. These are mutually exclusive: `useDbTime` uses the DB server's clock; `timeZone` converts the app's clock to a specific timezone for storage.

### 4. SqlStatements

```typescript
interface SqlStatements {
  readonly insert: string;
  readonly update: string;
  readonly extend: string;
  readonly unlock: string;
}
```

Each statement is a SQL string with `:name`-style named parameters (Spring NamedParameterJdbcTemplate convention). The canonical param names are: `name`, `lockUntil`, `now`, `lockedBy`, `unlockTime`.

### 5. SqlStatementsSource (abstract)

```typescript
abstract class SqlStatementsSource {
  static create(config: SqlConfiguration): SqlStatementsSource;

  abstract getInsertStatement(): string;
  abstract getUpdateStatement(): string;
  abstract getExtendStatement(): string;
  abstract getUnlockStatement(): string;

  params(lockConfig: LockConfiguration): Record<string, unknown>;

  protected readonly config: SqlConfiguration;
  protected constructor(config: SqlConfiguration);

  protected timestamp(epochMillis: number): Date;
}
```

#### 5.1 Factory: `create(config)`

```
if config.useDbTime:
    switch config.databaseProduct:
        POSTGRES, COCKROACH_DB → PostgresServerTimeStatementsSource
        SQL_SERVER             → MsSqlServerTimeStatementsSource
        MYSQL, MARIA_DB        → MySqlServerTimeStatementsSource
        ORACLE                 → OracleServerTimeStatementsSource
        HSQL                   → HsqlServerTimeStatementsSource
        H2                     → H2ServerTimeStatementsSource
        DB2                    → Db2ServerTimeStatementsSource
        SQLITE                 → SqliteServerTimeStatementsSource
        else                   → throw LockException('useDbTime not supported for ' + product)
else:
    if POSTGRES or COCKROACH_DB → PostgresSqlStatementsSource
    else                        → DefaultSqlStatementsSource
```

#### 5.2 `params(lockConfig)`

Returns a parameter map for the four SQL statements. The keys depend on whether `useDbTime` is active:

**Without `useDbTime` (app clock):**
```typescript
{
  name: lockConfig.name,
  lockUntil: timestamp(lockAtMostUntil(lockConfig)),  // Date
  now: timestamp(ClockProvider.now()),               // Date
  lockedBy: config.lockedByValue,
  unlockTime: timestamp(unlockTime(lockConfig)),       // Date
}
```

**With `useDbTime` (DB clock):**
```typescript
{
  name: lockConfig.name,
  lockUntil: timestamp(lockAtMostUntil(lockConfig)),  // Date
  lockedBy: config.lockedByValue,
  unlockTime: timestamp(unlockTime(lockConfig)),       // Date
}
```
The `now` key is omitted — the DB-native time function is embedded in the SQL.

#### 5.3 `timestamp(epochMillis)`

Returns a `Date` object. If `config.timeZone` is set, the `Date` is created via `Intl.DateTimeFormat` to represent the wall-clock time in that timezone, then converted back to a `Date` for the driver. If `timeZone` is not set, returns `new Date(epochMillis)` directly (UTC internally, driver handles conversion).

Most SQL drivers for Node.js accept `Date` objects and handle serialization to `TIMESTAMP` columns. The `timeZone` option is for the rare case where the app and DB operate in different timezones and the user wants the stored timestamp to reflect a specific timezone.

### 6. DefaultSqlStatementsSource

```typescript
class DefaultSqlStatementsSource extends SqlStatementsSource {
  constructor(config: SqlConfiguration);
  getInsertStatement(): string;
  getUpdateStatement(): string;
  getExtendStatement(): string;
  getUnlockStatement(): string;
}
```

Generates standard SQL statements using the table and column names from `config`. The INSERT is a plain `INSERT` — duplicate key errors are caught by the provider's accessor and translated to `false` (record already exists).

**Statements:**

```sql
-- INSERT
INSERT INTO {tableName}({col.name}, {col.lockUntil}, {col.lockedAt}, {col.lockedBy})
VALUES(:name, :lockUntil, :now, :lockedBy)

-- UPDATE
UPDATE {tableName}
SET {col.lockUntil}=:lockUntil, {col.lockedAt}=:now, {col.lockedBy}=:lockedBy
WHERE {col.name}=:name AND {col.lockUntil}<=:now

-- EXTEND
UPDATE {tableName}
SET {col.lockUntil}=:lockUntil
WHERE {col.name}=:name AND {col.lockedBy}=:lockedBy AND {col.lockUntil}>:now

-- UNLOCK
UPDATE {tableName}
SET {col.lockUntil}=:unlockTime
WHERE {col.name}=:name AND {col.lockedBy}=:lockedBy
```

### 7. PostgresSqlStatementsSource

```typescript
class PostgresSqlStatementsSource extends SqlStatementsSource {
  constructor(config: SqlConfiguration);
  getInsertStatement(): string;
  getUpdateStatement(): string;
  getExtendStatement(): string;
  getUnlockStatement(): string;
}
```

Same as `DefaultSqlStatementsSource` except the INSERT uses `ON CONFLICT ({name}) DO NOTHING`:

```sql
-- INSERT (Postgres)
INSERT INTO {tableName}({col.name}, {col.lockUntil}, {col.lockedAt}, {col.lockedBy})
VALUES(:name, :lockUntil, :now, :lockedBy)
ON CONFLICT ({col.name}) DO NOTHING
```

This avoids throwing on duplicate key — instead, 0 rows are affected, which the accessor interprets as "record already exists." Used for both `POSTGRES` and `COCKROACH_DB` (wire-compatible).

UPDATE, EXTEND, UNLOCK are identical to `DefaultSqlStatementsSource`.

### 8. ServerTimeStatementsSource (abstract)

```typescript
abstract class ServerTimeStatementsSource extends SqlStatementsSource {
  protected constructor(config: SqlConfiguration);
  protected abstract nowExpression(): string;

  getInsertStatement(): string;
  getUpdateStatement(): string;
  getExtendStatement(): string;
  getUnlockStatement(): string;

  params(lockConfig: LockConfiguration): Record<string, unknown>;
}
```

Base class for all `useDbTime` statement sources. Replaces `:now` in the SQL with the DB-native time function returned by `nowExpression()`. The `params()` method omits the `now` key (no app-clock timestamp is sent).

The INSERT uses `ON CONFLICT DO NOTHING` for PostgreSQL/CockroachDB, `INSERT OR IGNORE` for SQLite, and a plain INSERT (relying on duplicate-key catch) for other databases — each subclass overrides `getInsertStatement()` as needed.

**Statements (base, with `{nowExpr}` = `nowExpression()`):**

```sql
-- INSERT
INSERT INTO {tableName}({col.name}, {col.lockUntil}, {col.lockedAt}, {col.lockedBy})
VALUES(:name, :lockUntil, {nowExpr}, :lockedBy)

-- UPDATE
UPDATE {tableName}
SET {col.lockUntil}=:lockUntil, {col.lockedAt}={nowExpr}, {col.lockedBy}=:lockedBy
WHERE {col.name}=:name AND {col.lockUntil}<={nowExpr}

-- EXTEND
UPDATE {tableName}
SET {col.lockUntil}=:lockUntil
WHERE {col.name}=:name AND {col.lockedBy}=:lockedBy AND {col.lockUntil}>{nowExpr}

-- UNLOCK (same as default — no now reference)
UPDATE {tableName}
SET {col.lockUntil}=:unlockTime
WHERE {col.name}=:name AND {col.lockedBy}=:lockedBy
```

### 9. DB-Specific ServerTime Statement Sources

Each extends `ServerTimeStatementsSource` and provides `nowExpression()`:

| Class | DatabaseProduct(s) | `nowExpression()` | Insert variant |
|---|---|---|---|
| `PostgresServerTimeStatementsSource` | `POSTGRES`, `COCKROACH_DB` | `now()` | `ON CONFLICT ({name}) DO NOTHING` |
| `MsSqlServerTimeStatementsSource` | `SQL_SERVER` | `GETUTCDATE()` | plain INSERT |
| `MySqlServerTimeStatementsSource` | `MYSQL`, `MARIA_DB` | `UTC_TIMESTAMP(3)` | plain INSERT |
| `OracleServerTimeStatementsSource` | `ORACLE` | `CURRENT_TIMESTAMP` | plain INSERT |
| `HsqlServerTimeStatementsSource` | `HSQL` | `CURRENT_TIMESTAMP` | plain INSERT |
| `H2ServerTimeStatementsSource` | `H2` | `CURRENT_TIMESTAMP` | plain INSERT |
| `Db2ServerTimeStatementsSource` | `DB2` | `CURRENT TIMESTAMP` | plain INSERT |
| `SqliteServerTimeStatementsSource` | `SQLITE` | `CURRENT_TIMESTAMP` | `INSERT OR IGNORE` |

All extend `ServerTimeStatementsSource`. The `nowExpression()` string is embedded directly into the SQL at the position where `:now` would appear.

`SqliteServerTimeStatementsSource` overrides `getInsertStatement()` to use `INSERT OR IGNORE INTO` instead of a plain INSERT (SQLite's equivalent of `ON CONFLICT DO NOTHING`).

### 10. SqlParamNames (utility)

```typescript
const SQL_PARAM_NAMES: {
  readonly NAME: 'name';
  readonly LOCK_UNTIL: 'lockUntil';
  readonly NOW: 'now';
  readonly LOCKED_BY: 'lockedBy';
  readonly UNLOCK_TIME: 'unlockTime';
};
```

Constants for the canonical param names, used by providers when extracting values from the `params()` map.

## SQL Statement Templates (Reference)

All statements use `:name`-style named parameters. `{tableName}` and `{col.*}` are interpolated at statement-source construction time from `SqlConfiguration`.

| Operation | SQL |
|---|---|
| **INSERT (default)** | `INSERT INTO {t}({n}, {lu}, {la}, {lb}) VALUES(:name, :lockUntil, :now, :lockedBy)` |
| **INSERT (Postgres)** | `INSERT INTO {t}({n}, {lu}, {la}, {lb}) VALUES(:name, :lockUntil, :now, :lockedBy) ON CONFLICT ({n}) DO NOTHING` |
| **INSERT (SQLite)** | `INSERT OR IGNORE INTO {t}({n}, {lu}, {la}, {lb}) VALUES(:name, :lockUntil, :now, :lockedBy)` |
| **UPDATE** | `UPDATE {t} SET {lu}=:lockUntil, {la}=:now, {lb}=:lockedBy WHERE {n}=:name AND {lu}<=:now` |
| **EXTEND** | `UPDATE {t} SET {lu}=:lockUntil WHERE {n}=:name AND {lb}=:lockedBy AND {lu}>:now` |
| **UNLOCK** | `UPDATE {t} SET {lu}=:unlockTime WHERE {n}=:name AND {lb}=:lockedBy` |

Where `{t}` = tableName, `{n}` = columnNames.name, `{lu}` = columnNames.lockUntil, `{la}` = columnNames.lockedAt, `{lb}` = columnNames.lockedBy.

For `useDbTime`, `:now` is replaced with the DB-native `nowExpression()` in INSERT and UPDATE statements. EXTEND also uses the `nowExpression()`. UNLOCK does not reference `now` (it uses `:unlockTime`).

## Required DDL

Users must create the lock table before using any SQL provider. The table name and column names match the `SqlConfiguration` (defaults shown).

### PostgreSQL / CockroachDB

```sql
CREATE TABLE shedlock (
    name       VARCHAR(64)  NOT NULL,
    lock_until TIMESTAMP    NOT NULL,
    locked_at  TIMESTAMP    NOT NULL,
    locked_by  VARCHAR(255) NOT NULL,
    PRIMARY KEY (name)
);
```

### MySQL / MariaDB

```sql
CREATE TABLE shedlock (
    name       VARCHAR(64)  NOT NULL,
    lock_until TIMESTAMP(3) NOT NULL,
    locked_at  TIMESTAMP(3) NOT NULL,
    locked_by  VARCHAR(255) NOT NULL,
    PRIMARY KEY (name)
);
```

### SQL Server

```sql
CREATE TABLE shedlock (
    name       NVARCHAR(64)  NOT NULL,
    lock_until DATETIME2(3)  NOT NULL,
    locked_at  DATETIME2(3)  NOT NULL,
    locked_by  NVARCHAR(255) NOT NULL,
    PRIMARY KEY (name)
);
```

### SQLite

```sql
CREATE TABLE shedlock (
    name       TEXT NOT NULL,
    lock_until TEXT NOT NULL,
    locked_at  TEXT NOT NULL,
    locked_by  TEXT NOT NULL,
    PRIMARY KEY (name)
);
```

### Oracle / DB2 / HSQL / H2

```sql
-- Column names uppercased by dbUpperCase logic
CREATE TABLE SHEDLOCK (
    NAME       VARCHAR(64)  NOT NULL,
    LOCK_UNTIL TIMESTAMP    NOT NULL,
    LOCKED_AT  TIMESTAMP    NOT NULL,
    LOCKED_BY  VARCHAR(255) NOT NULL,
    PRIMARY KEY (NAME)
);
```

TSLock does not create the table automatically — users are responsible for schema management (matching ShedLock's behavior).

## File Structure

```
packages/sql-support/
├── src/
│   ├── index.ts                              # public exports
│   ├── database-product.ts                   # DatabaseProduct enum + matchProductName
│   ├── sql-configuration.ts                  # SqlConfiguration, ColumnNames, SqlConfigurationOptions
│   ├── sql-statements.ts                     # SqlStatements interface, SQL_PARAM_NAMES
│   ├── sql-statements-source.ts              # SqlStatementsSource abstract + create() factory
│   ├── default-sql-statements-source.ts      # DefaultSqlStatementsSource
│   ├── postgres-sql-statements-source.ts     # PostgresSqlStatementsSource
│   ├── server-time-statements-source.ts      # ServerTimeStatementsSource abstract
│   ├── server-time/
│   │   ├── postgres-server-time.ts           # PostgresServerTimeStatementsSource
│   │   ├── mssql-server-time.ts              # MsSqlServerTimeStatementsSource
│   │   ├── mysql-server-time.ts             # MySqlServerTimeStatementsSource
│   │   ├── oracle-server-time.ts            # OracleServerTimeStatementsSource
│   │   ├── hsql-server-time.ts              # HsqlServerTimeStatementsSource
│   │   ├── h2-server-time.ts               # H2ServerTimeStatementsSource
│   │   ├── db2-server-time.ts              # Db2ServerTimeStatementsSource
│   │   └── sqlite-server-time.ts           # SqliteServerTimeStatementsSource
│   └── timestamp.ts                         # timestamp() helper with timeZone support
├── __tests__/
│   ├── database-product.test.ts
│   ├── sql-configuration.test.ts
│   ├── sql-statements-source.test.ts
│   ├── default-sql-statements-source.test.ts
│   ├── postgres-sql-statements-source.test.ts
│   └── server-time-statements-source.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| `matchProductName` receives unrecognized string | Return `DatabaseProduct.UNKNOWN` |
| `SqlConfiguration` constructed with both `useDbTime` and `timeZone` | Throw `LockException('Cannot set both useDbTime and timeZone')` |
| `SqlStatementsSource.create()` with `useDbTime` and unsupported product (e.g., `UNKNOWN`) | Throw `LockException('useDbTime not supported for ' + product)` |
| `timestamp()` with invalid timezone string | Throw `RangeError` from `Intl.DateTimeFormat` (propagate) |
| Missing `databaseProduct` in `SqlConfigurationOptions` | TypeScript compile error (required field) |

## Dependencies

- **Peer**: `@tslock/core` (uses `LockConfiguration`, `lockAtMostUntil`, `unlockTime`, `ClockProvider`, `Utils`, `LockException`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`

## Exports

All types, classes, and functions listed in the Public API section are exported from `src/index.ts`:

- `DatabaseProduct` (enum + `matchProductName`)
- `ColumnNames` (interface)
- `SqlConfigurationOptions` (interface)
- `SqlConfiguration` (class)
- `SqlStatements` (interface)
- `SQL_PARAM_NAMES` (constant)
- `SqlStatementsSource` (abstract class)
- `DefaultSqlStatementsSource` (class)
- `PostgresSqlStatementsSource` (class)
- `ServerTimeStatementsSource` (abstract class)
- `PostgresServerTimeStatementsSource`, `MsSqlServerTimeStatementsSource`, `MySqlServerTimeStatementsSource`, `OracleServerTimeStatementsSource`, `HsqlServerTimeStatementsSource`, `H2ServerTimeStatementsSource`, `Db2ServerTimeStatementsSource`, `SqliteServerTimeStatementsSource` (classes)

## Non-Goals (for this package)

- **No driver dependencies.** This package never imports `pg`, `mysql2`, `mssql`, `kysely`, or `drizzle-orm`. It only produces SQL strings and parameter maps.
- **No SQL execution.** Statements are generated as strings; execution is the provider package's job.
- **No schema management.** Users create the lock table themselves. No DDL generation or migration support.
- **No parameter translation.** The `:name` param style is canonical. Each provider translates to its driver's native style.
- **No connection management.** No pooling, no connection strings, no driver configuration.
