# Implementation Plan: @tslock/sql-support

## Overview

Build the `@tslock/sql-support` package — the shared SQL infrastructure used by `@tslock/sql`, `@tslock/kysely`, and `@tslock/drizzle`. This package has zero driver dependencies. It produces SQL statement strings and parameter maps from a `SqlConfiguration`. No SQL is executed here.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contract reuse, optional)
- `tsconfig.base.json` at repo root
- pnpm workspace initialized

## Steps

### Step 1: Initialize package structure

```
packages/sql-support/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts  (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/sql-support",
  "version": "1.0.0",
  "description": "Shared SQL infrastructure for TSLock SQL providers",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@tslock/core": "workspace:*"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false }
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^20.0.0"
  }
}
```

**`tsup.config.ts`:** same as core (entry `src/index.ts`, formats `esm` + `cjs`, dts, clean, sourcemap).

### Step 2: Implement DatabaseProduct

**File:** `src/database-product.ts`

- `enum DatabaseProduct` with 11 values (POSTGRES, COCKROACH_DB, SQL_SERVER, ORACLE, MYSQL, MARIA_DB, HSQL, H2, DB2, SQLITE, UNKNOWN)
- `matchProductName(name: string): DatabaseProduct`:
  - Convert to lowercase
  - Check in order (matters for overlapping names):
    1. `includes('cockroach')` → COCKROACH_DB
    2. `includes('mariadb')` → MARIA_DB
    3. `includes('postgresql') || includes('postgres')` → POSTGRES
    4. `includes('microsoft sql server') || includes('sql server')` → SQL_SERVER
    5. `includes('oracle')` → ORACLE
    6. `includes('mysql')` → MYSQL
    7. `includes('hsqldb') || includes('hsql')` → HSQL
    8. `includes('h2')` → H2
    9. `includes('db2')` → DB2
    10. `includes('sqlite')` → SQLITE
    11. else → UNKNOWN
- Export as namespace `DatabaseProduct` with `matchProductName` function attached (or export enum + separate function — TS enum + function pattern)

**Self-check:**
```typescript
assert(DatabaseProduct.matchProductName('PostgreSQL') === DatabaseProduct.POSTGRES);
assert(DatabaseProduct.matchProductName('CockroachDB') === DatabaseProduct.COCKROACH_DB);
assert(DatabaseProduct.matchProductName('Microsoft SQL Server') === DatabaseProduct.SQL_SERVER);
assert(DatabaseProduct.matchProductName('MariaDB') === DatabaseProduct.MARIA_DB);
assert(DatabaseProduct.matchProductName('MySQL') === DatabaseProduct.MYSQL);
assert(DatabaseProduct.matchProductName('unknown db') === DatabaseProduct.UNKNOWN);
```

### Step 3: Implement ColumnNames + SqlConfiguration

**File:** `src/sql-configuration.ts`

- `interface ColumnNames { name, lockUntil, lockedAt, lockedBy }`
- `interface SqlConfigurationOptions { databaseProduct, tableName?, columnNames?, lockedByValue?, timeZone?, useDbTime? }`
- `class SqlConfiguration`:
  - `static readonly DEFAULT_TABLE_NAME = 'shedlock'`
  - Constructor:
    1. Store `databaseProduct` from options
    2. `tableName = options.tableName ?? DEFAULT_TABLE_NAME`
    3. Merge column names: `{ name: 'name', lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy', ...options.columnNames }`
    4. `lockedByValue = options.lockedByValue ?? Utils.getHostname()`
    5. `timeZone = options.timeZone` (undefined if not provided)
    6. `useDbTime = options.useDbTime ?? false`
    7. **Uppercase check:** `const dbUpperCase = [ORACLE, DB2, HSQL].includes(databaseProduct)`
       - If `dbUpperCase`: uppercase `tableName` and all `columnNames` values
    8. **Validation:** `if (useDbTime && timeZone) throw new LockException('Cannot set both useDbTime and timeZone')`
  - All fields are `readonly`

**Self-check:**
```typescript
const c1 = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
assert(c1.tableName === 'shedlock');
assert(c1.columnNames.name === 'name');
assert(c1.lockedByValue.length > 0);

const c2 = new SqlConfiguration({ databaseProduct: DatabaseProduct.ORACLE });
assert(c2.tableName === 'SHEDLOCK');
assert(c2.columnNames.name === 'NAME');

assertThrows(() => new SqlConfiguration({
  databaseProduct: DatabaseProduct.POSTGRES,
  useDbTime: true,
  timeZone: 'UTC',
}));
```

