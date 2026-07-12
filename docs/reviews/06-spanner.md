# Review: @tslock/spanner

**Spec:** `docs/specs/06-spanner.md`
**Plan:** `docs/plans/06-spanner.md`

## Summary

The Spanner provider implements `StorageAccessor` over the `@google-cloud/spanner` client and wraps it with `StorageBasedLockProvider`. Locking uses read-write transactions: `Mutation.insert` for first-time locks (conflict detected at commit), read-then-`Mutation.update` for expired-lock takeover, and DML `UPDATE` statements for unlock and extend. The spec and plan are technically sound and faithfully map ShedLock's Java `SpannerLockProvider` to TypeScript. The main discussion point is `updateRecord` returning `false` on missing row (same pattern flagged in the S3/GCS reviews) — faithful to ShedLock but prevents `LockRecordRegistry` self-healing if a row is externally deleted. Implementation-ready with notes.

## Vision Alignment

**Aligned.** Vision §6.2 lists Spanner with `@google-cloud/spanner` driver, `@tslock/spanner` package, `StorageBasedLockProvider` pattern. The spec uses exactly this. Vision §5.1 "all 24 providers" — Spanner is one of the 8 storage-based providers. Vision §4 "minimal dependencies" — peer deps on `@google-cloud/spanner` + `@tslock/core` only. Framework-agnostic. Vision §12 "Skip Spanner/GCS (no emulator) — unit tests only" — the spec correctly specifies unit tests only with a skipped live-integration test.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists Spanner among the storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider`. `createSpannerProvider` returns `StorageBasedLockProvider` which implements `ExtensibleLockProvider` (extend supported). Types consistent with core abstractions. Peer dep `@google-cloud/spanner ^7.0.0`.

## Spec Completeness

**Complete.** Public API types defined: `SpannerConfiguration`, `SpannerColumnNames`, `createSpannerProvider`, `SpannerStorageAccessor`. All four operations (insert/update/unlock/extend) fully specified with `readWriteTransaction().run()` code, `Mutation` API usage, DML statements with backtick-quoted identifiers, and `@param` placeholders. Transaction semantics section covers pessimistic row locking, optimistic concurrency retry, `Mutation.insert` conflict detection at commit, and DML `runUpdate` row-count semantics. Schema provided (`STRING(MAX)` columns, `PRIMARY KEY (name)`). Error handling table covers 8 scenarios. Identifier validation regex documented. File structure clear. Non-goals explicit (no schema migration, no TIMESTAMP columns, no emulator tests, no `useDbTime`).

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification. Steps ordered logically: config resolver → accessor (with helpers) → factory → index → unit tests → contract tests → verify. Unit tests mock `DatabaseClient` / transaction / `readRow` / `runUpdate`. The mock design captures mutations and configurable return values. 20+ test scenarios covering insert/update/unlock/extend success and error paths, both insert-conflict error shapes (code 6 and 9), custom config, identifier validation. A skipped live-integration test (`describeLive`) is provided for manual GCP verification. Risk table has 6 rows covering emulator absence, SDK API drift, error code variance, SQL injection, transaction retry exhaustion, and `readRow` null/undefined handling. Estimation (~4 files, ~250-350 lines, half a session) is reasonable.

## Technical Correctness

**`Mutation.insert` in a read-write transaction:** Correct. The insert is atomic at commit; duplicate primary key surfaces as an error at commit time (not at `txn.add` time). The accessor catches the conflict and returns `false`. ✅

**`isInsertConflictError` checking both code 6 (ALREADY_EXISTS) and code 9 (FAILED_PRECONDITION):** The Spanner Node SDK has changed the error code across majors. Checking both is the correct defensive approach. The plan flags this as a discovery task with unit tests covering both shapes. ✅

**`updateRecord` read-then-`Mutation.update`:** Correct. Spanner read-write transactions acquire pessimistic row locks on reads, so concurrent `updateRecord` calls on the same row serialize. The read checks `lockUntil > now` (still locked → false), then `Mutation.update` overwrites the row. ✅

**`unlock` DML with `WHERE name = @name AND lockedBy = @lockedBy`:** Correct. The `lockedBy` check prevents unlocking a lock we no longer own (after expiry + takeover). 0 rows affected is a silent no-op (best-effort). ✅

**`extend` DML with `WHERE name = @name AND lockedBy = @lockedBy AND lockUntil > @now`:** Correct. The `lockUntil > @now` condition ensures we only extend a still-valid lock. `rowCount > 0` → true. ✅

**`STRING(MAX)` column type for ISO-8601 timestamps:** The spec stores all fields as `STRING(MAX)` ISO-8601 strings via `Utils.toIsoString()`. This matches the TSLock-wide convention (natural sort ordering, portability, inspectability). `TIMESTAMP` columns are a non-goal. ✅

**Identifier validation (`^[A-Za-z_][A-Za-z0-9_]*$`):** Prevents SQL identifier injection. Column names and table name are config-time validated, then backtick-quoted in DML. ✅

## Gaps and Issues

1. **`updateRecord` returns `false` on missing row — same pattern as S3/GCS.** When `readRow` returns `undefined` (row was externally deleted), `updateRecord` returns `false`. In `StorageBasedLockProvider`, `false` from `updateRecord` (without throwing) does NOT clear the `LockRecordRegistry` cache. The name stays cached, so subsequent `lock()` calls skip `insertRecord` and go straight to `updateRecord` — which returns `false` again (row still missing). The provider is stuck returning `undefined` until restart.

   This is **faithful to ShedLock** (the Java Spanner provider also returns `false` for missing rows, and ShedLock documents "Do not manually delete lock row" precisely because of this). However, the Couchbase spec (review 05) chose to **propagate** `DocumentNotFoundError` from `updateRecord`, which triggers the cache clear and self-heals on the next attempt. The S3 review (09) flagged this as NEEDS REVISION for the same reason.

   **Recommendation:** For consistency across TSLock, either (a) propagate the "row missing" condition from `updateRecord` as an exception (matching Couchbase's self-healing approach), or (b) keep the ShedLock-faithful `false` return but document the "stuck if externally deleted" caveat prominently. The current spec does neither — it returns `false` silently without documenting the consequence. At minimum, add a note to the error handling table: "Row missing in `updateRecord` → returns `false`; the `LockRecordRegistry` cache is not cleared, so the provider will not retry `insertRecord` until restarted. Do not externally delete lock rows."

2. **`readRow` return shape across SDK versions.** The plan's risk table notes that `readRow` may return `null` vs `undefined` across SDK versions, and the code uses `!row` to handle both. However, some Spanner SDK versions throw on not-found rather than returning a nullish value. The spec assumes `[undefined]` (no throw). The plan mitigates this with `!row` but doesn't handle the throw case. **Recommendation:** add a `try/catch` around `readRow` that treats not-found errors as "row missing" (return `false`), or verify against the pinned SDK version that `readRow` returns `[undefined]` rather than throwing.

3. **`timeMode: 'mock'` in contract tests.** The plan (Step 8) runs `storageBasedLockProviderIntegrationTests` with `timeMode: 'mock'` against the mocked `DatabaseClient`. This exercises the `StorageBasedLockProvider` algorithm but not real Spanner transaction semantics. The plan acknowledges this ("not a true integration test"). This is the best available without an emulator, but the test name `integration.test.ts` is misleading — it's a mock-backed contract test. **Recommendation:** rename to `contract.test.ts` or add a comment header clarifying it's mock-backed.

4. **`getAccessor` option in plan not in test-support spec.** The plan references `getAccessor: ...` in the contract test call, but the 01-test-support review flagged that `getAccessor` is in plans but not in the test-support spec. This is a forward dependency on an underspecified option. Minor — carried forward from the test-support spec gap.

## Recommendations

1. **Document the `updateRecord` missing-row cache consequence** in the spec's error handling table (see issue #1). Either propagate to self-heal (Couchbase approach) or document the "do not delete rows" caveat explicitly.

2. **Verify `readRow` not-found behavior** against the pinned `@google-cloud/spanner ^7.0.0` and add a `try/catch` fallback if it throws.

3. **Rename the mock-backed contract test** from `integration.test.ts` to `contract.test.ts` to avoid confusion with the skipped live-integration test.

4. **Consider `Partial<SpannerColumnNames>`** for consistency with Firestore/Datastore which use `Partial<FieldNames>`. The current spec already uses `Partial<SpannerColumnNames>` — ✅ consistent. (No change needed.)

## Verdict: APPROVED WITH NOTES

The `Mutation.insert` + read-then-`Mutation.update` + DML `UPDATE` mechanism is correct and faithful to ShedLock's Java `SpannerLockProvider`. The `isInsertConflictError` dual-code check, identifier validation, and backtick-quoted DML are well-designed. The main note is the `updateRecord` missing-row behavior (#1) — faithful to ShedLock but should be documented or made self-healing for consistency with Couchbase. The `readRow` not-found behavior (#2) should be verified against the pinned SDK version. The spec and plan are implementation-ready with these notes addressed.
