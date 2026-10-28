# Review: @tslock/arangodb

**Spec:** `docs/specs/11-arangodb.md`
**Plan:** `docs/plans/11-arangodb.md`

## Summary

The ArangoDB provider is a **DIRECT** `LockProvider` (not `StorageBasedLockProvider`) that uses `arangojs` stream transactions with an **exclusive collection lock** (`exclusiveCollections`) to serialize concurrent lock attempts. Lock acquisition wraps a read-check-write sequence (document → save/update/abort) in a single transaction, guaranteeing at-most-one acquisition. The spec correctly categorizes this as a direct provider and faithfully maps ShedLock's `ArangoLockProvider`. The main issues are: (1) `extend` is non-transactional with no CAS, creating a TOCTOU race that can clobber another instance's lock; (2) spec/plan inconsistency on `collection.database()` vs stored database reference; (3) `exclusiveCollections` is Enterprise-only but the Community Edition fallback (`writeCollections`) is in the plan, not the spec; (4) arangojs v8 API drift (`beginTransaction` vs `db.transaction()` + `trx.step()`). Implementation-ready with these reconciled.

## Vision Alignment

**Aligned.** Vision §6.3 lists ArangoDB with `arangojs` driver, `@tslock/arangodb` package, DIRECT LockProvider mechanism ("stream transaction + insert/update"). The spec uses exactly this. Framework-agnostic, peer deps on `arangojs` + `@tslock/core` only.

## Architecture Alignment

**Correct as DIRECT LockProvider.** Architecture §6.2 Category B (direct providers) lists ArangoDB. The spec correctly does NOT use `StorageBasedLockProvider` — instead implements `LockProvider` directly with `ArangoDbAccessor` encapsulating the stream transaction logic. Implements `ExtensibleLockProvider` (extend supported via `ArangoDbLock.doExtend`). The `ArangoDbLock extends AbstractSimpleLock` pattern matches the core spec's lock abstraction. ✅

## Spec Completeness

**Complete.** Public API types defined: `ArangoDbLockProvider` (constructor takes `Collection`), `createArangoDbLockProvider` factory (takes `Database` + options), `ArangoDbLockProviderOptions`, `ArangoDbLockDocument`, `ArangoDbLock`, `ArangoDbAccessor`. Locking mechanism fully specified with `beginTransaction({ exclusiveCollections })` code, `collection.document` / `collection.save` / `collection.update` calls, `txn.commit()` / `txn.abort()` flow, and `isDocumentNotFoundError` (error code 1202) handling. Extend and unlock paths specified. Error handling table covers 11 scenarios. Dependencies, exports, file structure, and non-goals all documented.

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification. Steps ordered: lock document type → accessor (stream transaction + document ops) → lock (thin `AbstractSimpleLock` subclass) → provider + factory → index → unit tests (mocked Collection + transaction) → integration tests (testcontainers ArangoDB) → verify. Unit tests mock `Collection` with `database()` → `beginTransaction()` → `txn` (`commit`/`abort`), `document`, `save`, `update`. 15+ test scenarios covering lock insert/update/held paths, extend ownership/expiry/missing, unlock with lockAtLeastFor, error propagation. Integration tests use `arangodb:3.11` testcontainer with `createCollection` in `beforeAll`, `truncate` in `beforeEach`. Risk table has 9 rows covering arangojs API drift, `exclusiveCollections` Enterprise-only, collection pre-existence, `collection.database()` existence, `Date.parse` timezone safety, double-abort, testcontainer image edition, `update` on non-existent key, and `@testcontainers/arangodb` availability. Estimation (~5 files, ~300-400 lines + tests) is reasonable.

## Technical Correctness

**Stream transaction with `exclusiveCollections`:** Correct. The exclusive collection lock serializes all concurrent lock attempts on the collection — only one transaction can access it at a time. This makes the read-check-write sequence atomic across concurrent attempts without needing CAS or LWT. ✅ Faithful to ShedLock.

**`lock` flow:** `beginTransaction` → `document(id)` → if not found (code 1202): `save` + `commit` → acquired. If found and expired (`lockUntil <= now`): `update` + `commit` → acquired. If found and held (`lockUntil > now`): `abort` → `undefined`. ✅ Matches ShedLock.

