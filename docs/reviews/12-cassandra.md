# Review: @tslock/cassandra

**Spec:** `docs/specs/12-cassandra.md`
**Plan:** `docs/plans/12-cassandra.md`

## Summary

The Cassandra provider implements `StorageAccessor` over the `cassandra-driver` client and wraps it with `StorageBasedLockProvider`. Locking uses Cassandra Lightweight Transactions (LWT) — `INSERT ... IF NOT EXISTS` for first-time locks, `UPDATE ... IF <condition>` for expired-lock takeover, unlock, and extend. LWT provides Paxos-based compare-and-set atomicity. The spec and plan are thorough, technically sound, and faithfully map ShedLock's `CassandraLockProvider` to TypeScript. The LWT semantics, consistency level defaults, identifier validation, and `createLockTable` helper are all well-designed. The main note is the same incomplete "rejects extend from different lockedBy" integration test pattern flagged in the Neo4j and Couchbase reviews. Implementation-ready.

## Vision Alignment

**Aligned.** Vision §6.2 lists Cassandra with `cassandra-driver` driver, `@tslock/cassandra` package, `StorageBasedLockProvider` pattern, LWT mechanism. The spec uses exactly this. Framework-agnostic, peer deps on `cassandra-driver` + `@tslock/core` only.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists Cassandra among the storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider`. `CassandraLockProvider` implements `ExtensibleLockProvider` (extend supported). Types consistent with core abstractions. Peer dep `cassandra-driver ^4.6.0`.

## Spec Completeness

**Complete.** Public API types defined: `CassandraLockProvider`, `CassandraLockProviderOptions`, `CassandraColumnNames`, `createLockTable` helper. All four operations fully specified with CQL statements, positional parameters, and `[applied]` result handling. LWT semantics section covers Paxos, `SERIAL`/`LOCAL_SERIAL` consistency, `[applied]` column. Configuration section documents all defaults (`LOCAL_QUORUM`, `LOCAL_SERIAL`, snake_case column names). Validation rules for identifiers and serial consistency. Setup requirements with default schema, custom column names, keyspace, and consistency guidance. Error handling table covers 10 scenarios with detection and behavior. Time representation (`Date` ↔ `timestamp`) documented. Integration test setup with `cassandra:4.1` testcontainer, keyspace creation, and `waitForCassandra` polling. Non-goals explicit (no multi-DC assistance, no auto-keyspace, no Cassandra 3.x, no retries on Paxos contention).

## Plan Completeness

**Complete.** 11 steps from scaffolding through verification. Steps ordered: validation helpers → config types → CQL builders → storage accessor → `createLockTable` → provider → index → unit tests (4 test files) → integration tests → verify. Unit tests mock `Client.execute` with configurable `[applied]` results. 20+ test scenarios covering validation, CQL building, all four operations with `[applied]` true/false, consistency options, Date parameters, qualified keyspace.table, custom column names. Integration tests use `GenericContainer('cassandra:4.1')` with 180s startup timeout, `waitForCassandra` polling helper, keyspace creation, and both `storageBasedLockProviderIntegrationTests` + `fuzzTests`. Risk table has 12 rows covering container startup, driver type resolution, LWT performance, `[applied]` column name, time representation, timezone drift, identifier injection, serial consistency misconfiguration, consistency level, multi-DC, Paxos contention, and `lockedBy` mismatch after restart. Estimation (~7 files, ~450-550 lines + tests) is reasonable.

## Technical Correctness

**`INSERT ... IF NOT EXISTS` for `insertRecord`:** Correct. LWT atomically fails if the row exists. `[applied] === true` → acquired, `false` → already exists. ✅ Matches ShedLock.

**`UPDATE ... IF lock_until < ?` for `updateRecord`:** Correct. Updates only if the stored `lock_until` is before now (lock expired). No `lockedBy` check — updateRecord takes over an expired lock regardless of previous owner. ✅ Matches ShedLock (`IF lockUntil < now`).

**`UPDATE ... IF locked_by = ? AND lock_until >= ?` for `unlock` and `extend`:** Correct. Both check ownership (`locked_by = hostname`) AND validity (`lock_until >= now`). Unlock is best-effort (swallows `[applied] === false`); extend returns the boolean. ✅ Matches ShedLock (`IF lockUntil >= now AND lockedBy = hostname`).

**`[applied]` column check:** `result.rows[0]['[applied]'] === true`. The `[applied]` column is the first column in every LWT result row in `cassandra-driver`. ✅

**Consistency levels:** `LOCAL_QUORUM` (default for non-serial) + `LOCAL_SERIAL` (default for serial). LWT requires `SERIAL` or `LOCAL_SERIAL` — `validateSerialConsistency` throws at construction if any other value is supplied. ✅ Correct and prevents silent misconfiguration.

**Identifier validation:** `^[a-zA-Z_][a-zA-Z0-9_]*$` for keyspace, table, and column names. CQL has no parameterized identifiers — they must be interpolated, so validation is necessary. ✅

**Time representation:** `new Date(epochMillis)` for `timestamp` columns. `cassandra-driver` maps `Date` ↔ `timestamp` faithfully (UTC milliseconds). ✅

**`createLockTable` helper:** `CREATE TABLE IF NOT EXISTS` with configured column names. Idempotent. ✅ Convenient for application startup.

**Snake_case column defaults:** `lock_until`, `locked_at`, `locked_by`. Matches Cassandra conventions (unlike SQL providers which use camelCase). ✅ Deliberate and correct.

## Gaps and Issues

1. **Incomplete "rejects extend from a different lockedBy" integration test.** Same pattern as Neo4j (04) and Couchbase (05). The plan's test:
   ```typescript
   it('rejects extend from a different lockedBy', async () => {
     const owner = new CassandraLockProvider(lockClient, { keyspace: 'shedlock_test', lockedByValue: 'node-A' });
     const intruder = new CassandraLockProvider(lockClient, { keyspace: 'shedlock_test', lockedByValue: 'node-B' });
     const lock = await owner.lock(config('extend-foreign', '1m'));
     const extended = await lock!.extend('1m', 0);
     expect(extended).toBeDefined();
     await extended!.unlock();
   });
   ```
   The `intruder` provider is created but **never used**. The `lock!.extend('1m', 0)` is called on the **owner's** lock — which should succeed (same `lockedBy = node-A`). The test asserts `extended` is defined — the happy path, not the rejection. The test does not verify that the `intruder` (lockedBy = node-B) cannot extend the owner's lock.

   **Fix:** Acquire a lock with `owner`, then attempt to extend it via `intruder`'s internal accessor (or construct a `StorageBasedLockProvider` with the intruder's accessor), and assert it returns `false` (the `IF locked_by = 'node-B'` condition fails because the row has `locked_by = 'node-A'`). The current test passes but doesn't test the rejection.

2. **`CassandraColumnNames` is all-or-nothing (not `Partial`).** The spec's `CassandraLockProviderOptions` has `columnNames?: CassandraColumnNames` where `CassandraColumnNames` has all 4 fields required. If a user wants to customize just `lockedBy`, they must provide all 4 column names. Compare to Spanner/Firestore/Datastore which use `Partial<ColumnNames>`. This is a minor usability regression. **Recommendation:** change to `Partial<CassandraColumnNames>` with a merge-over-defaults resolver, matching the other providers.

3. **`updateRecord` returns `false` on missing row.** Same pattern as Spanner/S3/GCS — when `UPDATE ... IF lock_until < ?` is applied to a non-existent row, LWT returns `[applied] === false` (the row doesn't exist, so the condition can't be evaluated as true). This is faithful to ShedLock (Cassandra LWT naturally returns `[applied] = false` for missing rows — there's no "throw on missing" option). Unlike Couchbase (which can propagate `DocumentNotFoundError`), Cassandra LWT doesn't throw for missing rows — `[applied] = false` is the only signal. So the self-healing approach (propagate to trigger cache clear) is not directly applicable here. **Recommendation:** document the "do not delete rows" caveat. The LWT `[applied] = false` on a missing row is indistinguishable from "lock still held" — both return `false`. This is an inherent Cassandra LWT limitation.

4. **`consistency` enum import in ESM.** The plan uses `import { consistency } from 'cassandra-driver'` and the risk table flags "Verify `consistency` enum import works in ESM." `cassandra-driver` is a CJS package; ESM interop for enums can be tricky. **Recommendation:** verify the import shape (`import { consistency } from 'cassandra-driver'` vs `import cassandra from 'cassandra-driver'; cassandra.types.consistencies`). The spec references `types.consistencies` in one place and the plan uses `consistency` enum directly — these should be reconciled.

5. **`fuzzTests` import.** The plan's integration test imports `fuzzTests` from `@tslock/test-support`, but the test-support spec (01) lists `fuzzTests` as part of the contract. ✅ Consistent. However, the 01-test-support review noted `shouldHandleFuzzWithExtend` is missing from architecture §7.1. The Cassandra plan calls `fuzzTests(...)` without the extend variant (Cassandra IS extensible, so the extend-fuzz should run). **Recommendation:** verify that `fuzzTests` auto-detects extensibility (per the 01-test-support review's recommendation) or explicitly pass `shouldHandleFuzzWithExtend: true`.

6. **Cassandra container startup time.** The plan uses `withStartupTimeout(180_000)` and a `waitForCassandra` polling helper (60 attempts × 2s = 120s max). Cassandra 4.x takes 30-60s to bootstrap. ✅ The polling approach (DESCRIBE KEYSPACES) is more reliable than log-message waiting. The plan marks the suite appropriately. No issue — just an operational note that Cassandra integration tests are slow.

## Recommendations

1. **Fix the "rejects extend from a different lockedBy" integration test.** Exercise the `intruder` provider's extend on the owner's lock and assert `false`. (Issue #1 — same fix needed in Neo4j and Couchbase.)

2. **Change `CassandraColumnNames` to `Partial<CassandraColumnNames>`** with merge-over-defaults, matching Spanner/Firestore/Datastore. (Issue #2)

3. **Document the `updateRecord` missing-row caveat.** Cassandra LWT returns `[applied] = false` for missing rows (indistinguishable from "lock held"). Document that externally deleting rows causes the provider to get stuck (same as Spanner, but not self-healable via propagation because LWT doesn't throw). (Issue #3)

4. **Reconcile `consistency` enum import shape** between spec (`types.consistencies`) and plan (`consistency` enum). (Issue #4)

5. **Verify `fuzzTests` extend variant** runs for Cassandra (which is extensible). (Issue #5)

## Verdict: APPROVED WITH NOTES

The LWT mechanism (`INSERT IF NOT EXISTS`, `UPDATE IF <condition>`, `[applied]` check) is correct and faithful to ShedLock's `CassandraLockProvider`. The consistency level defaults, serial consistency validation, identifier validation, `createLockTable` helper, and snake_case column conventions are all well-designed. The main note is the incomplete "rejects extend from different lockedBy" integration test (#1) — same pattern as Neo4j and Couchbase, should be fixed to actually exercise the intruder. The `CassandraColumnNames` all-or-nothing vs `Partial` (#2) is a minor usability note. The LWT missing-row behavior (#3) is an inherent Cassandra limitation (not self-healable via propagation). The spec and plan are implementation-ready with these notes addressed.
