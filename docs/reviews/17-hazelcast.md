# Review: @tslock/hazelcast

**Spec:** `docs/specs/17-hazelcast.md`
**Plan:** `docs/plans/17-hazelcast.md`

## Summary

The Hazelcast provider implements a DIRECT `LockProvider` using a two-tier algorithm: an entry-level pessimistic `IMap.lock(key, ttl)` serializes access to a lock name, then a get-check-put sequence inside that critical section writes the lock record with a per-entry TTL of `lockAtMostFor`. This faithfully matches the ShedLock `HazelcastLockProvider` shape. The spec and plan are thorough, well-structured, and technically sound on the core algorithm. One concrete code-level issue (the `finally`-block `store.unlock()` is not guarded) and one design deviation (blocking `lock()` vs ShedLock's `tryLock`) need attention before implementation.

## Vision Alignment

**Aligned.** Vision §6.5 specifies Hazelcast with "IMap with TTL" mechanism, `hazelcast-client` driver, package `@tslock/hazelcast`. The spec uses exactly this driver and mechanism. Vision §4 principle "Provider-pluggable, minimal dependencies" is honored: peer-dep on `hazelcast-client` + `@tslock/core` only. Vision §2 "Non-blocking" property is addressed below (see Technical Correctness) — the entry-level critical section blocks briefly but this is not "waiting for the distributed lock."

## Architecture Alignment

**Correct as DIRECT LockProvider.** Architecture §6.4 states Hazelcast "Uses `IMap` with entry-level TTL. Locks the store entry, checks/updates the lock record, unlocks the store entry. Different from `StorageBasedLockProvider` because it uses Hazelcast's `EntryProcessor` / `lock`/`tryLock` semantics." The spec implements `LockProvider` directly (not `StorageBasedLockProvider`) — correct. The two-tier entry-lock-then-put pattern does not fit the `StorageAccessor` insert/update/unlock/extend four-method contract.

The architecture mentions `EntryProcessor` as an option; the spec's Non-Goals explicitly defers it ("No `EntryProcessor`-based acquisition: the entry-level lock + get-check-put pattern is simpler and matches ShedLock"). This is a valid, defensible simplification.

## Spec Completeness

**Complete.** Covers: package metadata, public API (`HazelcastLockProvider`, options, `HazelcastLock`, `HazelcastLockRecord`, `HazelcastAccessor`), full `lock()`/`unlock()` pseudocode with field semantics, error-handling table (11 scenarios), file structure, dependencies, exports, and non-goals. The `lockLeaseTimeMs` option (safety net for entry-level lock during unlock) is well-documented with a clear rationale for the 30s default.

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification, with `package.json`, `tsup.config.ts`, options resolver, accessor implementation, lock, provider, index exports, unit tests (mocked `IMap` with concrete mock code), integration tests (Hazelcast testcontainer with Docker image `hazelcast/hazelcast:5.3.0`), and a 10-row risk table. The unit test section asserts exact `store.lock`/`put`/`get`/`remove`/`unlock` call args and TTL values — good rigor.

## Technical Correctness

**Is IMap lock + put with TTL correct?** Yes. `store.lock(name, keyLockTimeMs, MILLISECONDS)` → `store.get` → `store.put(name, record, lockAtMostFor)` → `store.unlock(name)` is the correct ShedLock algorithm. The per-entry TTL on `put` is `lockAtMostFor` (millis), which auto-evicts the lock record if the holder crashes. The entry-level lock TTL (`keyLockTimeMs = lockUntil - now`) bounds how long a crashed member can block the critical section.

**Is the entry-level lock pattern correct?** The serialization is correct: only one member holds the entry-level lock at a time, so the get-check-put is atomic. The three branches (no entry → addNewLock; expired → replaceLock; still held → return undefined) are correct.

**Issue 1 — `finally`-block `store.unlock()` is not guarded in `lock()`.** The spec's `lock()` pseudocode:
```typescript
try {
  await store.lock(config.name, keyLockTimeMs, TimeUnit.MILLISECONDS);
  // ... get-check-put ...
} finally {
  await store.unlock(config.name);  // NOT wrapped in try/catch
}
```
If `store.lock()` throws (connection lost, cluster down), the `finally` block calls `store.unlock()` on a lock we do not hold → Hazelcast throws `IllegalMonitorStateException`, which **masks the original connection error**. The spec's own error-handling table acknowledges this case ("`store.unlock` called without a matching `store.lock` → Hazelcast throws `IllegalMonitorStateException`. Wrap in try/catch and log a warning") but the `lock()` code does not implement the mitigation. The plan's Step 3 for `unlock()` correctly wraps the finally-unlock in `try/catch`, but Step 3 for `lock()` does not. **This is inconsistent and should be fixed** — both finally blocks need the same guard, or a `locked` boolean flag should gate the unlock.

**Issue 2 — Blocking `store.lock()` vs ShedLock's `tryLock`.** The spec uses `await store.lock(name, ttl, TimeUnit.MILLISECONDS)` — a **blocking** call. ShedLock's Java `HazelcastLockProvider` uses `tryLock(name, 0, SECONDS, leaseTime, MILLISECONDS)` — a **non-blocking** attempt (0 wait time). If the entry-level lock is held, ShedLock immediately returns "not acquired"; the spec blocks until the entry-level lock is released (bounded by `keyLockTimeMs`). The end result is the same (one winner, others skip), but the spec's approach waits milliseconds under contention while ShedLock skips immediately. This is arguably **better** (the blocking version correctly acquires a free lock that is briefly contended, while ShedLock's tryLock might incorrectly skip), but it is a deviation from ShedLock's algorithm and should be explicitly documented as an intentional design choice. The spec does not mention this deviation.

