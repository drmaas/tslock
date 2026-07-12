# Review: @tslock/mongo

**Spec:** `docs/specs/13-mongo.md`
**Plan:** `docs/plans/13-mongo.md`

## Summary

The Mongo provider spec describes a DIRECT `LockProvider` using `findOneAndUpdate` with `upsert: true`, `WriteConcern.MAJORITY` / `ReadConcern.MAJORITY`, and duplicate-key (code 11000) mapping to `undefined`. The design faithfully mirrors ShedLock's `MongoLockProvider`. The spec is clear, the locking mechanism is correct, and the plan is executable. A few minor inconsistencies (peer-dep version vs. claimed v5 compatibility, `MongoServerError`-only 11000 detection, a likely-dead `null` guard) should be resolved but do not threaten correctness.

## Vision Alignment

Aligned. The package is framework-agnostic, provider-pluggable, minimal-dependency (`@tslock/core` + `mongodb` peer only), async-native, and type-safe. It uses `Utils.getHostname()`, `ClockProvider.now()`, `Utils.toIsoString()` — all core abstractions. The `findOneAndUpdate` single-round-trip approach matches the vision's "a lock check is a single round-trip" principle. No framework integration, no decorators, no scheduler — pure library.

## Architecture Alignment

Correctly specified as a DIRECT `LockProvider` (Category B, per `01-architecture.md` §6.2). Mongo's `findOneAndUpdate` + upsert does not fit the `StorageBasedLockProvider` insert-then-update pattern, so bypassing `StorageAccessor` is the right call. The `MongoLockProvider implements ExtensibleLockProvider` declaration is correct — extend is implemented via a conditional `findOneAndUpdate`, so `KeepAliveLockProvider` can wrap it.

Package dependency rule compliance: `@tslock/mongo` depends on `@tslock/core` + `mongodb` (peer) only. No dependency on other providers. The `MongoAccessor` / `MongoLock` are internal (not exported), matching the "fewest files" and "no speculative API" principles.

## Spec Completeness

Complete. The spec covers: package metadata, public API (`MongoLockProvider`, `createMongoLockProvider`, `MongoLockProviderOptions`, `MongoLockDocument`), the locking mechanism (lock/extend/unlock with full `findOneAndUpdate` bodies), field semantics, error-handling table, file structure, dependencies, exports, and non-goals. The dual constructor path (raw `Collection` vs. `createMongoLockProvider(db, options)` factory) is well-motivated.

One omission: the spec does not document the `mongodb` driver version compatibility boundary precisely. The Dependencies section says "tested against `^6.0.0`; v5 compatible" but the peer-dep range `^6.0.0` excludes v5 (see Gaps).

## Plan Completeness

Complete and well-ordered. Nine steps: scaffolding → `MongoLockDocument` → `MongoAccessor` → `MongoLock` → `MongoLockProvider` + factory → `index.ts` → unit tests → integration tests → verify. The unit tests cover the four `lock()` outcomes (doc-returned, `null`, `MongoServerError{code:11000}`, non-11000 error), extend, and unlock (including `lockAtLeastFor` honoring). The integration test correctly uses a single-node replica set testcontainer (required for `w: 'majority'`).

The plan's risk table is thorough and addresses the real concerns: v5/v6 API drift, 11000 detection stability, replica-set requirement for `w: 'majority'`, `lockAtLeastFor` honoring via `unlockTime()`.

## Technical Correctness

**`findOneAndUpdate` + upsert — CORRECT.** The filter `{ _id: config.name, lockUntil: { $lte: new Date(now) } }` with `upsert: true` correctly handles all three cases:
- Doc exists, expired (`lockUntil <= now`) → matches → `$set` updates the fields → doc returned → `MongoLock`.
- Doc exists, held (`lockUntil > now`) → no match → upsert attempts INSERT with `_id = config.name` → duplicate-key (11000) because the `_id` already exists → caught → `undefined`.
- Doc absent → no match → upsert INSERT succeeds → doc returned → `MongoLock`.

This is the canonical ShedLock Mongo pattern and it is atomic at the document level.

**Duplicate-key (code 11000) handling — CORRECT with a minor robustness note.** The spec catches `MongoServerError` with `code === 11000`. This is the documented MongoDB duplicate-key code and is stable across server/driver versions. However, the check is `e instanceof MongoServerError && e.code === 11000`. Some driver/server combinations can surface duplicate-key errors as `MongoWriteError` or via the bulk-write error path. A more robust check is `e?.code === 11000` (class-agnostic), which is what ShedLock effectively does. The `findOneAndUpdate` path should always produce `MongoServerError`, so this is a minor robustness gap, not a correctness bug — but the unit test should include a synthetic error with `code: 11000` that is NOT a `MongoServerError` instance to confirm the behavior (or the check should be loosened).

