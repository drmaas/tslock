# Review: @tslock/test-support

## Summary
The test-support spec and plan provide a solid Vitest-based contract suite adapted from ShedLock's abstract test classes. The test cases (shouldLockOnce, shouldSkipIfLocked, shouldExtendLock, fuzz, etc.) cover the right behaviors. However, the plan adds two options (`timeMode`, `getAccessor`) that are absent from the spec, the fuzz-with-extend concurrency-tracking mechanism is underspecified, and there is no self-test of the factories against `InMemoryProvider`. Ready with notes.

## Vision Alignment
The package directly fulfills vision principle 7 ("Testable: every provider passes the same integration test contract; the `InMemoryProvider` works as a test double") and vision success criterion §8.1 ("Behavioral parity: all providers pass the shared integration test contract"). The contract test names match vision §5.1 ("Integration test contracts (shared abstract test suite) ✓"). Scope is correct — no out-of-scope features leaked in.

## Architecture Alignment
The architecture doc (§7.1) lists abstract test classes: `AbstractLockProviderIntegrationTest`, `AbstractExtensibleLockProviderIntegrationTest`, `AbstractStorageBasedLockProviderIntegrationTest`, `FuzzTester`. The spec correctly adapts these to TypeScript as function-based test factories (TS has no abstract test classes) — `lockProviderIntegrationTests`, `extensibleLockProviderIntegrationTests`, `storageBasedLockProviderIntegrationTests`, `fuzzTests`. The adaptation is idiomatic for Vitest. The test cases listed in architecture §7.1 all appear:
- shouldLockOnce, shouldSkipIfLocked, shouldUnlock, shouldLockAtLeastFor, shouldNotExtendIfNotExtensible ✓
- shouldExtendLock, shouldNotExtendIfExpired ✓
- shouldCreateLockRecord, shouldNotCreateDuplicateRecord, shouldUpdateRecordIfExpired ✓
- shouldHandleConcurrentLockAttempts ✓

Dependency rule (architecture §2, rule 2): `@tslock/test-support` depends on `@tslock/core` + Vitest (dev-only). The spec's Dependencies section and the plan's `package.json` both reflect this. ✓

One minor architecture deviation: the architecture doc names the fuzz entry `shouldHandleConcurrentLockAttempts (N concurrent tasks, exactly one acquires)`. The spec adds a second fuzz test, `shouldHandleFuzzWithExtend`, which is not in the architecture doc's list. This is a useful addition (ShedLock has analogous extend-aware fuzz tests), but the architecture doc should be updated to include it.

## Spec Completeness

### Test factory signatures — defined
All four factory functions have TypeScript signatures with `getProvider: () => Promise<LockProvider>` (or the extensible/storage-based variant). The usage example (import + `describe` block) is clear.

### Test cases — well-specified for the basic contract
`lockProviderIntegrationTests`: shouldLockOnce, shouldSkipIfLocked, shouldUnlock, shouldLockAtLeastFor, shouldNotExtendIfNotExtensible. Each has numbered steps with assertions. The `shouldLockAtLeastFor` test correctly verifies that the lock remains held after `unlock()` until `lockAtLeastUntil` passes, then releases after time advances. The `shouldNotExtendIfNotExtensible` test correctly handles both return-`undefined` and throw-`LockException` outcomes.

`extensibleLockProviderIntegrationTests`: shouldExtendLock, shouldNotExtendIfExpired. Both have correct step-by-step semantics with time advancement.

`storageBasedLockProviderIntegrationTests`: shouldCreateLockRecord, shouldNotCreateDuplicateRecord, shouldUpdateRecordIfExpired. The first two require direct storage verification.

`fuzzTests`: shouldHandleConcurrentLockAttempts (N=50, exactly 1 winner), shouldHandleFuzzWithExtend (20 workers, 5s, ≤1 concurrent holder).

### Helper utilities — present
`config()`, `sleep()`, `cleanupLock()` are defined. Good.