### Step 4: Implement SqlStatements + SQL_PARAM_NAMES

**File:** `src/sql-statements.ts`

- `interface SqlStatements { insert, update, extend, unlock }` — four `string` fields
- `const SQL_PARAM_NAMES = { NAME: 'name', LOCK_UNTIL: 'lockUntil', NOW: 'now', LOCKED_BY: 'lockedBy', UNLOCK_TIME: 'unlockTime' } as const`

### Step 5: Implement timestamp helper

**File:** `src/timestamp.ts`

- `function timestamp(epochMillis: number, timeZone?: string): Date`
  - If `!timeZone`: return `new Date(epochMillis)`
  - If `timeZone` is set:
    - Use `Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 })` to format the epoch millis in the target timezone
    - Parse the formatted string back to a `Date`
    - **Note:** This is an edge-case feature. Most deployments use UTC. The `timeZone` option is rarely needed and mainly exists for ShedLock parity. Keep the implementation simple — the goal is to produce a `Date` that, when serialized by the driver, stores the wall-clock time in the specified timezone.

### Step 6: Implement SqlStatementsSource (abstract)

**File:** `src/sql-statements-source.ts`

- `abstract class SqlStatementsSource`:
  - `protected readonly config: SqlConfiguration`
  - `protected constructor(config: SqlConfiguration)`
  - `static create(config: SqlConfiguration): SqlStatementsSource` — factory (see Step 7 for dispatch logic)
  - `abstract getInsertStatement(): string`
  - `abstract getUpdateStatement(): string`
  - `abstract getExtendStatement(): string`
  - `abstract getUnlockStatement(): string`
  - `params(lockConfig: LockConfiguration): Record<string, unknown>`:
    - Base implementation (app clock, `!useDbTime`):
      ```typescript
      return {
        name: lockConfig.name,
        lockUntil: timestamp(lockAtMostUntil(lockConfig), this.config.timeZone),
        now: timestamp(ClockProvider.now(), this.config.timeZone),
        lockedBy: this.config.lockedByValue,
        unlockTime: timestamp(unlockTime(lockConfig), this.config.timeZone),
      };
      ```
    - `ServerTimeStatementsSource` overrides to omit `now` key
  - `protected timestamp(epochMillis: number): Date` — delegates to `timestamp()` helper with `this.config.timeZone`

**Factory dispatch (`create`):**
```typescript
static create(config: SqlConfiguration): SqlStatementsSource {
  if (config.useDbTime) {
    switch (config.databaseProduct) {
      case DatabaseProduct.POSTGRES:
      case DatabaseProduct.COCKROACH_DB:
        return new PostgresServerTimeStatementsSource(config);
      case DatabaseProduct.SQL_SERVER:
        return new MsSqlServerTimeStatementsSource(config);
      case DatabaseProduct.MYSQL:
      case DatabaseProduct.MARIA_DB:
        return new MySqlServerTimeStatementsSource(config);
      case DatabaseProduct.ORACLE:
        return new OracleServerTimeStatementsSource(config);
      case DatabaseProduct.HSQL:
        return new HsqlServerTimeStatementsSource(config);
      case DatabaseProduct.H2:
        return new H2ServerTimeStatementsSource(config);
      case DatabaseProduct.DB2:
        return new Db2ServerTimeStatementsSource(config);
      case DatabaseProduct.SQLITE:
        return new SqliteServerTimeStatementsSource(config);
      default:
        throw new LockException(`useDbTime not supported for ${config.databaseProduct}`);
    }
  }
  if (config.databaseProduct === DatabaseProduct.POSTGRES ||
      config.databaseProduct === DatabaseProduct.COCKROACH_DB) {
    return new PostgresSqlStatementsSource(config);
  }
  return new DefaultSqlStatementsSource(config);
}
```

### Step 7: Implement DefaultSqlStatementsSource

**File:** `src/default-sql-statements-source.ts`

