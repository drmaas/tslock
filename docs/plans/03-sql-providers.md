# Implementation Plan: @tslock/sql, @tslock/kysely, @tslock/drizzle

## Overview

Build the three SQL provider packages. All three share `@tslock/sql-support` for SQL statement generation and `@tslock/core` for the `StorageBasedLockProvider` / `StorageAccessor` infrastructure. The work is mostly mechanical: param translation, query execution, and error detection per driver/dialect.

**Build order:** `@tslock/sql` first (raw adapters, most explicit), then `@tslock/kysely` (reuses param translation patterns), then `@tslock/drizzle` (most complex query building).

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/sql-support` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contracts)
- Docker installed (for Testcontainers integration tests)
- `tsconfig.base.json` at repo root

---

## Part 1: @tslock/sql

### Step 1: Initialize package

```
packages/sql/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts  (placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/sql",
  "version": "1.0.0",
  "description": "TSLock SQL provider for raw Node.js drivers (pg, mysql2, mssql)",
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
    "test:unit": "vitest run __tests__/unit",
    "test:integration": "vitest run __tests__/integration",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "@tslock/sql-support": "workspace:*",
    "pg": "^8.0.0",
    "mysql2": "^3.0.0",
    "mssql": "^10.0.0"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false },
    "@tslock/sql-support": { "optional": false },
    "pg": { "optional": true },
    "mysql2": { "optional": true },
    "mssql": { "optional": true }
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^22.0.0",
    "pg": "^8.0.0",
    "mysql2": "^3.0.0",
    "mssql": "^10.0.0",
    "@types/pg": "^8.0.0",
    "testcontainers": "^10.0.0"
  }
}
```

All three drivers are optional peer deps — the user installs only the one they need. All three are dev deps for integration testing.

### Step 2: Implement SqlConnection interface

**File:** `src/sql-connection.ts`

```typescript
export interface QueryResult {
  readonly affectedRows: number;
}

export interface SqlConnection {
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
  isDuplicateKeyError(error: unknown): boolean;
  getDatabaseProduct(): DatabaseProduct;
}
```

Import `DatabaseProduct` from `@tslock/sql-support`.

### Step 3: Implement param translator

**File:** `src/param-translator.ts`

Two functions:
- `translateToPositional(sql: string, params: Record<string, unknown>, placeholder: (index: number) => string): { sql: string; values: unknown[] }`
  - Scans SQL for `:name` patterns (regex `/:(\w+)/g`)
  - Replaces each with `placeholder(counter++)` — e.g., for pg: `(i) => '$' + i`
  - Collects values in order of first appearance
  - If a `:name` is not in `params`, throws `LockException('Missing param: ' + name)`
- `translateToNamed(sql: string, params: Record<string, unknown>, prefix: string): { sql: string; params: Record<string, unknown> }`
  - Replaces `:name` with `prefix + name` (e.g., `@name` for mssql)
  - Returns the same params object (mssql accepts named params object)
  - Validates all `:name` references exist in `params`

**Implementation detail:** A `:name` appearing multiple times in the SQL should reuse the same positional index (pg/mysql2) or the same named param (mssql). Track seen names in a `Map<string, number>` for positional, or a `Set<string>` for named.

**Self-check:**
```typescript
const { sql, values } = translateToPositional(
  'INSERT INTO t(n) VALUES(:name)',
  { name: 'foo' },
  (i) => '$' + i,
);
assert(sql === 'INSERT INTO t(n) VALUES($1)');
assert(values.length === 1 && values[0] === 'foo');

const { sql: namedSql } = translateToNamed(
  'WHERE n=:name AND lb=:lockedBy',
  { name: 'foo', lockedBy: 'host1' },
  '@',
);
assert(namedSql === 'WHERE n=@name AND lb=@lockedBy');
```

### Step 4: Implement PgConnection

**File:** `src/connections/pg-connection.ts`

```typescript
import type { Pool } from 'pg';
import { DatabaseProduct } from '@tslock/sql-support';
import { SqlConnection, QueryResult } from '../sql-connection';
import { translateToPositional } from '../param-translator';

export class PgConnection implements SqlConnection {
  constructor(private readonly pool: Pool) {}