**`isDocumentNotFoundError` checking error code 1202:** Correct. ArangoDB error code `1202` = `ERROR_ARANGO_DOCUMENT_NOT_FOUND`. The helper checks `e?.errorNum === 1202 || e?.code === 1202`. ✅

**`unlock` unconditional `collection.update`:** `collection.update(config.name, { lockUntil: unlockTime })` — no `lockedBy` or `lockUntil` precondition. Catches code 1202 (document gone) and swallows it. This is faithful to ShedLock (`updateDocument set lockUntil=unlockTime`). The inherent overrun-clobbering risk (late unlock clobbers a concurrent acquirer's lock) exists in ShedLock too — it's a known limitation of time-based locks, not a deviation. ✅

**`ArangoDbLock extends AbstractSimpleLock`:** Correct pattern. `doUnlock` delegates to `accessor.unlock`, `doExtend` delegates to `accessor.extend` and returns `ArangoDbLock | undefined`. ✅

## Gaps and Issues

1. **`extend` is non-transactional with no CAS — TOCTOU race can clobber another instance's lock.** The spec's `extend` does a read-then-update WITHOUT a stream transaction:
   ```typescript
   existing = await this.collection.document(documentId);  // read
   if (existing.lockedBy !== hostname) return undefined;
   if (Date.parse(existing.lockUntil) <= now) return undefined;
   await this.collection.update(documentId, { lockUntil: ... });  // unconditional update
   ```
   Between the read and the update, another instance could acquire the lock (if it expired and was taken over). The unconditional `collection.update` would then clobber the new holder's lock. The spec acknowledges no transaction but claims "the check-then-update is safe because only the original holder can extend, and a stale read just causes a no-op update." This is **incorrect** — a stale read does NOT cause a no-op. The `update` is unconditional (no `WHERE`, no CAS, no `ifMatch` revision check). If the lock was taken by another instance between read and update, the update clobbers it.

   **Race window:** The lock is about to expire (lockUntil ≈ now) → `KeepAliveLockProvider` calls extend → read succeeds (lockedBy = me, lockUntil > now) → lock expires (now > lockUntil) → another instance acquires (update with their lockedBy + future lockUntil) → our extend's `collection.update` fires, overwriting lockUntil with our new value. Now the other instance thinks it holds the lock, but our extend changed the lockUntil. The other instance's `lockedBy` is preserved (we only update `lockUntil`), but the lockUntil is wrong.

   **Severity:** Narrow window (lock must expire during the read-update gap), but real — especially with `KeepAliveLockProvider` which extends at `lockAtMostFor/2` (if delayed, the lock could expire). With manual `LockExtender.extendActiveLock`, the user controls timing, but the race still exists.

   **Fix options:**
   - (a) Wrap extend in a stream transaction with `exclusiveCollections` (same as `lock`). Heavy but safe.
   - (b) Use ArangoDB's optimistic locking via document revision (`ifMatch: existing._rev`). `collection.update(id, data, { ifMatch: existing._rev })` fails if the document was modified since the read. This is the lightweight CAS approach.
   - (c) Use an AQL query with `FILTER doc.lockedBy == @hostname AND doc.lockUntil > @now` in the update. ArangoDB AQL supports `UPDATE ... WITH ... IN @collection FILTER ...` but this requires a transaction or `FOR ... UPDATE` construct.

   **Recommendation:** Use option (b) — `ifMatch: existing._rev` — for a lightweight CAS. If the update fails (revision mismatch), return `undefined` (lock was taken). This matches the spirit of ShedLock's ownership check and avoids the race without a full transaction.

2. **`collection.database()` vs stored database reference — spec/plan inconsistency.** The spec's `lock` code calls `this.collection.database().beginTransaction(...)`. The plan's risk table says: "Verify this method exists on the `arangojs` `Collection` type. If not, accept the `Database` in the accessor constructor alongside the `Collection`. **Decision:** accept both — the accessor stores the `database` reference passed from the provider to avoid relying on `collection.database()`."

   The spec and plan disagree: the spec calls `collection.database()`, the plan says to store the database reference separately. If `collection.database()` doesn't exist in arangojs v8, the spec's code won't compile. **Recommendation:** update the spec to pass the `Database` to `ArangoDbAccessor` constructor (matching the plan's decision), and use `this.database.beginTransaction(...)` instead of `this.collection.database().beginTransaction(...)`.

