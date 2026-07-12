# Review: @tslock/in-memory

**Spec:** `docs/specs/22-inmemory.md`
**Plan:** `docs/plans/22-inmemory.md`

## Summary

The InMemory provider implements a DIRECT `ExtensibleLockProvider` backed by a plain `Map<string, number>` (name → lockedUntilEpochMillis). It is the simplest provider: no driver, no network, no container. It supports `extend()` (the only DIRECT-category provider that does). The spec and plan are clean, correct, and well-documented. The test/local-only caveat is prominently displayed. This is the reference implementation that the shared integration test contracts must pass.

## Vision Alignment

**Aligned.** Vision §6.6 lists InMemory with `Map<string, LockRecord>` with synchronized access, package `@tslock/in-memory`, "Usage: Testing and local development only. Not for production distributed locking." The spec matches — `Map<string, number>` (the architecture's simpler representation), test/local-only warning prominent. Vision §4.7 "Testable: Every provider passes the same integration test contract. The `InMemoryProvider` works as a test double" — the spec positions this provider exactly as the test double, and the plan runs both `lockProviderIntegrationTests` and `extensibleLockProviderIntegrationTests` against it with mock clock.

Note: Vision §6.6 says `Map<string, LockRecord>` while Architecture §6.9 says `Map<string, number>`. The spec follows the architecture (`number`). This is a minor vision/architecture wording mismatch, not a spec issue — the architecture's `number` (lockedUntilEpochMillis) is the actual implementation; the vision's `LockRecord` is a higher-level description. No action needed.

## Architecture Alignment

**Correct as DIRECT LockProvider implementing ExtensibleLockProvider.** Architecture §6.9 states: "Plain `Map<string, number>` (name → lockedUntilEpochMillis). Synchronized access not needed (single-threaded event loop). Implements `ExtensibleLockProvider`. Test/local only." The spec implements `ExtensibleLockProvider` directly — correct. The in-process Map-based check-and-set does not fit `StorageAccessor` (no insert/update/unlock/extend split; it's a single `isLocked` + `set`).

The spec correctly notes that `Map` operations are synchronous and atomic, and the `isLocked()` + `locks.set()` in `lock()` has no `await` between them — so no async interleaving breaks the check-then-set. This matches Architecture §12 (Threading & Concurrency Model).

## Spec Completeness

**Complete.** Covers: package metadata, public API (`InMemoryLockProvider` + `createInMemoryLockProvider` factory, `InMemoryLock`), state representation, `isLocked()`, full `lock()`/`doUnlock()`/`doExtend()` pseudocode, thread-safety analysis, error-handling table (9 scenarios), file structure, dependencies (no driver, no testcontainers), exports, and non-goals. The test/local-only caveat is a prominent warning blockquote in the overview. The `doExtend` implementation is the only one among the 6 DIRECT providers and is well-specified.

## Plan Completeness

**Complete.** 7 steps (appropriately fewer than the network providers — no container, no driver). The plan handles the circular dependency between `InMemoryLock` and `InMemoryLockProvider` via `import type` (type-only import in the lock, runtime import in the provider). Unit tests cover lock/unlock/extend with mock clock. Contract tests run `lockProviderIntegrationTests`, `extensibleLockProviderIntegrationTests`, and `fuzzTests` with `timeMode: 'mock'` (no Docker, no real-time waits). The plan correctly identifies this provider as "the reference implementation that the contract suite must pass — if it fails here, the contract is wrong."

## Technical Correctness

**Is the Map-based lock correct?** Yes.
- `isLocked(name)`: `locks.has(name) && locks.get(name) > ClockProvider.now()`. A lock is held iff the key exists AND its `lockedUntil` is in the future. Stale entries (past `lockedUntil`) are treated as not-locked. Correct.
- `lock(config)`: if `isLocked` → return `undefined`; else `locks.set(name, lockAtMostUntil(config))` → return `InMemoryLock`. The check-and-set is synchronous (no `await` between), so no interleaving. Correct.
- `doUnlock()`: `locks.set(name, lockAtLeastUntil(config))`. If `lockAtLeastFor = 0`, sets to `createdAt` (past) → `isLocked` returns false → effectively released. If `lockAtLeastFor > 0`, sets to future → held until `lockAtLeastUntil`. The entry is NOT deleted (becomes stale, overwritten by next `lock()`). This avoids a delete-then-set race and matches ShedLock. Correct.
- `doExtend(newConfig)`: if `isLocked(newConfig.name)` → `locks.set(name, lockAtMostUntil(newConfig))` → return new `InMemoryLock`. If expired → return `undefined`. Correct — cannot extend a lock we no longer hold.

**Does it implement ExtensibleLockProvider?** Yes. The class declaration is `class InMemoryLockProvider implements ExtensibleLockProvider`. `InMemoryLock` overrides `doExtend` (not just inheriting the throwing default). This is the only DIRECT-category provider that supports extend. Correct and aligns with Architecture §6.9.

**Is the test/local-only caveat documented?** Yes, prominently. The overview has a warning blockquote: "Test / local development only — NOT for production distributed locking. This provider locks only within a single Node.js process. Multiple instances of your application will each have their own `Map` and will NOT coordinate." The Non-Goals section reinforces: "NOT for production distributed locking. No cross-process coordination. No persistence. No cross-process visibility." The plan's risk table includes "Users mistake this for a distributed lock → Document prominently in the spec, README, and JSDoc on the class."

**Thread safety analysis is correct.** The spec's §"Thread Safety" correctly explains: Node.js is single-threaded, `Map` operations are synchronous and atomic, no `await` between `isLocked()` and `locks.set()` in `lock()`, so no interleaving. This matches Architecture §12. The comparison to ShedLock's `ConcurrentHashMap` is apt — ShedLock uses a thread-safe map because Java is multi-threaded; TSLock uses a plain `Map` because Node.js is single-threaded. Correct.

**`doExtend` returns a new `InMemoryLock` sharing the same provider.** The new lock references the same `Map`, so `unlock()` on the extended lock updates the same entry. The plan's risk table verifies this. Correct — `AbstractSimpleLock.extend()` sets the original lock's `valid = false`, so only the new lock can be unlocked.

**Minor — `locks` and `isLocked` visibility.** The plan keeps `locks` and `isLocked` public (TypeScript default) for package-internal access from `InMemoryLock`, relying on "not exported from `index.ts`" for encapsulation. This is a reasonable approach — external consumers cannot reach them via the public API. An alternative would be a `#private` field with a package-internal accessor, but that would require a shared internal module. The current approach is simpler and matches the "fewest files" principle. Acceptable.

**Minor — stale entry accumulation.** Stale entries (past `lockedUntil`) accumulate in the `Map`, bounded by the number of distinct lock names. The plan notes "Not a leak in practice. Matches ShedLock. No cleanup needed." Correct — lock names are typically low-cardinality (task names).

## Gaps and Issues

1. **No significant issues.** The spec and plan are clean, correct, and well-documented.
2. **Minor — `locks`/`isLocked` encapsulation** relies on convention (not exported from `index.ts`), not enforcement. Acceptable for a test-double provider. A JSDoc `@internal` tag would make the intent explicit.
3. **Minor — no `#private` fields.** The plan uses public fields for package-internal access. This is pragmatic but means a careless same-package developer could access them. Low risk given the 2-file scope.
4. **Vision/architecture wording mismatch** — Vision §6.6 says `Map<string, LockRecord>` while Architecture §6.9 says `Map<string, number>`. The spec follows the architecture. Not a spec issue, but the vision could be updated for consistency.

## Recommendations

1. **Add `@internal` JSDoc tags** to `locks` and `isLocked` to signal package-internal intent, even though they are public by default.
2. **Update Vision §6.6** to say `Map<string, number>` for consistency with Architecture §6.9 and the spec. (Doc-level fix, not a spec/plan issue.)
3. **No other changes needed.** The spec and plan are implementation-ready.

## Verdict: APPROVED

The InMemory provider is the simplest and most correct of the six reviewed. The Map-based lock, `ExtensibleLockProvider` implementation with `doExtend`, thread-safety analysis, and prominent test/local-only caveat are all correct and well-documented. The plan handles the circular dependency cleanly and runs the full contract suite (including `extensibleLockProviderIntegrationTests` and `fuzzTests`) with mock clock. No structural, architectural, or technical issues. Implementation-ready as written.