  getDatabaseProduct(): DatabaseProduct {
    return DatabaseProduct.POSTGRES;
  }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: pgSql, values } = translateToPositional(sql, params, (i) => '$' + i);
    const result = await this.pool.query(pgSql, values);
    return { affectedRows: result.rowCount ?? 0 };
  }

  isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      ((error as { code?: string }).code === '23505');
  }
}
```

**Note:** `Pool` is imported as a type only (`import type`) to avoid a hard runtime dependency on `pg`. The actual `pg` module is a peer dep — the user's code provides the `Pool` instance. This means the `import type` is erased at build time; the runtime import happens only when the user instantiates `PgConnection`.

### Step 5: Implement Mysql2Connection

**File:** `src/connections/mysql2-connection.ts`

```typescript
import type { Pool } from 'mysql2/promise';
import { DatabaseProduct } from '@tslock/sql-support';
import { SqlConnection, QueryResult } from '../sql-connection';
import { translateToPositional } from '../param-translator';

export class Mysql2Connection implements SqlConnection {
  private readonly databaseProduct: DatabaseProduct.MYSQL | DatabaseProduct.MARIA_DB;

  constructor(pool: Pool) {
    this.databaseProduct = DatabaseProduct.MYSQL;
    // Detect MariaDB asynchronously — query server version on first use or at construction
    // For simplicity, detect lazily in getDatabaseProduct() via a cached query
    this.pool = pool;
  }

  // Lazy detection: query SELECT VERSION() on first call, cache result
  private detectedProduct?: DatabaseProduct;
  private pool: Pool;

  async getDatabaseProduct(): Promise<DatabaseProduct> {
    if (this.detectedProduct) return this.detectedProduct;
    const [rows] = await this.pool.query('SELECT VERSION() AS version');
    const version = (rows[0] as { version: string }).version;
    this.detectedProduct = version.toLowerCase().includes('mariadb')
      ? DatabaseProduct.MARIA_DB
      : DatabaseProduct.MYSQL;
    return this.detectedProduct;
  }
  // ... query() and isDuplicateKeyError()
}
```

**Design issue:** `getDatabaseProduct()` in the `SqlConnection` interface returns `DatabaseProduct` synchronously, but MySQL/MariaDB detection requires a query. Two options:
1. Make `getDatabaseProduct()` async — change the interface.
2. Detect at construction time (pass the product or detect in constructor).

**Decision:** Detect at construction. The user passes the `DatabaseProduct` explicitly via `SqlConfiguration` in most cases. For auto-detection, `Mysql2Connection` constructor queries `SELECT VERSION()` and caches. Since the constructor can't be async, provide a static factory:

```typescript
class Mysql2Connection implements SqlConnection {
  private constructor(private readonly pool: Pool, private readonly product: DatabaseProduct) {}

  static async create(pool: Pool): Promise<Mysql2Connection> {
    const [rows] = await pool.query('SELECT VERSION() AS version');
    const version = (rows[0] as { version: string }).version;
    const product = version.toLowerCase().includes('mariadb')
      ? DatabaseProduct.MARIA_DB
      : DatabaseProduct.MYSQL;
    return new Mysql2Connection(pool, product);
  }

  // sync getDatabaseProduct()
  getDatabaseProduct(): DatabaseProduct { return this.product; }
  // ... query(), isDuplicateKeyError()
}
```

Alternatively, keep the constructor sync and let the user specify the product:
```typescript
new Mysql2Connection(pool, DatabaseProduct.MYSQL)  // or MARIA_DB
```

**Final decision:** Provide both: constructor accepts an optional `product` param (defaults to `MYSQL`). If not provided, the user can call `Mysql2Connection.detect(pool)` async factory. This keeps the simple case simple and the auto-detect case explicit.

**Duplicate key:** `error.errno === 1062` (check `error.errno` or `error.code === 'ER_DUP_ENTRY'`).

### Step 6: Implement MssqlConnection

**File:** `src/connections/mssql-connection.ts`

```typescript
import type { ConnectionPool } from 'mssql';
import { DatabaseProduct } from '@tslock/sql-support';
import { SqlConnection, QueryResult } from '../sql-connection';
import { translateToNamed } from '../param-translator';

export class MssqlConnection implements SqlConnection {
  constructor(private readonly pool: ConnectionPool) {}

  getDatabaseProduct(): DatabaseProduct { return DatabaseProduct.SQL_SERVER; }

  async query(sql: string, params: Record<string, unknown>): Promise<QueryResult> {
    const { sql: mssqlSql, params: namedParams } = translateToNamed(sql, params, '@');
    const request = this.pool.request();
    for (const [name, value] of Object.entries(namedParams)) {
      request.input(name, value);
    }
    const result = await request.query(mssqlSql);
    return { affectedRows: result.rowsAffected[0] ?? 0 };
  }

