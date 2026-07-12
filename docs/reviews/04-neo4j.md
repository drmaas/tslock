# Review: @tslock/neo4j

**Spec:** `docs/specs/04-neo4j.md`
**Plan:** `docs/plans/04-neo4j.md`

## Summary

The Neo4j provider implements `StorageAccessor` over `neo4j-driver` and wraps it with `StorageBasedLockProvider`. Lock uniqueness is enforced by a Neo4j unique constraint on the lock name; insert fails on constraint violation, update succeeds only if the existing lock has expired, extend verifies ownership via `lockedBy`. The spec and plan are thorough, well-structured, and technically sound. The Cypher queries are correct, the constraint-violation detection logic matches ShedLock's Java provider, and the plan's risk table is comprehensive. One incomplete integration test and a couple of minor documentation gaps are the only notes. Implementation-ready.

## Vision Alignment

**Aligned.** Vision §6.2 specifies Neo4j with "Cypher unique constraint" mechanism, `neo4j-driver`, package `@tslock/neo4j`, using `StorageBasedLockProvider`. The spec uses exactly this — `StorageBasedLockProvider` with a `StorageAccessor` issuing Cypher queries against a `:ShedLock` node label with a unique constraint on `name`. Vision §4 "Provider-pluggable, minimal dependencies" — peer deps on `neo4j-driver` + `@tslock/core` only. Framework-agnostic.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists Neo4j among the 11 storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider` — correct. The `Neo4jLockProvider` class `implements ExtensibleLockProvider` by delegating to `StorageBasedLockProvider` (which implements `ExtensibleLockProvider`) — correct. Types are consistent with core abstractions (`LockConfiguration`, `SimpleLock`, `StorageAccessor`, `AbstractStorageAccessor`, `StorageBasedLockProvider`). Peer dep `neo4j-driver ^5.0.0` matches vision.

## Spec Completeness

**Complete.** Public API types defined: `Neo4jLockProvider`, `Neo4jLockProviderOptions`, `Neo4jColumnNames`, `createUniqueConstraint` helper. Locking mechanism (insert/update/unlock/extend) is fully specified with Cypher queries, parameter values, and result handling for each. Error handling is a 7-row table covering constraint violation, no-node-matched, connection errors, auth errors, database-not-found, and session lifecycle. The constraint-violation detection logic (`error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed'` + message contains `already exists with label` + lock name) is well-documented with rationale (avoids misclassifying violations on other constraints). Configuration options with defaults are tabulated. Setup requirements (unique constraint creation, Neo4j 4.1+ for `IF NOT EXISTS`) are documented. File structure is clear. Integration test approach (testcontainers, Neo4j 5 container) is documented.

The spec also documents the `lockedBy` stability assumption for extend — important operational note.

## Plan Completeness

**Complete.** 10 steps from scaffolding through verification. Steps ordered logically: cypher builders (no driver dep) → types → accessor (mocked driver tests) → constraint helper → provider → index → integration tests. Unit tests use a mocked `Driver`/`Session`/`Transaction` — the test list is comprehensive (13 scenarios including constraint violation, non-constraint error, different-lock-name constraint error, session.close in finally). Integration tests use `GenericContainer('neo4j:5')` with `NEO4J_AUTH=neo4j/password` and `createUniqueConstraint` at setup. The risk table is thorough (8 rows) covering error code changes, Cypher injection, epoch millis precision, session leaks, container startup, concurrent insert race, custom database, and `lockedBy` mismatch on extend. Estimation (~6 files, ~400-500 lines, one session) is reasonable.

## Technical Correctness

