# Review: @tslock/sql-support

**Spec:** `docs/specs/02-sql-support.md`
**Plan:** `docs/plans/02-sql-support.md`

## Summary

The `@tslock/sql-support` package is the shared SQL infrastructure (zero driver deps) consumed by `@tslock/sql`, `@tslock/kysely`, and `@tslock/drizzle`. It produces SQL statement strings and parameter maps for lock insert/update/extend/unlock. The spec is thorough, well-structured, and technically sound. One cross-document inconsistency (plan 03 introduces `translateToPositional`/`translateToNamed` utilities that spec 02 does not list) and a thin `timestamp()`/timeZone spec are the main notes. Implementation-ready.

## Vision Alignment

**Aligned.** Vision §6.1 specifies `@tslock/sql-support` providing `DatabaseProduct`, `SqlConfiguration`, `SqlStatementsSource` — the spec defines exactly these. Vision §4 "Minimal dependencies" and "Provider-pluggable" are honored: the package depends only on `@tslock/core` (peer), zero driver deps. The `SQLITE` addition beyond ShedLock is correctly justified as needed for `@tslock/kysely` and `@tslock/drizzle` (both support SQLite). Framework-agnostic — pure SQL string generation.

## Architecture Alignment

**Correct.** Architecture §5.1 specifies the `DatabaseProduct` enum, `SqlConfiguration`, and `SqlStatementsSource` hierarchy. The spec implements exactly this structure. The `DatabaseProduct` enum in the spec includes `SQLITE` and `COCKROACH_DB` (architecture doc lists the same set without `SQLITE`; the spec adds it with rationale — consistent with architecture §5.4 which mentions Drizzle's SQLite support). Dependency rule "depends on `@tslock/core` only (zero driver deps)" is correctly enforced. Uses core types `LockConfiguration`, `lockAtMostUntil`, `unlockTime`, `ClockProvider`, `Utils`, `LockException` — all consistent with the core spec.

## Spec Completeness

**Complete.** All public API types are defined: `DatabaseProduct` (enum + `matchProductName`), `ColumnNames`, `SqlConfigurationOptions`, `SqlConfiguration`, `SqlStatements`, `SQL_PARAM_NAMES`, `SqlStatementsSource` (abstract), `DefaultSqlStatementsSource`, `PostgresSqlStatementsSource`, `ServerTimeStatementsSource` (abstract), and 8 server-time subclasses. The locking mechanism is clearly specified via SQL statement templates (INSERT/UPDATE/EXTEND/UNLOCK) with `:name`-style named params. Error handling is tabulated (5 scenarios). DDL is provided for PostgreSQL, MySQL, SQL Server, SQLite, and Oracle/DB2/HSQL/H2. File structure is clear.

The factory dispatch (`SqlStatementsSource.create()`) is fully specified for both `useDbTime` and non-`useDbTime` paths, including the `UNKNOWN` → throw case.

## Plan Completeness

**Complete.** 13 steps from scaffolding through verification. Steps are logically ordered with a practical note on circular dependencies (the factory in step 5 references classes from steps 6-9). Self-checks are embedded after key steps (DatabaseProduct, SqlConfiguration). Unit tests are comprehensive: `matchProductName` ordering, configuration defaults/uppercasing/validation, factory dispatch, and statement string assertions for each statement source. Risks are identified (6 rows). Estimation (~15 files, ~500-700 lines, one session) is reasonable — this is mostly string generation and simple class hierarchies.

No integration tests — appropriate for a package that produces strings only.

## Technical Correctness

**`matchProductName` ordering:** Correct. The spec and plan both check `mariadb` before `mysql` and `cockroach` before `postgres` — essential because MariaDB connections report names containing "mysql" and CockroachDB reports Postgres-compatible names. The plan's Step 2 lists the order explicitly: cockroach → mariadb → postgres → sql server → oracle → mysql → hsql → h2 → db2 → sqlite. Matches the spec table.

**SQL statements:** All four statements (INSERT/UPDATE/EXTEND/UNLOCK) are correct for the default source. The UPDATE `WHERE lockUntil <= :now` correctly acquires only if expired. The EXTEND `WHERE lockedBy = :lockedBy AND lockUntil > :now` correctly verifies ownership and validity. The UNLOCK `WHERE lockedBy = :lockedBy` is ownership-scoped but best-effort (no affected-rows check required). All match ShedLock's `DefaultSqlStatementsSource`.

**Postgres `ON CONFLICT ({name}) DO NOTHING`:** Correct for Postgres 9.5+ and all CockroachDB versions. This converts the duplicate-key error into a 0-affected-rows result, which the accessor interprets as "record already exists." Used for both POSTGRES and COCKROACH_DB (wire-compatible) — correct.

**Server-time `nowExpression()` values:**
- Postgres `now()` — correct.
- SQL Server `GETUTCDATE()` — correct (returns UTC datetime).
- MySQL `UTC_TIMESTAMP(3)` — correct (3 = fractional seconds precision, matching the `TIMESTAMP(3)` DDL).
- Oracle `CURRENT_TIMESTAMP` — correct. (Could also use `SYSTIMESTAMP`; ShedLock uses `CURRENT_TIMESTAMP`.)
- HSQL `CURRENT_TIMESTAMP` — correct.
- H2 `CURRENT_TIMESTAMP` — correct.
- DB2 `CURRENT TIMESTAMP` (with space) — correct DB2 syntax.
- SQLite `CURRENT_TIMESTAMP` — correct.

**Uppercasing:** `ORACLE`, `DB2`, `HSQL` → uppercase tableName and columnNames. Matches ShedLock's `dbUpperCase` logic. The plan correctly checks `[ORACLE, DB2, HSQL].includes(databaseProduct)`.

**Validation:** `useDbTime` and `timeZone` mutually exclusive — correctly throws `LockException`. Matches ShedLock.

**`timestamp()` with timeZone:** The spec describes a round-trip through `Intl.DateTimeFormat` to represent wall-clock time in the target timezone, then convert back to a `Date`. This is an edge-case feature rarely used in practice. The plan acknowledges this and tests only that it doesn't crash and returns a `Date`. The exact semantic (what the driver stores) is somewhat hand-wavy — the `Date` produced has a UTC value equal to the wall-clock time in the target timezone, which when serialized by a UTC-treating driver stores the intended local time. This is consistent with ShedLock's behavior but could confuse users. Acceptable for v1 with documentation.

## Gaps and Issues

- **Missing `translateToPositional` / `translateToNamed` in spec.** Plan 03 (`@tslock/sql`, `@tslock/kysely`, `@tslock/drizzle`) Step 2 of the kysely section and Order of Implementation #1 state: "Add `translateToPositional` and `translateToNamed` to `@tslock/sql-support` as utility functions. They are pure string manipulation with no driver dependency." But spec 02 does not list these utilities in its Public API, Exports, or File Structure. This is a cross-document inconsistency — spec 02 should either (a) export these utilities or (b) plan 03 should define them in `@tslock/sql` and duplicate/re-export from there. As written, the kysely and drizzle plans depend on a spec 02 addition that spec 02 doesn't mention.

- **`COCKROACH_DB` non-useDbTime path.** The factory dispatch groups POSTGRES and COCKROACH_DB together for both `useDbTime` (PostgresServerTimeStatementsSource) and non-useDbTime (PostgresSqlStatementsSource). This is correct (CockroachDB is wire-compatible with Postgres and supports `ON CONFLICT DO NOTHING`). The spec states this but could be more explicit about CockroachDB's `now()` function compatibility.

- **`timeZone` semantic clarity.** The `timestamp()` helper with `timeZone` produces a `Date` whose UTC value is the wall-clock time in the target timezone. Most Node.js SQL drivers serialize `Date` as UTC. The net effect is that the stored timestamp represents the local wall-clock time but is stored as if it were UTC. This is ShedLock's behavior but is subtle. Recommend a clearer spec note.

- **Oracle/DB2/HSQL/H2 server-time sources are untested against real DBs.** Both spec and plan acknowledge this — `@tslock/sql` only ships adapters for `pg`, `mysql2`, `mssql`. The server-time sources for Oracle/DB2/HSQL/H2 are unit-tested (string generation) only. Acceptable for parity but should be documented prominently in the README.

- **`DB2` `CURRENT TIMESTAMP` vs `CURRENT_TIMESTAMP`.** DB2 supports both; the spec uses `CURRENT TIMESTAMP` (with space, DB2's native syntax). Correct.

## Recommendations

- Add `translateToPositional` and `translateToNamed` to spec 02's Public API, Exports, and File Structure, since plan 03 depends on them living in `@tslock/sql-support`. Alternatively, spec 03 should define them in `@tslock/sql` and the kysely/drizzle plans should import from `@tslock/sql` (but this creates a cross-provider dependency, which architecture rule 11 forbids — so the utilities should live in `@tslock/sql-support`).
- Add a note to the `timestamp()` section clarifying the exact semantic of the `timeZone` option (what value the driver stores).
- Document in the README that Oracle/DB2/HSQL/H2 server-time sources are provided for completeness and are unit-tested only (no integration tests against real databases).

## Verdict: APPROVED WITH NOTES

The spec and plan are implementation-ready. The `translateToPositional`/`translateToNamed` cross-document inconsistency should be resolved (preferably by adding them to spec 02) before `@tslock/kysely` and `@tslock/drizzle` are built. The `timeZone` semantic and the untested server-time sources are minor notes. SQL statements, factory dispatch, error handling, and the uppercasing/validation logic are all correct.