  isDuplicateKeyError(error: unknown): boolean {
    return typeof error === 'object' && error !== null &&
      ((error as { number?: number }).number === 2627 ||
       (error as { number?: number }).number === 2601);
  }
}
```

**Param style:** `mssql` supports `@name` named params natively. The `translateToNamed` function converts `:name` to `@name`, and `request.input(name, value)` binds each param.

**Note:** `mssql`'s `rowsAffected` is an array (one element per statement). For single-statement queries, `rowsAffected[0]` is the affected count.

### Step 7: Implement SqlStorageAccessor

**File:** `src/sql-storage-accessor.ts`

```typescript
import { AbstractStorageAccessor, LockConfiguration } from '@tslock/core';
import { SqlStatementsSource } from '@tslock/sql-support';
import { SqlConnection } from './sql-connection';

export class SqlStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly connection: SqlConnection,
    private readonly statementsSource: SqlStatementsSource,
  ) { super(); }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
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

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const sql = this.statementsSource.getUpdateStatement();
    const params = this.statementsSource.params(config);
    const result = await this.connection.query(sql, params);
    return result.affectedRows > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const sql = this.statementsSource.getUnlockStatement();
    const params = this.statementsSource.params(config);
    await this.connection.query(sql, params);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const sql = this.statementsSource.getExtendStatement();
    const params = this.statementsSource.params(config);
    const result = await this.connection.query(sql, params);
    return result.affectedRows > 0;
  }
}
```

`AbstractStorageAccessor` from `@tslock/core` provides `getHostname()` via `Utils`. The accessor doesn't use it directly (lockedByValue comes from `SqlConfiguration`), but extends it for interface compliance.

### Step 8: Implement SqlLockProvider

**File:** `src/sql-lock-provider.ts`

```typescript
import { StorageBasedLockProvider } from '@tslock/core';
import { SqlConfiguration, SqlStatementsSource } from '@tslock/sql-support';
import { SqlConnection } from './sql-connection';
import { SqlStorageAccessor } from './sql-storage-accessor';

export class SqlLockProvider extends StorageBasedLockProvider {
  constructor(connection: SqlConnection, config: SqlConfiguration) {
    const statementsSource = SqlStatementsSource.create(config);
    const accessor = new SqlStorageAccessor(connection, statementsSource);
    super(accessor);
  }
}
```

### Step 9: Wire index.ts

Export: `SqlConnection`, `QueryResult`, `PgConnection`, `Mysql2Connection`, `MssqlConnection`, `SqlStorageAccessor`, `SqlLockProvider`, `translateToPositional`, `translateToNamed`.

### Step 10: Write unit tests

**`param-translator.test.ts`:**
- `translateToPositional` with `:name` → `$1`, values collected in order
- Multiple `:name` occurrences → same `$N` reused
- Missing param → throws `LockException`
- `translateToNamed` with `:name` → `@name`, params preserved
- No params in SQL → empty values array

**`pg-connection.test.ts`:** (mock `pg.Pool`)
- `query()` calls `pool.query(pgSql, values)` with translated SQL
- `affectedRows` from `result.rowCount`
- `isDuplicateKeyError` true for `code: '23505'`, false for other codes
- `getDatabaseProduct()` returns POSTGRES

**`mysql2-connection.test.ts`:** (mock `mysql2/promise.Pool`)
- `query()` calls `pool.query(mysqlSql, values)` with `?` params
- `affectedRows` from `result.affectedRows` (mysql2 returns `[result, fields]`)
- `isDuplicateKeyError` true for `errno: 1062`
- `getDatabaseProduct()` returns MYSQL or MARIA_DB based on VERSION()

**`mssql-connection.test.ts`:** (mock `mssql.ConnectionPool`)
- `query()` calls `request.input(name, value).query(mssqlSql)` with `@name` params
- `affectedRows` from `result.rowsAffected[0]`
- `isDuplicateKeyError` true for `number: 2627` and `2601`

**`sql-storage-accessor.test.ts`:** (mock `SqlConnection`)
- `insertRecord`: returns `true` when `affectedRows > 0`, `false` on duplicate key
- `insertRecord`: rethrows non-duplicate-key errors
- `updateRecord`: returns `true`/`false` based on `affectedRows`
- `unlock`: calls `query()`, returns void
- `extend`: returns `true`/`false` based on `affectedRows`
- Verify correct SQL statement and params are passed to `connection.query()` for each method

### Step 11: Write integration tests

**File:** `__tests__/integration/postgres.integration.test.ts`

```typescript
import { PostgreSqlContainer } from 'testcontainers';
import { Pool } from 'pg';
import { SqlLockProvider } from '../../src';
import { SqlConfiguration, DatabaseProduct } from '@tslock/sql-support';
import { storageBasedLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';

describe('SqlLockProvider (PostgreSQL)', () => {
  let container, pool, provider;

  beforeAll(async () => {
    container = await new PostgreSqlContainer().start();
    pool = new Pool({ connectionString: container.getConnectionUrl() });
    await pool.query(`CREATE TABLE shedlock (name VARCHAR(64) NOT NULL, lock_until TIMESTAMP NOT NULL, locked_at TIMESTAMP NOT NULL, locked_by VARCHAR(255) NOT NULL, PRIMARY KEY (name))`);
    provider = new SqlLockProvider(
      new PgConnection(pool),
      new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }),
    );
  });

  afterAll(async () => {
    await pool?.end();
    await container?.stop();
  });

  storageBasedLockProviderIntegrationTests(async () => provider, { timeMode: 'real' });
  fuzzTests(async () => provider);
});
```

Similar files for MySQL and SQL Server, with appropriate DDL and container types (`MySqlContainer`, `MsSqlContainer` from `testcontainers`).

Integration tests run the shared `storageBasedLockProviderIntegrationTests` contract from `@tslock/test-support` — all tests pass against a real database.

### Step 12: Verify

```bash
cd packages/sql
pnpm typecheck
pnpm test:unit
pnpm test:integration  # requires Docker
pnpm build
```

---

## Part 2: @tslock/kysely

### Step 1: Initialize package

```
packages/kysely/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts
```

**`package.json`:** similar to `@tslock/sql`, but peer deps are `@tslock/core`, `@tslock/sql-support`, `kysely`. Dev deps include `kysely`, `pg`, `mysql2`, `better-sqlite3`, `testcontainers`.

### Step 2: Implement dialect info

**File:** `src/dialect-info.ts`

```typescript
export type KyselyDialect = 'postgresql' | 'mysql' | 'sqlite';

