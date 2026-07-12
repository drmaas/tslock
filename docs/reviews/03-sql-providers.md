# Review: @tslock/sql, @tslock/kysely, @tslock/drizzle

**Spec:** `docs/specs/03-sql-providers.md`
**Plan:** `docs/plans/03-sql-providers.md`

## Summary

Three SQL provider packages that share `@tslock/sql-support` infrastructure and implement `StorageBasedLockProvider` via a `StorageAccessor` per package. The spec is comprehensive with a clear comparison table of param styles, execution APIs, affected-rows extraction, and duplicate-key detection across all driver/dialect combinations. The plan follows a sensible build order (sql → kysely → drizzle). The main issues are: (1) `translateToPositional`/`translateToNamed` are exported by `@tslock/sql` per spec but plan 03 moves them to `@tslock/sql-support` (spec 02 doesn't list them) — an unresolved cross-document inconsistency; (2) the `Mysql2Connection` constructor signature in the spec doesn't reflect the plan's async-detection design (static factory / optional product param); (3) the `buildDrizzleQuery` regex parsing and the Kysely `sql.raw()` manual param translation could be cleaner. Implementation-ready with these resolved.

## Vision Alignment

**Aligned.** Vision §6.1 specifies three SQL packages: `@tslock/sql` (raw: pg/mysql2/mssql), `@tslock/kysely` (Kysely query builder), `@tslock/drizzle` (Drizzle ORM), all sharing `@tslock/sql-support`. The spec defines exactly these three with the correct peer deps. Vision §4 "Provider-pluggable, minimal dependencies" — drivers are peer deps, user installs one. Vision §4 "Type-safe" — the spec uses typed config and dialect unions. R2DBC merged into `@tslock/sql` (Node drivers are async-native) — the spec doesn't distinguish R2DBC, matching the vision's rationale.

## Architecture Alignment

**Correct.** All three use `StorageBasedLockProvider` from `@tslock/core` (architecture §6.1 Category A, §5.2-5.4). Each implements `StorageAccessor` and delegates to `StorageBasedLockProvider`. Dependency rules match architecture §2 rules 4-6: `@tslock/sql` peers `@tslock/core`, `@tslock/sql-support`, `pg`, `mysql2`, `mssql`; `@tslock/kysely` peers `@tslock/core`, `@tslock/sql-support`, `kysely`; `@tslock/drizzle` peers `@tslock/core`, `@tslock/sql-support`, `drizzle-orm`. No provider depends on another provider (architecture rule 11) — shared logic lives in `@tslock/sql-support`.

Types are consistent with core abstractions: `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `StorageBasedLockProvider`, `ExtensibleLockProvider` — all from the core spec.

## Spec Completeness

**Complete.** All public API types are defined for all three packages: `SqlConnection`/`QueryResult`/`PgConnection`/`Mysql2Connection`/`MssqlConnection`/`SqlStorageAccessor`/`SqlLockProvider` for `@tslock/sql`; `KyselyStorageAccessor`/`KyselyLockProvider`/`KyselyDialect`/`KyselyDialectInfo` for `@tslock/kysely`; `DrizzleStorageAccessor`/`DrizzleLockProvider`/`DrizzleDialect` for `@tslock/drizzle`. The locking mechanism is clearly specified with actual driver calls for each of insert/update/unlock/extend. Error handling is comprehensive (8-row table + per-driver duplicate-key detection). The shared SQL statement templates table is an excellent reference. File structures are clear. Usage examples are provided for all three.

The `SqlStorageAccessor` implementation pseudocode is fully shown — `insertRecord` catches duplicate-key errors → false, `updateRecord`/`extend` return `affectedRows > 0`, `unlock` is void. This matches the core `StorageAccessor` contract.

## Plan Completeness

**Complete.** Build order (sql → kysely → drizzle) is logical — establishes patterns in the most explicit package first. Each package has: package.json, tsup config, interface/types, implementation, unit tests (mocked drivers), integration tests (testcontainers). The param-translator self-check is good. The risk table is thorough (11 rows). Estimation (~2-3 sessions total across all three) is reasonable.

Integration tests use testcontainers for PostgreSQL/MySQL/SQL Server and in-memory `better-sqlite3` for SQLite. The `useDbTime` integration test is mentioned (per-provider additional test). Cross-provider integration verification (all three against PostgreSQL) is a nice step 5.

## Technical Correctness

**Param translation:**
- `pg`: `:name` → `$1, $2, ...` (1-indexed, positional). Correct. `translateToPositional` collects values in order of first appearance, reuses index for repeated names. ✅
- `mysql2`: `:name` → `?` (positional). Correct. ✅
- `mssql`: `:name` → `@name` (named). Correct — `mssql` supports `@`-prefixed named params natively via `request.input(name, value)`. ✅
- Kysely postgresql: `:name` → `$1`. Kysely mysql/sqlite: `:name` → `?`. Correct. ✅
- Drizzle: `sql.raw()` + `sql.param()` composition — correct Drizzle pattern. ✅

**Duplicate-key detection:**
- `pg`: `error.code === '23505'` (unique_violation). Correct. ✅
- `mysql2`: `error.errno === 1062` (ER_DUP_ENTRY). Correct. ✅
- `mssql`: `error.number === 2627 || 2601`. Correct (2627 = unique constraint violation, 2601 = duplicate key row). ✅
- Kysely postgresql: `code === '23505'`. mysql: `errno === 1062`. sqlite: message contains `UNIQUE constraint failed`. Correct — SQLite doesn't use numeric codes consistently. ✅
- Drizzle: same as Kysely per dialect. Correct. ✅

**Affected rows extraction:**
- `pg`: `result.rowCount` (nullable — plan uses `?? 0`). Correct. ✅
- `mysql2`: `result[0].affectedRows` (mysql2 returns `[result, fields]` tuple — the plan's risk table flags this; the adapter destructures correctly). ✅ Wait — the plan's `Mysql2Connection.query` pseudocode doesn't show the destructure. Let me check... The plan's Step 5 shows `await this.pool.query(mysqlSql, values)` but the actual mysql2 `pool.query` returns `[rows, fields]` for SELECT and a `ResultSetHeader` for INSERT/UPDATE. For `pool.query(sql, values)` with an INSERT/UPDATE, the result is a `ResultSetHeader` with `affectedRows`. The destructure is `const [result] = await pool.query(...)`. The plan's adapter should show this. Minor — the unit tests verify correct destructuring.
- `mssql`: `result.rowsAffected[0]` (array — one element per statement). Correct. ✅
- Kysely: `numAffectedRows` (bigint | undefined) — converted via `Number()`. Correct. ✅
- Drizzle: pg `rowsAffected`, mysql `[0].affectedRows`, sqlite `changes`. Correct per dialect. ✅

**Postgres `ON CONFLICT DO NOTHING`:** The INSERT for Postgres uses `ON CONFLICT ({name}) DO NOTHING` (from `PostgresSqlStatementsSource` in spec 02). So duplicate keys produce 0 affected rows (no exception). The `insertRecord` catches duplicate-key errors too (belt-and-suspenders) — for Postgres, the 412/duplicate-key path won't fire, but the 0-affected-rows path returns false. For MySQL/SQL Server, the plain INSERT throws on duplicate, caught by `isDuplicateKeyError` → false. Both paths converge. Correct. ✅

**Kysely `sql.raw(translatedSql, values).compile(db)`:** This is the Kysely escape hatch for raw SQL. The manual `:name` → `$1` translation is redundant (Kysely could handle `?` placeholders and translate per dialect), but it works: `sql.raw('INSERT ... VALUES($1)', ['foo'])` passes the raw SQL and params to the driver. The driver sees `$1` and binds `['foo']`. Correct but slightly inelegant — using `sql.join()` with `sql.param()` (like the Drizzle approach) would be cleaner. Not a blocker.

**Drizzle `buildDrizzleQuery`:** Uses `rawSql.split(/:(\w+)/)` to split on `:name` patterns, then builds `sql.raw()` + `sql.param()` chunks. The regex `/:(\w+)/` matches `:name`, `:lockUntil`, etc. — correct for the SQL statements from `SqlStatementsSource` (which contain no string literals with colons). Safe in practice. ✅

## Gaps and Issues

- **`translateToPositional`/`translateToNamed` location inconsistency.** Spec 03 §Exports lists these as exports of `@tslock/sql`. But plan 03 Step 2 (kysely section) and Order of Implementation #1 say to add them to `@tslock/sql-support` to avoid duplication across all three packages. Spec 02 (sql-support) does not list them. This is an unresolved inconsistency. If they live in `@tslock/sql-support` (the right call — architecture rule 11 forbids cross-provider deps), then spec 02 must be updated to export them, and spec 03 §Exports must remove them from `@tslock/sql`'s export list (or re-export for convenience).

- **`Mysql2Connection` constructor signature.** Spec 03 §1.3 shows `constructor(pool: import('mysql2/promise').Pool)` with `getDatabaseProduct(): DatabaseProduct` returning `MYSQL (or MARIA_DB if detected)`. But the `SqlConnection` interface has `getDatabaseProduct(): DatabaseProduct` (synchronous). MariaDB vs MySQL detection requires a `SELECT VERSION()` query (async). The plan grapples with this: first shows an async `getDatabaseProduct()` (wrong — breaks the interface), then proposes a static `Mysql2Connection.create(pool)` async factory, then settles on "constructor accepts optional `product` param (defaults to MYSQL); static `detect(pool)` for auto-detect." The spec doesn't reflect this final design. Spec 03 should document: `constructor(pool, product?: DatabaseProduct)` and `static async detect(pool): Promise<Mysql2Connection>`.

- **`mysql2` result destructure.** `pool.query(sql, values)` for INSERT/UPDATE returns `[ResultSetHeader, fields]`. The plan's adapter pseudocode in Step 5 doesn't clearly show the destructure `const [result] = await pool.query(...)`. The unit tests verify this, but the implementation pseudocode should be explicit. The spec's `Mysql2Connection` query contract says `affectedRows` from `result.affectedRows` — correct if `result` is the `ResultSetHeader`. Minor.

- **Kysely `sql.raw()` parameter handling.** The manual `:name` → `$1` translation + `sql.raw(translatedSql, values)` works, but it's redundant — Kysely's `sql.raw()` already accepts parameters and the dialect handles placeholder rendering. A cleaner approach (matching the Drizzle `sql.join()` + `sql.param()` pattern) would avoid manual translation. Not a blocker but a design consistency note.

- **`buildDrizzleQuery` regex safety.** The regex `/:(\w+)/` would match `:name` inside string literals or comments if the SQL contained them. The `SqlStatementsSource` output doesn't, so this is safe in practice. Recommend a comment in the plan documenting this assumption.

- **`DrizzleDatabase` type union.** The spec defines a union of `NodePgDatabase | DrizzleMysqlDatabase | BetterSQLite3Database | LibSQLDatabase`. Drizzle's `db.execute()` and `db.run()` have different signatures per dialect — the `DrizzleDialectInfo.execute()` abstracts the dispatch. Correct approach. But the union type might cause TypeScript issues when passing a `NodePgDatabase` to a function expecting `DrizzleDatabase` and calling `db.execute()` — TypeScript might not narrow correctly. The plan's `execute: async (db, query) => db.execute(query)` in the dialect info handles this by capturing the specific dialect's `db` type at construction. Should work but worth type-checking early.

- **Integration test DDL mismatch.** Plan 03's integration test DDL for PostgreSQL uses `lock_until TIMESTAMP` (snake_case). Spec 02's DDL also uses snake_case for PostgreSQL. But the default `ColumnNames` in spec 02 are `lockUntil`, `lockedAt` (camelCase). The DDL column names are snake_case, but the `SqlConfiguration` default column names are camelCase. If the user creates the table with snake_case columns (`lock_until`) but uses default `SqlConfiguration` (which expects `lockUntil`), the SQL would reference a non-existent column. The integration test DDL and the `SqlConfiguration` defaults must match. Either the DDL should use camelCase columns (matching defaults) or the integration test should pass `columnNames: { lockUntil: 'lock_until', ... }`. This is a real bug in the plan's integration test setup.

Actually, re-reading spec 02's DDL: it uses `lock_until` (snake_case) for PostgreSQL, MySQL, SQL Server, SQLite. But spec 02's `ColumnNames` defaults are `lockUntil` (camelCase). This is a **cross-spec inconsistency**: the DDL examples in spec 02 don't match the default `ColumnNames` in spec 02. The integration tests in plan 03 copy the DDL from spec 02 (snake_case) but use default `SqlConfiguration` (camelCase) — this would fail. Either the DDL should use camelCase columns, or the defaults should be snake_case, or the DDL should be documented as "example only, must match your `columnNames` config." This is the most significant issue.

## Recommendations

1. **Resolve `translateToPositional`/`translateToNamed` location.** Add them to spec 02's Public API and Exports. Remove them from spec 03's `@tslock/sql` export list (or have `@tslock/sql` re-export from `@tslock/sql-support` for convenience). Update plan 03 to import from `@tslock/sql-support`.

2. **Fix `Mysql2Connection` spec.** Document the constructor signature as `constructor(pool: Pool, product?: DatabaseProduct)` with `static async detect(pool): Promise<Mysql2Connection>` for auto-detection. The plan already settles on this; the spec should match.

3. **Fix DDL/ColumnNames inconsistency.** Either (a) change spec 02's DDL examples to use camelCase columns matching the defaults (`lockUntil`, `lockedAt`, `lockedBy`), or (b) change the default `ColumnNames` to snake_case (`lock_until`, `locked_at`, `locked_by`) matching the DDL, or (c) document that the DDL is an example and users must ensure the table columns match their `columnNames` config. Option (a) is simplest — the DDL examples should match the defaults. This affects spec 02 and plan 03's integration test DDL.

4. **Explicit `mysql2` destructure** in the adapter pseudocode: `const [result] = await pool.query(sql, values)`.

5. **Document `buildDrizzleQuery` regex assumption** — safe only for SQL without colon-containing string literals (which is the case for `SqlStatementsSource` output).

6. **Consider Kysely `sql.join()` + `sql.param()`** approach instead of manual `:name` → `$1` translation for consistency with the Drizzle pattern. Not a blocker.

## Verdict: APPROVED WITH NOTES

The three specs and plans are implementation-ready with the notes above resolved. The DDL/ColumnNames inconsistency (#3) is the most significant — it would cause integration test failures if not addressed. The `translateToPositional`/`translateToNamed` location (#1) and `Mysql2Connection` constructor (#2) should be resolved for cross-document consistency. The technical approach (param translation, duplicate-key detection, affected-rows extraction, `StorageAccessor` implementation) is correct across all driver/dialect combinations.