3. **`exclusiveCollections` is Enterprise-only — Community Edition fallback in plan but not spec.** The plan's risk table says: "On the Community Edition, `exclusiveCollections` is rejected. Fall back to `writeCollections: [collectionName]` — write transactions on the same collection are serialized by ArangoDB. **Decision:** support both — try `exclusiveCollections`, fall back to `writeCollections` on error."

   The spec only mentions `exclusiveCollections` and doesn't document the Community Edition fallback. The public Docker image (`arangodb:3.11`) is Community Edition, so the integration test will exercise the fallback path. **Recommendation:** update the spec to document both `exclusiveCollections` (Enterprise) and `writeCollections` (Community) with the fallback strategy. The `ArangoDbAccessor` should try `exclusiveCollections` first, catch the "not supported" error, and retry with `writeCollections`.

4. **arangojs v8 API drift — `beginTransaction` vs `db.transaction()` + `trx.step()`.** The plan's risk table notes: "The current `arangojs` v8 API exposes `db.transaction()` + `trx.step()` + `trx.commit()`/`trx.abort()`. Older v7 exposed `db.beginTransaction(options)` returning a `Transaction` with direct collection operations. Pin `arangojs: "^8.0.0"` in `peerDependencies`. If the installed version exposes `db.transaction()` instead of `beginTransaction`, adapt the accessor."

   The spec uses `beginTransaction({ exclusiveCollections })` throughout, but if the peer dep is `^8.0.0`, the v8 API may not have `beginTransaction`. This is a significant API drift that could make the spec's code non-compilable. The plan acknowledges it but the spec doesn't. **Recommendation:** verify the arangojs v8 stream transaction API and update the spec's code examples to match the actual v8 API. If v8 uses `db.transaction()` + `trx.step()`, the spec should show that pattern. If v8 still supports `beginTransaction`, document the version requirement explicitly.

5. **`unlock` unconditional update — overrun clobbering.** As noted in Technical Correctness, `unlock` is unconditional (no `lockedBy` check), matching ShedLock. If a task overruns `lockAtMostFor` and another instance acquires the lock, the late `unlock` clobbers the new holder's `lockUntil`. This is an inherent limitation of time-based locks (documented in the Hazelcast/ZooKeeper reviews too). **Recommendation:** document this honestly in the spec's error handling table or a caveats section: "If a task overruns `lockAtMostFor` and another instance acquires the lock, the late `unlock` will overwrite the new holder's `lockUntil`. This is an inherent limitation of time-based locks — set `lockAtMostFor` generously to avoid it."

6. **`@testcontainers/arangodb` availability.** The plan's risk table notes this package may not exist and suggests `GenericContainer('arangodb:3.11')` with port 8529. ✅ Good mitigation. The integration test should use `GenericContainer` as the primary approach to avoid a dependency on a package that may not exist.

## Recommendations

1. **Fix the `extend` TOCTOU race** by using `ifMatch: existing._rev` (optimistic locking via document revision) or wrapping extend in a stream transaction. (Issue #1 — this is the most significant finding.)

2. **Reconcile `collection.database()` vs stored database reference.** Update the spec to pass `Database` to the accessor constructor, matching the plan's decision. (Issue #2)

3. **Document the `writeCollections` Community Edition fallback** in the spec, not just the plan. (Issue #3)

4. **Verify and update for arangojs v8 API.** Confirm whether `beginTransaction` exists in v8; if not, update the spec's code to use `db.transaction()` + `trx.step()`. (Issue #4)

5. **Document the overrun-clobbering caveat** for `unlock`. (Issue #5)

## Verdict: APPROVED WITH NOTES

The stream-transaction-with-exclusive-collection-lock mechanism is correct and faithful to ShedLock's `ArangoLockProvider`. The DIRECT LockProvider categorization is correct (not `StorageBasedLockProvider`). The most significant finding is the `extend` TOCTOU race (#1) — the non-transactional, no-CAS read-then-update can clobber another instance's lock in a narrow window. This should be fixed with `ifMatch: existing._rev` or a stream transaction. The spec/plan inconsistencies on `collection.database()` (#2), `writeCollections` fallback (#3), and arangojs v8 API (#4) should be reconciled before implementation. The spec and plan are implementation-ready with these notes addressed.