export interface KyselyDialectInfo {
  dialect: KyselyDialect;
  isDuplicateKeyError(error: unknown): boolean;
  translateParams(sql: string, params: Record<string, unknown>): { sql: string; values: unknown[] };
}

const DIALECT_INFOS: Record<KyselyDialect, KyselyDialectInfo> = {
  postgresql: {
    dialect: 'postgresql',
    isDuplicateKeyError: (e) => (e as { code?: string })?.code === '23505',
    translateParams: (sql, params) => translateToPositional(sql, params, (i) => '$' + i),
  },
  mysql: {
    dialect: 'mysql',
    isDuplicateKeyError: (e) => (e as { errno?: number })?.errno === 1062,
    translateParams: (sql, params) => translateToPositional(sql, params, () => '?'),
  },
  sqlite: {
    dialect: 'sqlite',
    isDuplicateKeyError: (e) => {
      const msg = (e as Error)?.message ?? '';
      return msg.includes('UNIQUE constraint failed');
    },
    translateParams: (sql, params) => translateToPositional(sql, params, () => '?'),
  },
};

export function getDialectInfo(dialect: KyselyDialect): KyselyDialectInfo {
  return DIALECT_INFOS[dialect];
}
```

**Note:** `translateToPositional` is the same function as in `@tslock/sql`. Rather than duplicating, either:
1. Export it from `@tslock/sql-support` (add a `param-utils.ts` to sql-support — it has no driver dep, just string manipulation), OR
2. Duplicate the ~20 lines in `@tslock/kysely`.

**Decision:** Add `translateToPositional` and `translateToNamed` to `@tslock/sql-support` as utility functions. They are pure string manipulation with no driver dependency. This avoids duplication across all three SQL packages. Update `@tslock/sql-support` spec/plan to export these. (If `@tslock/sql-support` is already built, add these as a minor addition.)

### Step 3: Implement KyselyStorageAccessor

**File:** `src/kysely-storage-accessor.ts`

```typescript
import { Kysely, sql, CompiledQuery } from 'kysely';
import { AbstractStorageAccessor, LockConfiguration } from '@tslock/core';
import { SqlStatementsSource } from '@tslock/sql-support';
import { KyselyDialectInfo } from './dialect-info';