**Minor — `lockAtMostFor = 0`.** If `lockAtMostFor = 0`, then `keyLockTimeMs = 0`. Hazelcast's behavior for a 0-TTL entry-level lock should be documented (does it auto-release immediately, or is 0 treated as "no TTL"?). The spec does not address this edge case.

## Gaps and Issues

1. **`lock()` finally-block unlock not guarded** — can mask original errors if `store.lock()` failed. Fix: wrap `store.unlock()` in `try/catch` (matching `unlock()`'s finally block) or gate with a `locked` boolean.
2. **Blocking `store.lock()` vs `tryLock`** — undocumented deviation from ShedLock. Add a design-note explaining the choice.
3. **`hazelcast-client` v5 API verification** — `store.put(key, value, ttlMillis)` (3-arg, millis) and `store.lock(key, ttl, TimeUnit)` signatures need confirmation against the actual Node.js client. The plan flags this as a risk; integration tests will catch drift.
4. **`lockAtMostFor = 0` edge case** — behavior of 0-TTL entry-level lock is unspecified.
5. **No `lockAtLeastFor` validation against `lockAtMostFor`** — core `createLockConfig()` handles this, but the spec does not restate it. Minor.

## Recommendations

1. Fix the `lock()` finally block to wrap `store.unlock()` in `try/catch` with a warning log, consistent with `unlock()`'s finally block.
2. Add a design note explaining the blocking `store.lock()` choice vs ShedLock's `tryLock`.
3. Document the `lockAtMostFor = 0` edge case (or add a minimum-`lockAtMostFor` validation).
4. Confirm `hazelcast-client` v5 `IMap.lock` and `IMap.put` TTL signatures before implementation; the integration test is the safety net.

## Verdict: APPROVED WITH NOTES

The core algorithm (entry-level lock + get-check-put + per-entry TTL) is correct and faithfully matches ShedLock. The `finally`-block unlock guard is a concrete fix that should be applied before or during implementation. The blocking-vs-`tryLock` deviation is defensible but should be documented. No structural or architectural issues — the spec and plan are implementation-ready with the notes above addressed.