**Cypher queries — all correct:**
- INSERT: `CREATE (lock:ShedLock {name: $name, lockUntil: $lockUntil, lockedAt: $lockedAt, lockedBy: $lockedBy})` — correct. No `RETURN` needed; success implies creation.
- UPDATE: `MATCH (lock:ShedLock {name: $name}) WHERE lock.lockUntil <= $now SET lock.lockUntil = $lockUntil, lock.lockedAt = $lockedAt, lock.lockedBy = $lockedBy RETURN lock` — correct. The `WHERE` clause acquires only if expired. `RETURN lock` allows checking `result.records.length` to determine success.
- UNLOCK: `MATCH (lock:ShedLock {name: $name}) SET lock.lockUntil = $unlockTime` — correct. No `RETURN` needed; best-effort. If the node was deleted, `MATCH` matches zero nodes — no-op. Correct.
- EXTEND: `MATCH (lock:ShedLock {name: $name}) WHERE lock.lockedBy = $lockedBy AND lock.lockUntil > $now SET lock.lockUntil = $lockUntil RETURN lock` — correct. Verifies ownership (`lockedBy`) and validity (`lockUntil > now`).
- CREATE CONSTRAINT: `CREATE CONSTRAINT shedlock_name_unique IF NOT EXISTS FOR (lock:ShedLock) REQUIRE lock.name IS UNIQUE` — correct Neo4j 4.1+ syntax.

**Constraint violation detection:** `error.code === 'Neo.ClientError.Schema.ConstraintValidationFailed'` + `error.message.match(/already exists with label/)` + `error.message.includes(lockName)`. This matches ShedLock's Java `Neo4jLockProvider` exactly. The `lockName` containment check is important — it avoids swallowing a constraint violation on a *different* constraint that happens to share the same error code. The `error.message.match(/already exists with label/)` is a fixed pattern (not injectable by lock name), and `error.message.includes(lockName)` is a substring check (not regex) — no regex injection. ✅

**Epoch millis as JS numbers:** The plan correctly notes that `neo4j-driver` v5 accepts JS numbers up to `Number.MAX_SAFE_INTEGER` (current epoch millis ~1.7e12 is well within range). No `neo4j.int()` conversion needed. ✅

**Session lifecycle:** `try { await session.writeTransaction(async (tx) => { ... }) } finally { await session.close() }` — correct. The plan's unit test asserts `session.close()` is called when `writeTransaction` throws. ✅

**`database` option:** `driver.session({ database: this.opts.database })` — when `undefined`, the plan says "omit the option so driver default applies." This is correct — passing `database: undefined` might cause issues in some driver versions. ✅

**Label/column name validation:** The plan validates against `^[A-Za-z_][A-Za-z0-9_]*$` to prevent Cypher injection from misconfigured label/column names. Since these are interpolated directly into Cypher strings (config values, not user input), validation is the right defense. ✅

**`lockedBy` for extend:** The accessor uses `this.opts.lockedByValue` at extend time, which is the same value used at insert time (the accessor instance is constructed once and reused). The spec documents the assumption: "this requires the hostname to be stable across the lifetime of the lock." The plan's risk table reiterates: "Recommend users set `lockedByValue` explicitly when running across multiple instances (do not rely on hostname stability)." Good operational guidance. ✅

## Gaps and Issues

1. **Incomplete integration test for "rejects extend from a different lockedBy".** Plan Step 9 shows:
   ```typescript
   it('rejects extend from a different lockedBy', async () => {
     const owner = new Neo4jLockProvider(driver, { lockedByValue: 'node-A' });
     const intruder = new Neo4jLockProvider(driver, { lockedByValue: 'node-B' });
     const lock = await owner.lock(config('extend-foreign', '1m'));
     expect(lock).toBeDefined();
     const extended = await lock!.extend('1m', 0);
     // Intruder cannot extend (lockedBy mismatch)
     // (covered indirectly via shouldNotExtendIfExpired-style assertions)
     await lock!.unlock();
   });
   ```
   The test creates an `intruder` provider but never uses it. The comment says "covered indirectly" — but it isn't. The test should: acquire lock with `owner`, then attempt extend with `intruder` (by constructing an `intruder`-owned `StorageLock` or by calling `intruder.lock()` and then internally extending). This requires either exposing the accessor for testing or constructing a `StorageBasedLockProvider` directly with the intruder's accessor. The test as written does not verify the cross-instance extend rejection. **Should be fixed.**