**`extend` — CORRECT.** Filters by `{ _id, lockUntil: { $gt: now }, lockedBy: hostname }` with no upsert. Only the original holder can extend, and only while the lock is still valid. Returns `null` (no match) → `undefined`. No 11000 path (no insert). Correct.

**`unlock` — CORRECT.** Unconditional `findOneAndUpdate` setting `lockUntil = unlockTime(config) = max(now, lockAtLeastUntil(config))`. Honors `lockAtLeastFor`. No filter on `lockedBy` — the holder is trusted (matches ShedLock). A no-op update (zero matched docs) is silent and benign. Correct.

**`WriteConcern.MAJORITY` / `ReadConcern.MAJORITY` — CORRECT.** Matches ShedLock's defaults. The factory allows override via `collectionOptions`. The spec correctly documents that `w: 'majority'` requires a replica set (standalone `mongod` would block indefinitely). Good.

**`returnDocument: 'after'` — CORRECT but slightly confusing rationale.** The spec says it is set "for symmetry; the returned document is not inspected (success is implied by the absence of a duplicate-key error)." This is mostly true: with `upsert: true`, the driver returns the matched-or-inserted doc or throws 11000. The `if (!result) return undefined` guard is therefore likely dead code in practice (the only null-return case is filtered out by upsert semantics or surfaces as 11000). Not a bug — defensive — but the spec should clarify whether a `null` return is actually reachable. If it is not, the guard is harmless cruft.

**Date handling — CORRECT.** `new Date(epochMillis)` produces a BSON `Date` stored as UTC millis. No timezone concern.

## Gaps and Issues

1. **Peer-dep vs. claimed compatibility mismatch.** The spec says "tested against `^6.0.0`; v5 compatible" but declares `peerDependencies: { mongodb: "^6.0.0" }`, which does NOT allow v5. If v5 is genuinely compatible, the peer range should be `^5.0.0 || ^6.0.0` (and the plan should test against both majors in CI). If v5 is NOT supported, drop the "v5 compatible" claim. As written, the spec contradicts itself.

2. **11000 detection is class-bound to `MongoServerError`.** See Technical Correctness. Recommend loosening to `e?.code === 11000` (or adding a `isDuplicateKeyError(e)` helper) and adding a unit test that throws a non-`MongoServerError` object with `code: 11000` to document the behavior.

3. **`if (!result) return undefined` is likely unreachable.** With `upsert: true`, `findOneAndUpdate` either returns the doc (match or insert) or throws 11000. The spec should either document the concrete condition under which `null` is returned, or remove the guard to avoid implying a reachable code path that isn't tested.

4. **No `MongoLockProviderOptions.lockAtMostFor` / `lockAtLeastFor` defaults.** The options only configure collection name and concerns. This is fine (defaults belong to `LockConfiguration`, not the provider), but the spec could state explicitly that the provider does NOT impose minimum/maximum durations — that's the caller's responsibility.

5. **No fuzz-test reference in the plan.** The architecture doc defines `FuzzTester.shouldHandleConcurrentLockAttempts`. The plan calls `lockProviderIntegrationTests` and `extensibleLockProviderIntegrationTests` but does not explicitly name the fuzz test. If the fuzz contract is bundled into `lockProviderIntegrationTests`, state that; otherwise add it.

6. **`createMongoLockProvider` write/read concern merge semantics.** The plan resolves concerns via `{ w: 'majority', ...options?.collectionOptions?.writeConcern }`. If a user passes `{ w: 1 }`, the spread correctly overrides `w` but leaves `j`/`wtimeoutMS` unset. This is fine, but the plan should note that partial overrides (e.g., passing only `{ j: true }`) will NOT inherit `w: 'majority'` because the spread replaces `w` only when the user provides it — actually the spread `{ w: 'majority', ...user }` means user's `w` (if present) overrides, but if the user passes only `{ j: true }`, the result is `{ w: 'majority', j: true }` (correct). So the merge is actually fine. Minor: document this so maintainers don't "fix" it.

## Recommendations

1. Resolve the v5/v6 peer-dep contradiction: either widen the peer range to `^5.0.0 || ^6.0.0` and test both, or drop the v5 claim.
2. Loosen the 11000 check to `e?.code === 11000` and add a unit test for a non-`MongoServerError` 11000.
3. Clarify or remove the `if (!result) return undefined` guard.
4. Explicitly name the fuzz-test contract in the integration test step.
5. Add a README note that `w: 'majority'` requires a replica set (the plan already flags this in Risks — carry it into the README).

## Verdict: APPROVED WITH NOTES

The locking mechanism is correct, the atomic `findOneAndUpdate` + upsert + 11000-mapping pattern is sound, and the plan is executable. The notes are about version-compat documentation, error-class robustness, and a likely-dead guard — none of which affect correctness for the v6 single-node-replica-set happy path.