export class KyselyStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly statementsSource: SqlStatementsSource,
    private readonly dialectInfo: KyselyDialectInfo,
  ) { super(); }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const rawSql = this.statementsSource.getInsertStatement();
    const params = this.statementsSource.params(config);
    const { sql: translatedSql, values } = this.dialectInfo.translateParams(rawSql, params);
    try {
      const compiled = sql.raw(translatedSql, values).compile(this.db);
      const result = await this.db.executeQuery(compiled);
      return this.numAffectedRows(result) > 0;
    } catch (e) {
      if (this.dialectInfo.isDuplicateKeyError(e)) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const rawSql = this.statementsSource.getUpdateStatement();
    const params = this.statementsSource.params(config);
    const { sql: translatedSql, values } = this.dialectInfo.translateParams(rawSql, params);
    const compiled = sql.raw(translatedSql, values).compile(this.db);
    const result = await this.db.executeQuery(compiled);
    return this.numAffectedRows(result) > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const rawSql = this.statementsSource.getUnlockStatement();
    const params = this.statementsSource.params(config);
    const { sql: translatedSql, values } = this.dialectInfo.translateParams(rawSql, params);
    const compiled = sql.raw(translatedSql, values).compile(this.db);
    await this.db.executeQuery(compiled);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const rawSql = this.statementsSource.getExtendStatement();
    const params = this.statementsSource.params(config);
    const { sql: translatedSql, values } = this.dialectInfo.translateParams(rawSql, params);
    const compiled = sql.raw(translatedSql, values).compile(this.db);
    const result = await this.db.executeQuery(compiled);
    return this.numAffectedRows(result) > 0;
  }

  private numAffectedRows(result: unknown): number {
    // Kysely's QueryResult.numAffectedRows is bigint | undefined for pg/mysql
    const r = result as { numAffectedRows?: bigint | number };
    if (r?.numAffectedRows === undefined) return 0;
    return typeof r.numAffectedRows === 'bigint'
      ? Number(r.numAffectedRows)
      : r.numAffectedRows;
  }
}
```

**Key point:** `sql.raw(translatedSql, values).compile(this.db)` compiles a raw SQL string with positional parameters into a Kysely `CompiledQuery`. The `db.executeQuery()` runs it. This is Kysely's escape hatch for raw SQL — it doesn't go through the query builder but still uses Kysely's connection management and dialect-aware serialization.

### Step 4: Implement KyselyLockProvider

**File:** `src/kysely-lock-provider.ts`

```typescript
import { Kysely } from 'kysely';
import { StorageBasedLockProvider } from '@tslock/core';
import { SqlConfiguration, SqlStatementsSource } from '@tslock/sql-support';
import { KyselyStorageAccessor } from './kysely-storage-accessor';
import { KyselyDialect, getDialectInfo } from './dialect-info';

export class KyselyLockProvider extends StorageBasedLockProvider {
  constructor(db: Kysely<unknown>, config: SqlConfiguration, dialect: KyselyDialect) {
    const statementsSource = SqlStatementsSource.create(config);
    const dialectInfo = getDialectInfo(dialect);
    const accessor = new KyselyStorageAccessor(db, statementsSource, dialectInfo);
    super(accessor);
  }
}
```

### Step 5: Wire index.ts

Export: `KyselyStorageAccessor`, `KyselyLockProvider`, `KyselyDialect`, `KyselyDialectInfo`, `getDialectInfo`.

### Step 6: Write unit tests

**`dialect-info.test.ts`:**
- Each dialect's `isDuplicateKeyError` detects the right error
- Each dialect's `translateParams` produces the right placeholder style
- `getDialectInfo('postgresql')` → postgres info, etc.

**`kysely-storage-accessor.test.ts`:** (mock `Kysely` — use a mock object with `executeQuery`)
- `insertRecord`: compiles raw SQL, calls `executeQuery`, returns boolean
- `insertRecord`: duplicate key → false
- `updateRecord`, `unlock`, `extend`: correct SQL/params, correct boolean
- `numAffectedRows`: handles `bigint` and `number`

### Step 7: Write integration tests

Three integration test files using Testcontainers:
- `postgres.integration.test.ts` — `PostgreSqlContainer` + Kysely `PostgresDialect`
- `mysql.integration.test.ts` — `MySqlContainer` + Kysely `MysqlDialect`
- `sqlite.integration.test.ts` — no container needed (in-memory SQLite via `better-sqlite3`)

Each runs `storageBasedLockProviderIntegrationTests` and `fuzzTests` from `@tslock/test-support`.

### Step 8: Verify

```bash
cd packages/kysely
pnpm typecheck
pnpm test:unit
pnpm test:integration  # Docker for pg/mysql; no container for sqlite
pnpm build
```

---

## Part 3: @tslock/drizzle

### Step 1: Initialize package

```
packages/drizzle/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts
```

**`package.json`:** peer deps `@tslock/core`, `@tslock/sql-support`, `drizzle-orm`. Dev deps include `drizzle-orm`, `pg`, `mysql2`, `better-sqlite3`, `@types/better-sqlite3`, `testcontainers`.

### Step 2: Implement dialect info

**File:** `src/dialect-info.ts`

```typescript
export type DrizzleDialect = 'postgresql' | 'mysql' | 'sqlite';