### Gaps in spec
1. **`getAccessor` not in spec.** `shouldCreateLockRecord` ("Verify: lock record exists in storage via `StorageAccessor` or direct query") and `shouldNotCreateDuplicateRecord` ("Attempt insert directly via accessor") both require an accessor. The spec never says how the accessor is provided. The plan adds an optional `getAccessor` parameter to the factory signature — this is a spec/plan inconsistency and a spec gap.
2. **`timeMode` not in spec.** `shouldLockAtLeastFor` step 5 says "Advance ClockProvider by 6s (or wait 6s in real integration tests)". The plan formalizes this as `options.timeMode: 'mock' | 'real'`. The spec should define this option.
3. **`uniqueLockName` not in spec helpers.** The spec's setup section says "Each test uses a unique lock name (UUID or incrementing counter)" but `uniqueLockName()` is not listed under Helper Utilities. The plan adds it. Spec gap.
4. **Fuzz-with-extend tracking mechanism.** `shouldHandleFuzzWithExtend` asserts "no more than 1 concurrent lock holder at any time" but doesn't specify how concurrent holders are counted. Need a shared counter incremented on acquisition, decremented on release, with a max tracker. Underspecified.
5. **Fuzz extensibility detection.** `fuzzTests(getProvider: () => Promise<LockProvider>)` has no way to know whether the provider is extensible. `shouldHandleFuzzWithExtend` is "extensible providers only" — but the factory signature doesn't distinguish. Need either a separate `extensibleFuzzTests` function or an `extensible: true` option.
6. **Mock time advancement mechanism.** "Advance ClockProvider by 6s" implies a mutable clock. `ClockProvider.setClock(() => fixedTime)` sets a fixed time, not an advancing one. The spec doesn't show how to "advance" — e.g., a `advanceTime(ms)` helper backed by a mutable offset. Underspecified.
7. **`cleanupLock` when lock is held.** The spec says "Best-effort lock cleanup — acquires and releases the lock with lockAtLeastFor=0." If the lock is held by another instance, acquisition fails (returns `undefined`) and `cleanupLock` can't release it. Should it wait? Retry? Skip? The spec doesn't say.
8. **`shouldCreateLockRecord` without accessor.** If `getAccessor` is optional (per plan), what does `shouldCreateLockRecord` do when it's absent? Skip? The plan says "skip record-verification tests" but the spec doesn't acknowledge this fallback.
9. **No self-test of the factories.** The `__tests__/` directory only has `helpers.test.ts`. There's no test that runs `lockProviderIntegrationTests` against `InMemoryProvider` to verify the factories themselves work. This is a meaningful gap — the factories are only exercised when a provider package uses them, so a bug in the factory would surface late.

## Plan Completeness

### Step coverage — all spec items present
All four factories → Steps 3–6. Helpers → Step 2. `index.ts` → Step 7. Helper tests → Step 8. Verify → Step 9. Package init → Step 1.

### Plan additions beyond spec — all reasonable, but create inconsistency
1. `options.timeMode?: 'mock' | 'real'` (Step 3) — good solution to the mock/real time split, but not in spec.
2. `options.getAccessor?: () => Promise<StorageAccessor>` (Step 5) — good solution to the accessor-access problem, but not in spec.
3. `uniqueLockName(prefix?)` helper (Step 2) — not in spec helpers list.
4. Fuzz `shouldHandleFuzzWithExtend` "only call if provider is extensible" (Step 6) — but no mechanism shown for detecting extensibility.

These are all sensible additions that the plan correctly identifies as needed. The problem is the spec didn't specify them, so the plan is effectively writing spec during implementation. Recommend backfilling the spec.

### Test approach — thin
Only `helpers.test.ts` (tests `config()`, `sleep()`, `uniqueLockName()`). No test for `cleanupLock()`. No self-test of the factories against `InMemoryProvider`. As noted above, this is a gap — the factories themselves need a smoke test.

### Risks — identified
The risk table covers mock/real time confusion, fuzz flakiness, accessor access, slow integration tests. The "Storage-based tests need accessor access" mitigation ("Make `getAccessor` optional — if not provided, skip record-verification tests") weakens the contract: a provider could skip `shouldCreateLockRecord` and `shouldNotCreateDuplicateRecord` entirely. Consider making `getAccessor` required for storage-based providers, since record verification is the whole point of the storage-based contract.

### Estimation — reasonable
"~5 files, ~400-600 lines, quick to build after core is done" is plausible.

### Spec/plan inconsistencies
1. `timeMode` option — plan adds, spec doesn't define.
2. `getAccessor` option — plan adds, spec doesn't define.
3. `uniqueLockName` helper — plan adds, spec helpers list doesn't include.
4. `package.json` scripts — plan's `package.json` has only `build` and `typecheck` scripts, but Step 9 says `pnpm test`. Missing `test` script.
5. `devDependencies` — plan lists `vitest` and `typescript` but omits `tsup` and `@types/node`, both needed (the package uses tsup.config.ts and `node:async_hooks`-adjacent types via core). Minor.

## Technical Correctness

### Mock vs real time — correctly handled in concept
For `InMemoryProvider`, advancing `ClockProvider` works because the provider reads `ClockProvider.now()`. For real backends, the lock record's `lockUntil` is stored in the DB; advancing the app clock doesn't move the DB's `lockUntil`, and with `useDbTime` the DB clock is authoritative. The plan's `timeMode: 'real'` (default) correctly uses `sleep()`. Good.