2. **Neo4j version requirement prominence.** The spec's Non-Goals says "No support for Neo4j 3.x (which lacks `IF NOT EXISTS` on `CREATE CONSTRAINT`). Requires Neo4j 4.1+ for the constraint helper." This is buried in Non-Goals. The `IF NOT EXISTS` clause for constraints was added in Neo4j 4.1. The Setup Requirements section should mention the minimum version prominently, as the `createUniqueConstraint` helper would fail with a syntax error on older versions.

3. **`writeTransaction` vs `executeRead`/`executeWrite`.** Neo4j driver v5 introduced `executeRead`/`executeWrite` as replacements for `readTransaction`/`writeTransaction` (which are deprecated in v5). The spec and plan use `session.writeTransaction(...)`. For a v1 targeting `neo4j-driver ^5.0.0`, using the deprecated API is acceptable but not ideal. Recommend using `session.executeWrite(async (tx) => { ... })` to align with the v5 API. The behavior is equivalent; `executeWrite` is the non-deprecated path.

4. **`createUniqueConstraint` swallowing constraint errors.** Plan Step 6 says "Swallow `Neo.ClientError.Schema.ConstraintValidationFailed` errors (constraint already exists — idempotent path if `IF NOT EXISTS` is unsupported on an old Neo4j version)." But the Cypher uses `IF NOT EXISTS`, so on Neo4j 4.1+ this is already idempotent — no error would be thrown for an existing constraint. The swallow logic is a belt-and-suspenders approach for older Neo4j versions (which the spec doesn't support anyway). Minor — harmless but unnecessary on supported versions.

5. **No unit test for label/column name validation.** The plan mentions validation in Step 3 (`resolveOptions`) and the cypher test (Step 8) says "Reject label / column names containing characters outside `[A-Za-z_][A-Za-z0-9_]*`" — but this test is in `neo4j-cypher.test.ts`, which tests the cypher builders. The validation lives in `resolveOptions` (in `neo4j-lock-provider.ts`). The test should be in the provider test or the cypher test should import and test `resolveOptions`. Minor test placement issue.

## Recommendations

1. **Fix the "rejects extend from a different lockedBy" integration test.** Acquire a lock with the `owner` provider, then verify that an `intruder` provider (different `lockedByValue`) cannot extend it. This requires either: (a) using `StorageBasedLockProvider` directly with the intruder's accessor, or (b) acquiring a lock via `intruder.lock()` (which returns `undefined` since the lock is held) — but extend requires an active `SimpleLock`. The cleanest approach: construct the `intruder` provider's `StorageAccessor` directly in the test, call `accessor.extend(config)` with the same lock name, and assert it returns `false`.

2. **Prominent Neo4j version requirement.** Add a note to Setup Requirements: "Requires Neo4j 4.1+ for `IF NOT EXISTS` on `CREATE CONSTRAINT`. The `createUniqueConstraint` helper will fail with a syntax error on older versions."

3. **Use `session.executeWrite()` instead of `session.writeTransaction()`.** Align with the non-deprecated Neo4j driver v5 API. Behavior is equivalent.

4. **Move label/column name validation test** to the provider test or ensure `resolveOptions` is exported/tested alongside the cypher builders.

## Verdict: APPROVED WITH NOTES

The Cypher queries, constraint-violation detection, session lifecycle, and `lockedBy` ownership semantics are all correct and faithful to ShedLock's Java provider. The incomplete integration test (#1) should be fixed — it claims to verify cross-instance extend rejection but doesn't actually exercise the intruder. The `executeWrite` vs `writeTransaction` note (#3) is a minor modernization. The spec and plan are implementation-ready with these notes addressed.