export interface DrizzleDialectInfo {
  dialect: DrizzleDialect;
  isDuplicateKeyError(error: unknown): boolean;
  execute(db: DrizzleDatabase, query: import('drizzle-orm').SQL): Promise<unknown>;
  getAffectedRows(result: unknown): number;
}

const DIALECT_INFOS: Record<DrizzleDialect, DrizzleDialectInfo> = {
  postgresql: {
    dialect: 'postgresql',
    isDuplicateKeyError: (e) => (e as { code?: string })?.code === '23505',
    execute: async (db, query) => db.execute(query),
    getAffectedRows: (r) => (r as { rowsAffected?: number })?.rowsAffected ?? 0,
  },
  mysql: {
    dialect: 'mysql',
    isDuplicateKeyError: (e) => (e as { errno?: number })?.errno === 1062,
    execute: async (db, query) => db.execute(query),
    getAffectedRows: (r) => {
      const result = (r as [{ affectedRows?: number }])?.[0];
      return result?.affectedRows ?? 0;
    },
  },
  sqlite: {
    dialect: 'sqlite',
    isDuplicateKeyError: (e) => {
      const msg = (e as Error)?.message ?? '';
      return msg.includes('UNIQUE constraint failed');
    },
    execute: async (db, query) => db.run(query),
    getAffectedRows: (r) => (r as { changes?: number })?.changes ?? 0,
  },
};

export function getDialectInfo(dialect: DrizzleDialect): DrizzleDialectInfo {
  return DIALECT_INFOS[dialect];
}
```

**`DrizzleDatabase` type:** union of Drizzle's database types. Since Drizzle's `db.execute()` and `db.run()` have different signatures per dialect, the `execute` function in `DrizzleDialectInfo` abstracts the dispatch.

### Step 3: Implement query builder

**File:** `src/query-builder.ts`

```typescript
import { sql, SQL } from 'drizzle-orm';