### Fuzz concurrency — correct for the basic case
`Promise.all(Array.from({ length: 50 }, () => provider.lock(...)))` launches 50 concurrent attempts. In Node.js these interleave at `await` points; the storage layer's atomicity guarantees exactly one winner. For `InMemoryProvider` (single-threaded), the attempts serialize and exactly one wins. Correct.

### Fuzz-with-extend — underspecified tracking
The plan says "Track max concurrent holders, assert <= 1 at any time" but doesn't show the tracking structure. A correct implementation needs:
```typescript
let current = 0, max = 0;
// on acquire: current++; max = Math.max(max, current)
// on release: current--
```
But this has a subtlety: the increment must happen synchronously after `lock()` resolves and before any `await`, or the counter can miss overlapping hold windows. The spec/plan should specify this.

### `cleanupLock` — best-effort is fragile
If the lock is held by another instance, `cleanupLock` returns without releasing. This is fine for teardown of tests that already unlocked, but if a previous test crashed leaving a lock held, `cleanupLock` won't clear it. Consider: acquire with a very short `lockAtMostFor` (e.g., 1s) and `lockAtLeastFor=0`, wait for expiry, then proceed. Or just document that `cleanupLock` is best-effort and tests should use unique names to avoid interference (which the spec already recommends).

### `shouldNotExtendIfNotExtensible` — correct
Handles both return-`undefined` and throw-`LockException` outcomes, and handles the case where the lock is invalidated by a failed extend. Matches the core spec's `AbstractSimpleLock` contract.

### `shouldLockAtLeastFor` step 5 — ambiguous
"Advance ClockProvider by 6s (or wait 6s in real integration tests)" — the "advance" verb implies a mutable clock, but `ClockProvider.setClock(fn)` replaces the clock function, it doesn't advance it. A correct mock-time helper needs an internal offset:
```typescript
let t = Date.now();
ClockProvider.setClock(() => t);
function advanceTime(ms: number) { t += ms; }
```
The spec should define this helper (or note that `timeMode: 'mock'` provides it).

## Gaps and Issues
- `getAccessor` option in plan but not spec — spec/plan inconsistency.
- `timeMode` option in plan but not spec — spec/plan inconsistency.
- `uniqueLockName` helper in plan but not in spec helpers list.
- `shouldHandleFuzzWithExtend` concurrent-holder tracking mechanism underspecified.
- No extensibility detection mechanism for `fuzzTests` to conditionally run `shouldHandleFuzzWithExtend`.
- Mock time advancement helper (`advanceTime`) not defined in spec.
- `cleanupLock` behavior when lock is held by another instance — unspecified.
- No self-test of the test factories against `InMemoryProvider` — meaningful gap.
- `package.json` missing `test` script (plan Step 9 runs `pnpm test`).
- Plan `devDependencies` omit `tsup` and `@types/node`.
- `shouldCreateLockRecord`/`shouldNotCreateDuplicateRecord` skip-behavior when `getAccessor` absent weakens the storage-based contract.
- Architecture doc doesn't list `shouldHandleFuzzWithExtend` — update architecture.

## Recommendations
- Backfill spec with `options: { timeMode?: 'mock' | 'real'; getAccessor?: () => Promise<StorageAccessor> }` on the relevant factory signatures. One paragraph each.
- Add `uniqueLockName(prefix?: string): string` to spec Helper Utilities.
- Add `advanceTime(ms: number): void` helper (or specify that `timeMode: 'mock'` installs a mutable clock with this helper) to spec.
- Specify the fuzz-with-extend concurrent-holder tracking: a shared `{ current: number; max: number }` mutated synchronously after `lock()` resolves and after `unlock()`.
- Split `fuzzTests` into `fuzzTests(getProvider)` (non-extensible) and `extensibleFuzzTests(getProvider)` (extensible), OR add `options.extensible: boolean` to conditionally include `shouldHandleFuzzWithExtend`. Prefer the split — clearer at call sites.
- Add a self-test `__tests__/factories.test.ts` that runs `lockProviderIntegrationTests` against `InMemoryProvider` with `timeMode: 'mock'` to smoke-test the factories.
- Decide: is `getAccessor` required for storage-based providers? Recommend YES — record verification is the point of the storage-based contract. If optional, document which tests are skipped.
- Add `test` script to `package.json`; add `tsup` and `@types/node` to `devDependencies`.
- Update architecture §7.1 to include `shouldHandleFuzzWithExtend`.

## Verdict: APPROVED WITH NOTES
