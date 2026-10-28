# Review: @tslock/firestore

**Spec:** `docs/specs/07-firestore.md`
**Plan:** `docs/plans/07-firestore.md`

## Summary

The Firestore provider implements `StorageAccessor` over the `@google-cloud/firestore` client and wraps it with `StorageBasedLockProvider`. Locking uses `runTransaction` (optimistic concurrency with automatic retry) with `txn.get` (read) and `txn.create` / `txn.update` (write) for conditional updates. The spec and plan are thorough and mostly faithful to ShedLock's `FirestoreLockProvider`. One deviation from ShedLock's `updateOwn` semantics (missing `lockUntil >= now` check on unlock) should be addressed. The `useTimestamps` option, `instanceof Timestamp` cross-realm hazard mitigation, and emulator-based integration tests are well-designed. Implementation-ready with one fix.

## Vision Alignment

**Aligned.** Vision §6.2 lists Firestore with `@google-cloud/firestore` driver, `@tslock/firestore` package, `StorageBasedLockProvider` pattern. The spec uses exactly this. Vision §12 "LocalStack + emulators for cloud integration tests" — Firestore has an emulator (`@firebase/rules-unit-testing`), and the plan uses it. Framework-agnostic, peer deps only.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists Firestore among the storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider`. `createFirestoreProvider` returns `StorageBasedLockProvider` which implements `ExtensibleLockProvider` (extend supported). Types consistent with core abstractions. Peer dep `@google-cloud/firestore ^7.0.0`.

## Spec Completeness

**Complete.** Public API types defined: `FirestoreConfiguration`, `FirestoreFieldNames`, `createFirestoreProvider`, `FirestoreStorageAccessor`. All four operations fully specified with `runTransaction` code, `txn.get` / `txn.create` / `txn.update` calls, and field value encoding helpers (`toFieldValue`, `parseFieldValue`, `toData`). Transaction semantics section covers optimistic concurrency, automatic retry, `txn.create` fail-on-exists, `txn.update` fail-on-not-exists. Field encoding section covers ISO string vs `Timestamp` modes with `instanceof` dispatch. Document ID considerations (no `/`, <= 1500 bytes) documented. Error handling table covers 8 scenarios. File structure clear. Non-goals explicit (no collection creation, no index management, no TTL/GC).

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification. Steps ordered logically: config → accessor with helpers → factory → index → unit tests → provider tests → emulator integration tests → verify. Unit tests mock `Firestore` / `runTransaction` / `txn` with configurable `snap.exists`, `snap.get(field)`, `txn.create` / `txn.update`. 20+ test scenarios covering insert/update/unlock/extend, both field encoding modes, round-trip verification, `instanceof Timestamp` duck-type fallback, custom config. Integration tests use `@firebase/rules-unit-testing` (auto-starts emulator, preferred for CI) with cleanup strategy. Risk table has 8 rows covering emulator behavior differences, SDK version mismatch, emulator flakiness, field encoding mode confusion, document ID restrictions, transaction retry exhaustion, document accumulation, and `instanceof Timestamp` cross-realm hazard. Estimation (~4 files, ~250-350 lines + tests, half to full session) is reasonable.

## Technical Correctness

**`insertRecord` with `txn.create`:** Correct. `txn.create` fails at commit if the document exists, triggering a transaction retry. On retry, `snap.exists` is `true` → return `false`. This is the Firestore conditional-insert primitive. ✅

**`updateRecord` read-then-`txn.update`:** Correct. Read checks `snap.exists` (false → return false) and `lockUntil > now` (still locked → false). Then `txn.update` within the transaction. Firestore's optimistic concurrency ensures atomicity. ✅

**`extend` with `lockedBy` + `lockUntil` checks:** Correct. Checks `lockedBy === this.lockedByValue` (ownership) and `lockUntil >= now` (validity, via `current < now → false`). Matches ShedLock's `updateOwn`. ✅

**Field encoding (ISO string vs Timestamp):** The `useTimestamps` option with `instanceof Timestamp` dispatch is a TSLock addition (not in ShedLock). Both modes are well-tested, and the plan flags the cross-realm `instanceof` hazard with a duck-typing fallback (`typeof value.toMillis === 'function'`). ✅

**`@firebase/rules-unit-testing` for emulator:** Correct choice — auto-starts the emulator, no external process needed. The plan provides a fallback with `gcloud beta emulators firestore start` for manual setup. ✅

## Gaps and Issues

1. **`unlock` missing `lockUntil >= now` check — deviation from ShedLock's `updateOwn`.** The ShedLock `FirestoreLockProvider` uses `updateOwn` for both unlock and extend, which checks `lockedBy == hostname AND lockUntil >= now`. The TSLock spec's `unlock` only checks `lockedBy`:
   ```typescript
   if (snap.get(this.fieldNames.lockedBy) !== this.lockedByValue) return;
   txn.update(ref, { [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)) });
   ```
   Missing: `if (current < ClockProvider.now()) return;` (the `lockUntil >= now` guard).

   **Consequence:** If a task overruns `lockAtMostFor` (lock expires, `lockUntil < now`), and the lock was NOT taken by another instance (lockedBy still ours), the unlock sets `lockUntil = unlockTime = max(now, lockAtLeastUntil)`. Since the lock expired past `lockAtMostFor` > `lockAtLeastFor`, `now > lockAtLeastUntil`, so `unlockTime = now`. Setting `lockUntil = now` (from `< now`) is a negligible millisecond extension — nearly harmless in practice. However, it deviates from ShedLock's behavior, where `updateOwn` would no-op (the `lockUntil >= now` check fails).

   **Severity:** Low practical impact, but a faithfulness deviation. The Datastore spec (08) correctly omits this check (ShedLock's Datastore `updateOwn` only checks `lockedBy`). The Firestore spec should add the check to match ShedLock's Firestore-specific `updateOwn`.

   **Fix:** Add `const current = this.parseFieldValue(snap.get(this.fieldNames.lockUntil)); if (current < ClockProvider.now()) return;` before the `txn.update` in `unlock`.

2. **`updateRecord` returns `false` on missing document.** Same pattern as Spanner/S3/GCS — faithful to ShedLock but doesn't trigger `LockRecordRegistry` cache clear. See the Spanner review (06) for the full discussion. For Firestore, `snap.exists === false` in `updateRecord` returns `false` (no throw), so the cache isn't cleared. If the document was externally deleted, the provider is stuck. **Recommendation:** document the "do not delete documents" caveat, or propagate a throw to self-heal (matching Couchbase).

3. **`txn.create` retry exhaustion.** The spec says `txn.create` fails at commit if the document exists, triggering a retry. On retry, `snap.exists` is `true` → return `false`. But if the retry count is exhausted (e.g., concurrent transactions continuously create/delete the document), `runTransaction` throws. The spec's error handling table covers "Transaction retries exhausted → Propagate." ✅ But the unit test list includes "txn.create throws 'already exists' → returns false (simulates retry exhaustion)." This is slightly misleading — retry exhaustion throws, it doesn't return `false`. The `false` return happens on a successful retry where `snap.exists` becomes `true`. **Recommendation:** clarify the unit test description to distinguish "retry succeeds with snap.exists = true → false" from "retry exhausted → throws."

4. **Cleanup between integration tests.** The plan discusses two cleanup strategies: (a) delete all documents in `beforeEach`, or (b) use unique collection names per test run. The plan notes the contract's `uniqueLockName()` helper unique-ifies lock names, so cross-test interference is avoided. But stale documents accumulate across runs. The plan suggests "a collection delete" for cross-run cleanup but doesn't specify the mechanism. **Recommendation:** specify the cleanup mechanism — e.g., `firestore.recursiveDelete(firestore.collection('shedlock'))` in `afterAll` or `beforeAll`.

5. **`getAccessor` option in plan not in test-support spec.** Same as Spanner — the plan references `getAccessor: ...` in the contract test call, which is underspecified in the test-support spec. Minor forward dependency gap.

## Recommendations

1. **Add `lockUntil >= now` check to `unlock`** to match ShedLock's Firestore `updateOwn` semantics. This is the one blocking faithfulness fix. (Issue #1)

2. **Document or self-heal the `updateRecord` missing-document behavior.** Add a note to the error handling table, or propagate to trigger cache clear. (Issue #2)

3. **Clarify the `txn.create` retry-exhaustion unit test** to distinguish successful-retry-returns-false from retry-exhausted-throws. (Issue #3)

4. **Specify the integration test cleanup mechanism** — `firestore.recursiveDelete` or equivalent. (Issue #4)

## Verdict: APPROVED WITH NOTES

The `runTransaction` + `txn.create` / `txn.update` mechanism is correct and faithful to ShedLock's `FirestoreLockProvider`. The one deviation is the missing `lockUntil >= now` check on `unlock` (#1) — ShedLock's Firestore `updateOwn` checks both `lockedBy` and `lockUntil`, the TSLock spec only checks `lockedBy`. This should be fixed for faithfulness (low practical impact but a real semantic difference). The `useTimestamps` option, `instanceof Timestamp` cross-realm mitigation, and emulator-based integration tests are well-designed. The spec and plan are implementation-ready with issue #1 addressed.