export function buildDrizzleQuery(
  rawSql: string,
  params: Record<string, unknown>,
): SQL {
  const segments = rawSql.split(/:(\w+)/);
  const chunks: SQL[] = [];
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

**How it works:** `sql.raw(str)` embeds raw SQL text (no escaping). `sql.param(value)` creates a parameterized value node. `sql.join(chunks, separator)` concatenates SQL chunks. The result is a `SQL` object that Drizzle can execute via `db.execute()` or `db.run()`.

**Self-check:**
```typescript
const query = buildDrizzleQuery(
  'INSERT INTO t(n) VALUES(:name)',
  { name: 'foo' },
);
// query is a SQL object that, when executed, produces:
// INSERT INTO t(n) VALUES($1)  -- or ? for mysql/sqlite
// with param 'foo' bound
```

### Step 4: Implement DrizzleStorageAccessor

**File:** `src/drizzle-storage-accessor.ts`

```typescript
import { AbstractStorageAccessor, LockConfiguration } from '@tslock/core';
import { SqlStatementsSource } from '@tslock/sql-support';
import { DrizzleDatabase, DrizzleDialectInfo } from './dialect-info';
import { buildDrizzleQuery } from './query-builder';

export class DrizzleStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly db: DrizzleDatabase,
    private readonly statementsSource: SqlStatementsSource,
    private readonly dialectInfo: DrizzleDialectInfo,
  ) { super(); }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const rawSql = this.statementsSource.getInsertStatement();
    const params = this.statementsSource.params(config);
    const query = buildDrizzleQuery(rawSql, params);
    try {
      const result = await this.dialectInfo.execute(this.db, query);
      return this.dialectInfo.getAffectedRows(result) > 0;
    } catch (e) {
      if (this.dialectInfo.isDuplicateKeyError(e)) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const rawSql = this.statementsSource.getUpdateStatement();
    const params = this.statementsSource.params(config);
    const query = buildDrizzleQuery(rawSql, params);
    const result = await this.dialectInfo.execute(this.db, query);
    return this.dialectInfo.getAffectedRows(result) > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const rawSql = this.statementsSource.getUnlockStatement();
    const params = this.statementsSource.params(config);
    const query = buildDrizzleQuery(rawSql, params);
    await this.dialectInfo.execute(this.db, query);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const rawSql = this.statementsSource.getExtendStatement();
    const params = this.statementsSource.params(config);
    const query = buildDrizzleQuery(rawSql, params);
    const result = await this.dialectInfo.execute(this.db, query);
    return this.dialectInfo.getAffectedRows(result) > 0;
  }
}
```

### Step 5: Implement DrizzleLockProvider

**File:** `src/drizzle-lock-provider.ts`

```typescript
import { StorageBasedLockProvider } from '@tslock/core';
import { SqlConfiguration, SqlStatementsSource } from '@tslock/sql-support';
import { DrizzleStorageAccessor } from './drizzle-storage-accessor';
import { DrizzleDatabase, DrizzleDialect, getDialectInfo } from './dialect-info';

export class DrizzleLockProvider extends StorageBasedLockProvider {
  constructor(db: DrizzleDatabase, config: SqlConfiguration, dialect: DrizzleDialect) {
    const statementsSource = SqlStatementsSource.create(config);
    const dialectInfo = getDialectInfo(dialect);
    const accessor = new DrizzleStorageAccessor(db, statementsSource, dialectInfo);
    super(accessor);
  }
}
```

### Step 6: Wire index.ts

Export: `DrizzleStorageAccessor`, `DrizzleLockProvider`, `DrizzleDialect`, `DrizzleDialectInfo`, `getDialectInfo`, `buildDrizzleQuery`.

### Step 7: Write unit tests

**`query-builder.test.ts`:**
- `buildDrizzleQuery` with single `:name` → SQL object with param node
- Multiple `:name` occurrences → both replaced with param nodes
- No params in SQL → only raw SQL chunks
- Missing param → `sql.param(undefined)` (Drizzle will error at execution — acceptable, or validate and throw)

**`dialect-info.test.ts`:**
- Each dialect's `isDuplicateKeyError` detects the right error
- `getDialectInfo` returns correct info per dialect

**`drizzle-storage-accessor.test.ts`:** (mock Drizzle `db`)
- `insertRecord`: builds query, calls `execute`/`run`, returns boolean
- `insertRecord`: duplicate key → false
- `updateRecord`, `unlock`, `extend`: correct query/params, correct boolean
- `getAffectedRows` per dialect: pg `rowsAffected`, mysql `[0].affectedRows`, sqlite `changes`

### Step 8: Write integration tests

Three integration test files:
- `postgres.integration.test.ts` — `PostgreSqlContainer` + Drizzle `drizzle()` from `drizzle-orm/node-postgres`
- `mysql.integration.test.ts` — `MySqlContainer` + Drizzle `drizzle()` from `drizzle-orm/mysql2`
- `sqlite.integration.test.ts` — in-memory `better-sqlite3` + Drizzle `drizzle()` from `drizzle-orm/better-sqlite3`

Each runs `storageBasedLockProviderIntegrationTests` and `fuzzTests`.

### Step 9: Verify

```bash
cd packages/drizzle
pnpm typecheck
pnpm test:unit
pnpm test:integration
pnpm build
```

---

## Shared Test Approach

### Unit tests (no Docker)
- Mock driver clients (`pg.Pool`, `mysql2/promise.Pool`, `mssql.ConnectionPool`, `Kysely`, Drizzle `db`)
- Verify: param translation, SQL/params passed to driver, affectedRows extraction, duplicate key detection
- Fast, run on every commit

### Integration tests (Docker via Testcontainers)
- Use `testcontainers` npm package to spin up real PostgreSQL, MySQL, SQL Server
- SQLite: in-memory `better-sqlite3` (no container)
- Run `storageBasedLockProviderIntegrationTests` + `fuzzTests` from `@tslock/test-support`
- Verify: all shared contract tests pass against real databases
- Slower, run in CI or manually (`pnpm test:integration`)

### Integration test DDL
Each integration test creates the `shedlock` table before running tests:
```sql
-- PostgreSQL
CREATE TABLE shedlock (name VARCHAR(64) NOT NULL, lock_until TIMESTAMP NOT NULL, locked_at TIMESTAMP NOT NULL, locked_by VARCHAR(255) NOT NULL, PRIMARY KEY (name));
-- MySQL
CREATE TABLE shedlock (name VARCHAR(64) NOT NULL, lock_until TIMESTAMP(3) NOT NULL, locked_at TIMESTAMP(3) NOT NULL, locked_by VARCHAR(255) NOT NULL, PRIMARY KEY (name));
-- SQL Server
CREATE TABLE shedlock (name NVARCHAR(64) NOT NULL, lock_until DATETIME2(3) NOT NULL, locked_at DATETIME2(3) NOT NULL, locked_by NVARCHAR(255) NOT NULL, PRIMARY KEY (name));
-- SQLite
CREATE TABLE shedlock (name TEXT NOT NULL, lock_until TEXT NOT NULL, locked_at TEXT NOT NULL, locked_by TEXT NOT NULL, PRIMARY KEY (name));
```

### useDbTime integration test
Additional test per provider: configure with `useDbTime: true`, run `lockProviderIntegrationTests`, verify behavior matches app-clock mode. Tests that the `now()` function substitution works correctly.

---

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `pg`'s `rowCount` is `null` for some statements | Use `?? 0` fallback. Unit test covers null case. |
| `mysql2` returns `[result, fields]` tuple — easy to forget destructuring | Unit tests verify correct destructuring. |
| `mssql` `rowsAffected` is an array (one per statement) | Use `rowsAffected[0]` for single-statement queries. Unit test covers. |
| Kysely `numAffectedRows` is `bigint` | Convert via `Number()`. Document potential precision loss for very large counts (not realistic for lock tables). |
| Drizzle result shapes differ by dialect | `DrizzleDialectInfo` abstracts per-dialect `execute()` and `getAffectedRows()`. Unit tests cover each. |
| Drizzle `sql.raw()` + `sql.param()` composition | Unit test `buildDrizzleQuery` with all SQL statement templates. Verify generated SQL matches expected pattern. |
| MariaDB vs MySQL detection in `mysql2` | Static factory `Mysql2Connection.detect(pool)` or user-specified product. Document both paths. |
| SQLite `UNIQUE constraint failed` error detection is message-based (not code-based) | Accept — SQLite's Node.js drivers don't use numeric error codes consistently. Document this. |
| `useDbTime` server-time functions not tested against real Oracle/DB2/HSQL/H2 | These are unit-tested (string generation) only. `@tslock/sql` only ships adapters for pg/mysql2/mssql. Document that Oracle/DB2/HSQL/H2 server-time sources are provided for completeness/manual use. |
| Peer dep not installed — runtime import fails | Use `import type` for driver types (erased at build). The actual driver module is only imported when the user instantiates the adapter (they provide the pool/connection). The error occurs at the user's `import` site, not in TSLock code. |
| Testcontainers flakiness in CI | Use `testcontainers` retry options. Mark integration tests as a separate suite (`pnpm test:integration`) that CI runs separately from unit tests. |

## Estimation

| Package | Source files | Implementation (lines) | Tests (lines) | Effort |
|---|---|---|---|---|
| `@tslock/sql` | ~7 | ~300-400 | ~500-700 | 1 session |
| `@tslock/kysely` | ~5 | ~200-300 | ~400-500 | 0.5 session (reuses patterns from sql) |
| `@tslock/drizzle` | ~5 | ~250-350 | ~400-500 | 0.5-1 session (query builder is new) |
| **Total** | ~17 | ~750-1050 | ~1300-1700 | ~2-3 sessions |

## Order of Implementation

1. **@tslock/sql-support param utilities** — add `translateToPositional`, `translateToNamed` to `@tslock/sql-support` (shared by all three providers). Update `@tslock/sql-support` package if not already done.

2. **@tslock/sql** (most explicit, establishes patterns):
   1. `sql-connection.ts` (interface)
   2. `param-translator.ts` (or import from sql-support)
   3. `pg-connection.ts` → unit test
   4. `mysql2-connection.ts` → unit test
   5. `mssql-connection.ts` → unit test
   6. `sql-storage-accessor.ts` → unit test
   7. `sql-lock-provider.ts`
   8. `index.ts`
   9. Integration tests (pg, mysql, mssql)
   10. Verify

3. **@tslock/kysely** (reuses param translation):
   1. `dialect-info.ts` → unit test
   2. `kysely-storage-accessor.ts` → unit test
   3. `kysely-lock-provider.ts`
   4. `index.ts`
   5. Integration tests (pg, mysql, sqlite)
   6. Verify

4. **@tslock/drizzle** (new query building pattern):
   1. `dialect-info.ts` → unit test
   2. `query-builder.ts` → unit test
   3. `drizzle-storage-accessor.ts` → unit test
   4. `drizzle-lock-provider.ts`
   5. `index.ts`
   6. Integration tests (pg, mysql, sqlite)
   7. Verify

5. **Cross-provider integration verification**: run all three providers' integration tests against PostgreSQL. All three should pass `storageBasedLockProviderIntegrationTests` — this confirms behavioral parity across raw/Kysely/Drizzle for the same database.