- `class DefaultSqlStatementsSource extends SqlStatementsSource`
- Constructor: `super(config)`
- Private helper to build statements from config table/column names
- `getInsertStatement()`: `INSERT INTO {tableName}({col.name}, {col.lockUntil}, {col.lockedAt}, {col.lockedBy}) VALUES(:name, :lockUntil, :now, :lockedBy)`
- `getUpdateStatement()`: `UPDATE {tableName} SET {col.lockUntil}=:lockUntil, {col.lockedAt}=:now, {col.lockedBy}=:lockedBy WHERE {col.name}=:name AND {col.lockUntil}<=:now`
- `getExtendStatement()`: `UPDATE {tableName} SET {col.lockUntil}=:lockUntil WHERE {col.name}=:name AND {col.lockedBy}=:lockedBy AND {col.lockUntil}>:now`
- `getUnlockStatement()`: `UPDATE {tableName} SET {col.lockUntil}=:unlockTime WHERE {col.name}=:name AND {col.lockedBy}=:lockedBy`
- Statements can be computed once in constructor and cached (they don't change)

### Step 8: Implement PostgresSqlStatementsSource

**File:** `src/postgres-sql-statements-source.ts`

- `class PostgresSqlStatementsSource extends SqlStatementsSource`
- Same as Default except `getInsertStatement()` appends ` ON CONFLICT ({col.name}) DO NOTHING`
- UPDATE, EXTEND, UNLOCK identical to Default (can share via a shared helper or just duplicate — small strings)
- Used for both POSTGRES and COCKROACH_DB

### Step 9: Implement ServerTimeStatementsSource (abstract)

**File:** `src/server-time-statements-source.ts`

- `abstract class ServerTimeStatementsSource extends SqlStatementsSource`
  - `protected abstract nowExpression(): string`
  - `getInsertStatement()`: INSERT with `{nowExpr}` replacing `:now`. For Postgres subclasses, includes `ON CONFLICT DO NOTHING`. For SQLite subclass, uses `INSERT OR IGNORE`. Default: plain INSERT.
  - `getUpdateStatement()`: UPDATE with `{nowExpr}` replacing `:now` in SET and WHERE
  - `getExtendStatement()`: UPDATE with `{nowExpr}` replacing `:now` in WHERE
  - `getUnlockStatement()`: same as Default (no `now` reference)
  - `params(lockConfig)`: override to omit `now` key:
    ```typescript
    return {
      name: lockConfig.name,
      lockUntil: timestamp(lockAtMostUntil(lockConfig), this.config.timeZone),
      lockedBy: this.config.lockedByValue,
      unlockTime: timestamp(unlockTime(lockConfig), this.config.timeZone),
    };
    ```

**Design note:** The base `ServerTimeStatementsSource` provides the INSERT/UPDATE/EXTEND/UNLOCK templates with `{nowExpr}` substitution. Subclasses provide `nowExpression()` and optionally override `getInsertStatement()` for dialect-specific INSERT variants. To avoid duplicating the template-building logic across 8 subclasses, the base class builds the statements from the config + `nowExpression()`. Subclasses that need a different INSERT (Postgres, SQLite) override `getInsertStatement()`.

### Step 10: Implement DB-specific server-time statement sources

**Files:** `src/server-time/*.ts`

Each file exports a class extending `ServerTimeStatementsSource`:

| File | Class | `nowExpression()` | Insert override |
|---|---|---|---|
| `postgres-server-time.ts` | `PostgresServerTimeStatementsSource` | `'now()'` | `ON CONFLICT ({col.name}) DO NOTHING` |
| `mssql-server-time.ts` | `MsSqlServerTimeStatementsSource` | `'GETUTCDATE()'` | none (base) |
| `mysql-server-time.ts` | `MySqlServerTimeStatementsSource` | `'UTC_TIMESTAMP(3)'` | none (base) |
| `oracle-server-time.ts` | `OracleServerTimeStatementsSource` | `'CURRENT_TIMESTAMP'` | none (base) |
| `hsql-server-time.ts` | `HsqlServerTimeStatementsSource` | `'CURRENT_TIMESTAMP'` | none (base) |
| `h2-server-time.ts` | `H2ServerTimeStatementsSource` | `'CURRENT_TIMESTAMP'` | none (base) |
| `db2-server-time.ts` | `Db2ServerTimeStatementsSource` | `'CURRENT TIMESTAMP'` | none (base) |
| `sqlite-server-time.ts` | `SqliteServerTimeStatementsSource` | `'CURRENT_TIMESTAMP'` | `INSERT OR IGNORE INTO` |

Each subclass:
1. `constructor(config) { super(config); }`
2. `protected nowExpression(): string { return '<expr>'; }`
3. (Postgres/SQLite only) override `getInsertStatement()` for the dialect-specific INSERT

### Step 11: Wire up index.ts

**File:** `src/index.ts`

Export:
- `DatabaseProduct`, `DatabaseProduct.matchProductName`
- `ColumnNames`, `SqlConfigurationOptions`, `SqlConfiguration`
- `SqlStatements`, `SQL_PARAM_NAMES`
- `SqlStatementsSource`
- `DefaultSqlStatementsSource`, `PostgresSqlStatementsSource`
- `ServerTimeStatementsSource`
- All 8 server-time classes

### Step 12: Write unit tests

All tests in `__tests__/` using Vitest.

**`database-product.test.ts`:**
- `matchProductName('PostgreSQL')` → POSTGRES
- `matchProductName('PostgreSQL 14.5')` → POSTGRES (substring match)
- `matchProductName('CockroachDB')` → COCKROACH_DB (checked before postgres)
- `matchProductName('MariaDB')` → MARIA_DB (checked before mysql)
- `matchProductName('Microsoft SQL Server')` → SQL_SERVER
- `matchProductName('MySQL')` → MYSQL
- `matchProductName('SQLite')` → SQLITE
- `matchProductName('Oracle')` → ORACLE
- `matchProductName('H2')` → H2
- `matchProductName('HSQL Database Engine')` → HSQL
- `matchProductName('DB2')` → DB2
- `matchProductName('unknown')` → UNKNOWN
- `matchProductName('')` → UNKNOWN
- Case-insensitive: `matchProductName('postgresql')`, `matchProductName('POSTGRESQL')`

**`sql-configuration.test.ts`:**
- Default values: `tableName === 'shedlock'`, column names match defaults, `lockedByValue` is hostname, `useDbTime === false`, `timeZone === undefined`
- Custom table name: `tableName === 'my_locks'`
- Custom column names (partial override): only provided keys overridden, rest are defaults
- Custom `lockedByValue`: stored as-is
- Uppercasing for ORACLE: table and column names uppercased
- Uppercasing for DB2: same
- Uppercasing for HSQL: same
- No uppercasing for POSTGRES, MYSQL, SQL_SERVER, H2, COCKROACH_DB
- Validation: `useDbTime: true` + `timeZone: 'UTC'` → throws `LockException`
- Validation: `useDbTime: true` alone → OK
- Validation: `timeZone: 'UTC'` alone → OK

**`sql-statements-source.test.ts`:**
- `create()` with `useDbTime: false` and POSTGRES → returns `PostgresSqlStatementsSource` instance
- `create()` with `useDbTime: false` and COCKROACH_DB → returns `PostgresSqlStatementsSource` instance
- `create()` with `useDbTime: false` and MYSQL → returns `DefaultSqlStatementsSource` instance
- `create()` with `useDbTime: false` and SQL_SERVER → returns `DefaultSqlStatementsSource` instance
- `create()` with `useDbTime: true` and POSTGRES → returns `PostgresServerTimeStatementsSource`
- `create()` with `useDbTime: true` and each product → returns correct server-time class
- `create()` with `useDbTime: true` and UNKNOWN → throws `LockException`
- `params()` without useDbTime: includes `name`, `lockUntil`, `now`, `lockedBy`, `unlockTime` keys; values are `Date` objects (except `name` and `lockedBy` which are strings)
- `params()` with useDbTime: omits `now` key

**`default-sql-statements-source.test.ts`:**
- INSERT contains `INSERT INTO shedlock(name, lockUntil, lockedAt, lockedBy) VALUES(:name, :lockUntil, :now, :lockedBy)`
- UPDATE contains `UPDATE shedlock SET lockUntil=:lockUntil, lockedAt=:now, lockedBy=:lockedBy WHERE name=:name AND lockUntil<=:now`
- EXTEND contains `UPDATE shedlock SET lockUntil=:lockUntil WHERE name=:name AND lockedBy=:lockedBy AND lockUntil>:now`
- UNLOCK contains `UPDATE shedlock SET lockUntil=:unlockTime WHERE name=:name AND lockedBy=:lockedBy`
- Custom table name appears in all statements
- Custom column names appear in all statements
- Uppercased names (Oracle config) appear in all statements

**`postgres-sql-statements-source.test.ts`:**
- INSERT ends with `ON CONFLICT (name) DO NOTHING`
- UPDATE, EXTEND, UNLOCK identical to Default

**`server-time-statements-source.test.ts`:**
- For each server-time class:
  - `nowExpression()` returns the correct DB function
  - INSERT contains the `nowExpression()` string instead of `:now`
  - UPDATE contains `nowExpression()` in SET and WHERE
  - EXTEND contains `nowExpression()` in WHERE
  - UNLOCK does NOT contain `nowExpression()` (uses `:unlockTime`)
  - `params()` does not include `now` key
- PostgresServerTimeStatementsSource: INSERT has `ON CONFLICT DO NOTHING`
- SqliteServerTimeStatementsSource: INSERT starts with `INSERT OR IGNORE INTO`
- MsSqlServerTimeStatementsSource: INSERT is plain (no ON CONFLICT)
- `timestamp()` with timeZone produces a Date (basic smoke test — full timezone correctness is hard to unit test, test that it doesn't throw and returns a Date)

### Step 13: Verify

```bash
cd packages/sql-support
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsup
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `matchProductName` ordering causes misidentification (CockroachDB → Postgres) | Check `cockroach` before `postgres`, `mariadb` before `mysql`. Unit tests cover all overlap cases. |
| `timestamp()` with timeZone produces incorrect Date | The `timeZone` feature is rarely used. Document it as best-effort. Most drivers accept `Date` objects and handle timezone via DB session settings. Unit test just verifies no crash + returns Date. |
| `ON CONFLICT DO NOTHING` not supported on older Postgres/Cockroach | `ON CONFLICT` is supported since Postgres 9.5 (2016) and all CockroachDB versions. Document minimum version. |
| SQL injection via table/column names | Table and column names come from `SqlConfiguration`, which the user controls. They are interpolated into SQL strings, not parameterized. Document that user-provided column names are not sanitized (matching ShedLock). This is a config-trust boundary, not user-input. |
| 8 server-time subclasses is repetitive | The base `ServerTimeStatementsSource` encapsulates all template logic. Subclasses only provide a `nowExpression()` string and optionally override INSERT. Minimal boilerplate. |
| Oracle/DB2/HSQL/H2 server-time sources are untested against real DBs | These are included for ShedLock parity. `@tslock/sql` only supports `pg`, `mysql2`, `mssql`. The Oracle/HSQL/H2/DB2 sources are unit-tested (string generation) but not integration-tested. Document that they are provided for completeness and manual use. |

## Estimation

~15 source files, ~500-700 lines of implementation + ~400-500 lines of tests. The code is mostly string generation and simple class hierarchies — no complex logic. Should take one focused session.

## Order of Implementation

1. `database-product.ts` (no deps) → self-check
2. `sql-configuration.ts` (depends on `@tslock/core` for `Utils`, `LockException`) → self-check
3. `sql-statements.ts` (no deps) → trivial
4. `timestamp.ts` (no deps) → trivial
5. `sql-statements-source.ts` abstract + `create()` factory (depends on all above + core `LockConfiguration`, `ClockProvider`, derived helpers) — but factory references classes not yet created, so stub the imports or implement after step 6-10
6. `default-sql-statements-source.ts` (depends on `SqlStatementsSource`)
7. `postgres-sql-statements-source.ts` (depends on `SqlStatementsSource`)
8. `server-time-statements-source.ts` (depends on `SqlStatementsSource`)
9. `server-time/*.ts` — 8 files (depend on `ServerTimeStatementsSource`)
10. `index.ts` (wire all exports)
11. Tests (after each module or all at end)

**Practical note:** Steps 5-9 have circular-ish dependencies (the factory in step 5 references classes from steps 6-9). Implement the concrete classes first (steps 6-9), then the factory dispatch in the abstract class (step 5), or use lazy imports / build incrementally. The simplest order: 1-4 (leaves), 6-9 (concrete sources), 5 (factory wiring), 10 (exports), 11 (tests).
