# Review: @tslock/datastore

**Spec:** `docs/specs/08-datastore.md`
**Plan:** `docs/plans/08-datastore.md`

## Summary

The Datastore provider implements `StorageAccessor` over the `@google-cloud/datastore` client and wraps it with `StorageBasedLockProvider`. Locking uses `runTransaction` (optimistic concurrency with automatic retry) with `txn.get` (read, wrapped in `safeGet` for NOT_FOUND handling) and `txn.upsert` (write, with spread to preserve unknown fields). The spec and plan are thorough and faithful to ShedLock's `DatastoreLockProvider`. Notably, the Datastore `updateOwn` (unlock/extend) has different semantics than Firestore — ShedLock's Datastore provider only checks `lockedBy` (not `lockUntil`), and the TSLock spec correctly reflects this. The `safeGet` helper and spread-preservation are well-designed. Implementation-ready.

## Vision Alignment

**Aligned.** Vision §6.2 lists Datastore with `@google-cloud/datastore` driver, `@tslock/datastore` package, `StorageBasedLockProvider` pattern. The spec uses exactly this. Vision §12 "GCP emulators for Firestore/Datastore" — the plan uses the Datastore emulator (`gcloud beta emulators datastore`). Framework-agnostic, peer deps only.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists Datastore among the storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider`. `createDatastoreProvider` returns `StorageBasedLockProvider` which implements `ExtensibleLockProvider` (extend supported). Types consistent with core abstractions. Peer dep `@google-cloud/datastore ^8.0.0`.

## Spec Completeness

**Complete.** Public API types defined: `DatastoreConfiguration`, `DatastoreFieldNames`, `createDatastoreProvider`, `DatastoreStorageAccessor`. All four operations fully specified with `runTransaction` code, `safeGet` helper, `txn.upsert` calls, and field encoding helpers. Transaction semantics section covers optimistic concurrency, `txn.upsert` overwrite semantics, `txn.get` NOT_FOUND behavior, and `runTransaction` vs `newTransaction` (chose `runTransaction` for auto-retry). Field encoding section covers ISO string vs `Date` modes with `instanceof Date` dispatch. Key/kind considerations (namespace via client constructor, name identifier restrictions) documented. Error handling table covers 9 scenarios. File structure clear. Non-goals explicit (no kind/index creation, no namespace support in v1, no TTL/GC).

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification. Steps ordered logically: config → accessor with helpers → factory → index → unit tests → provider tests → emulator integration tests → verify. Unit tests mock `Datastore` / `runTransaction` / `txn` with configurable `get` (returns entity or throws NOT_FOUND) and `upsert` (captures key + data). 20+ test scenarios covering insert/update/unlock/extend, NOT_FOUND handling (both `code: 5` and message-substring shapes), spread preservation of unknown fields, both field encoding modes, round-trip verification, `instanceof Date` duck-type fallback, custom config. Integration tests use `gcloud beta emulators datastore` with CI guidance (spawn in `globalSetup`, poll port). Risk table has 8 rows covering emulator behavior differences, NOT_FOUND error shape variance, upsert overwrite, emulator flakiness, entity name restrictions, transaction retry exhaustion, namespace handling, and `instanceof Date` cross-realm hazard. Estimation (~4 files, ~250-350 lines + tests) is reasonable.

## Technical Correctness

**`insertRecord` with `safeGet` + `txn.upsert`:** Correct. `txn.upsert` creates or overwrites (no conflict detection by itself). The `safeGet` → `if (existing) return false` check within the transaction provides the conditional-insert semantics. Concurrent modification aborts the transaction (optimistic concurrency). ✅

**`safeGet` wrapping `txn.get` for NOT_FOUND:** Correct. `@google-cloud/datastore`'s `txn.get(key)` throws a gRPC `NOT_FOUND` (code 5) error when the entity doesn't exist. `safeGet` catches this and returns `undefined`, while propagating all other errors. The `isNotFound` helper checks both `e.code === 5` and message substring for robustness across SDK versions. ✅

**`updateRecord` read-then-upsert:** Correct. `safeGet` → if missing `false` → check `lockUntil > now` → `txn.upsert` with `toData`. ✅

**`unlock` with `lockedBy` check + spread preservation:** Correct and faithful to ShedLock. ShedLock's Datastore `updateOwn` checks `lockedBy == hostname` only (NOT `lockUntil >= now` — this differs from Firestore). The spec's unlock matches:
```typescript
if (existing[this.fieldNames.lockedBy] !== this.lockedByValue) return;
txn.upsert({ key, data: { ...existing, [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)) } });
```
The spread `{ ...existing, [lockUntil]: unlockTime }` preserves unknown fields (defensive — `upsert` overwrites the entire entity). ✅

**`extend` with `lockedBy` + `lockUntil >= now` checks:** Correct. Checks `lockedBy` (ownership) and `lockUntil >= now` (validity, via `current < now → false`). Then `txn.upsert` with spread. ✅

**`runTransaction` vs `newTransaction`:** The spec uses `runTransaction` (high-level, auto-retry) rather than `newTransaction` (low-level, manual lifecycle). The b1 notes say ShedLock Java uses `newTransaction()`. The TSLock choice of `runTransaction` is a reasonable simplification — it handles begin/commit/rollback/retry automatically, and the semantics are equivalent for this use case. ✅ Not a deviation, just a TS-appropriate adaptation.

**Field encoding (ISO string vs Date):** The `useDate` option with `instanceof Date` dispatch is a TSLock addition. Both modes well-tested, and the plan flags the cross-realm `instanceof` hazard with a duck-typing fallback. ✅

## Gaps and Issues

1. **`updateRecord` returns `false` on missing entity.** Same pattern as Spanner/S3/GCS — faithful to ShedLock but doesn't trigger `LockRecordRegistry` cache clear. If the entity is externally deleted, the provider is stuck (subsequent calls skip `insertRecord`, go to `updateRecord` → `false`). See the Spanner review (06) for the full discussion. **Recommendation:** document the "do not delete entities" caveat, or propagate to self-heal (matching Couchbase).

2. **`unlock` does not check `lockUntil >= now` — but this is correct for Datastore.** Unlike Firestore (where ShedLock's `updateOwn` checks both `lockedBy` AND `lockUntil >= now`), ShedLock's Datastore `updateOwn` only checks `lockedBy`. The TSLock Datastore spec correctly omits the `lockUntil` check, matching ShedLock. This is NOT an issue — it's the correct Datastore-specific behavior. The Firestore review (07) flags the missing check there because Firestore's `updateOwn` is different. ✅ No change needed. (Documented here to prevent confusion with the Firestore review.)

3. **`txn.upsert` with spread — Datastore entity shape.** The spec says "Datastore entities returned by `txn.get` are plain objects keyed by field name." The spread `{ ...existing, [lockUntil]: value }` assumes the entity is a plain object. However, `@google-cloud/datastore` may return entities with an `[Datastore.KEY]` symbol property or other metadata. Spreading preserves these, which is fine for `upsert` (it uses the explicit `key` parameter, not the spread key). ✅ But the plan should verify that `upsert({ key, data: { ...existing, ... } })` doesn't accidentally include the `[Datastore.KEY]` symbol in `data` (which could cause an error or be silently ignored). **Recommendation:** add a unit test that verifies the spread doesn't break when the entity has `[Datastore.KEY]`.

4. **Emulator setup complexity.** Unlike Firestore (which has `@firebase/rules-unit-testing` for auto-start), Datastore requires `gcloud components install cloud-datastore-emulator` and manual emulator startup. The plan provides CI guidance (spawn in `globalSetup`, poll port) but this is more operational overhead than Firestore. The plan's risk table acknowledges "emulator startup flakiness in CI." ✅ Documented, but the Datastore integration tests are the hardest to run in CI among the GCP providers.

5. **`getAccessor` option in plan not in test-support spec.** Same as Spanner/Firestore — the plan references `getAccessor: ...` in the contract test call, which is underspecified in the test-support spec. Minor forward dependency gap.

## Recommendations

1. **Document the `updateRecord` missing-entity cache consequence** in the spec's error handling table (see issue #1). Either propagate to self-heal or document the "do not delete entities" caveat.

2. **Add a unit test for spread with `[Datastore.KEY]`** to verify the entity metadata symbol doesn't corrupt the `upsert` data. (Issue #3)

3. **Consider providing a `globalSetup` helper** for the Datastore emulator to reduce CI setup burden across provider packages. (Issue #4 — nice-to-have, not blocking.)

## Verdict: APPROVED WITH NOTES

The `runTransaction` + `safeGet` + `txn.upsert` mechanism is correct and faithful to ShedLock's `DatastoreLockProvider`. The `safeGet` NOT_FOUND handling, spread-preservation of unknown fields, and `useDate` field encoding option are well-designed. The spec correctly reflects Datastore's `updateOwn` semantics ( `lockedBy` only, no `lockUntil` check — different from Firestore). The `updateRecord` missing-entity cache behavior (#1) should be documented or self-healed for consistency with Couchbase. The spec and plan are implementation-ready.
