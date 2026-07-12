# Review: @tslock/core

## Summary
The core spec and plan are a thorough, faithful port of ShedLock's core abstractions to async-native TypeScript. The type signatures, one-shot lock semantics, reentrancy model, and `AsyncLocalStorage` adaptation are well-specified. However, several behaviors are underspecified (`KeepAliveLock.remainingLockAtLeastFor`, `TrackingSimpleLock.extend()` invalidation), the `Scheduler` interface is defined twice with divergent return types, and the plan's reliance on `AsyncLocalStorage.enterWith()` for `makeAllAssertsPass` is a known-deprecated API path. Ready with notes.

## Vision Alignment
The spec follows all six design principles from `00-vision.md`:
- **Framework-agnostic**: no framework imports; pure TS abstractions. ✓
- **Minimal dependencies**: `package.json` declares zero runtime deps, dev-only `typescript`/`tsup`/`vitest`/`@types/node`. ✓
- **Type-safe**: full TS signatures; no `any` in public API. ✓
- **Async-native**: all lock ops return `Promise`; `AsyncLocalStorage` replaces `ThreadLocal` (vision §7, principle 5). ✓
- **Familiar API**: every ShedLock abstraction (`LockProvider`, `SimpleLock`, `LockConfiguration`, `LockingTaskExecutor`, `LockAssert`, `LockExtender`, `KeepAliveLockProvider`, `TrackingLockProviderWrapper`) is present. ✓
- **Testable**: `ClockProvider.setClock()`/`resetClock()`, injectable `Scheduler`, `LockAssert.TestHelper.makeAllAssertsPass`. ✓

Scope is correct: in-scope items (vision §5.1) all appear; out-of-scope items (decorators, scheduler, metrics framework) are correctly excluded and listed under Non-Goals. One scope note: the `StorageBasedLockProvider` + `StorageAccessor` support layer is included in `@tslock/core`. This matches the architecture doc (§4.1) but means core carries the storage-provider workhorse — a reasonable consolidation, not a violation.

## Architecture Alignment
The spec is largely consistent with `01-architecture.md`:
- `LockConfiguration`, `SimpleLock`, `AbstractSimpleLock`, `LockProvider`, `ExtensibleLockProvider`, `LockingTaskExecutor`, `TaskResult`, `LockingTaskExecutorListener`, `LockAssert`, `LockExtender`, `KeepAliveLockProvider`, `StorageBasedLockProvider`, `StorageAccessor`, `LockRecordRegistry`, `TrackingLockProviderWrapper`, `Utils`, `ClockProvider`, `LockException` — all present with matching signatures.
- Dependency rule (core = zero runtime deps) is honored.

Deviations from the architecture doc (all defensible, but should be acknowledged):
1. **Builder pattern dropped.** Architecture §3.2 shows `lockConfig('my-task').atMostFor('30m').atLeastFor('5s').build()` as the "recommended" helper. The spec only offers `createLockConfig(name, lockAtMostFor, lockAtLeastFor?)`. This actually aligns with vision §12 ("Config API: Plain object + parseDuration() — No builder class"), so the spec is correct and the architecture doc's builder snippet is the outlier. Recommend updating the architecture doc to remove the builder example.
2. **`StorageBasedLockProvider.clearCache(name)` is public.** Architecture §4.1–4.2 shows `lockRecordRegistry` as a private field of `StorageBasedLockProvider`. The spec exposes `clearCache(name)` as a public method on the provider. This is a broader public API surface than the architecture doc described. It's useful (providers may need to clear cache on schema changes), but it's a deviation that should be reconciled.
3. **`ClockProvider.resetClock()` added.** Not in architecture §3.4, but a sensible testability addition.

## Spec Completeness

### Public API types — well-defined
All 19 sections have full TypeScript signatures. The `LockConfiguration` interface, `SimpleLock` contract, `AbstractSimpleLock` base class, `LockingTaskExecutor` overloads, `TaskResult` namespace with factories, `LockingTaskExecutorListener`, `LockAssert` + `TestHelper` namespace, `LockExtender`, `KeepAliveLockProvider`, `StorageAccessor`/`StorageBasedLockProvider`/`LockRecordRegistry`, `TrackingLockProviderWrapper`, `Utils`, `ClockProvider`, `LockException` hierarchy, `SimpleLockWithConfiguration`, `Scheduler`/`DefaultScheduler` — all have signatures.

### Locking mechanism — clearly specified
The `StorageBasedLockProvider.lock()` algorithm (§13) is spelled out step-by-step with the insert-then-update pattern, `justInserted` cache-clearing on exception, and `StorageLock` inner class delegating `doUnlock`/`doExtend` to the accessor. Matches ShedLock semantics.

### One-shot lock semantics — correct
The `valid` flag in `AbstractSimpleLock` is correctly specified: `unlock()` and `extend()` both call `checkValidity()` then set `valid = false` after `doUnlock`/`doExtend`. The contract explicitly states double-`unlock()` throws and `extend()`-then-`unlock()`-on-original throws. Good.

### Error handling — complete
The Error Handling Summary table (§17) covers all eight cases. The exception hierarchy (`LockException` → `NoActiveLockException`, `LockCanNotBeExtendedException`) matches architecture §9.1.

### Edge cases — mostly covered
- One-shot lock: covered (valid flag).
- Reentrancy: covered (`LockAssert.alreadyLockedBy` check in `DefaultLockingTaskExecutor` step 1).
- Extend failures: covered (`extend()` returns `undefined`; `LockExtender` throws `LockCanNotBeExtendedException`).
- `lockAtLeastFor` honored: covered via `unlockTime()` = `max(now, lockAtLeastUntil)`.

### Edge cases — gaps
- **`KeepAliveLock.remainingLockAtLeastFor` lifecycle is unspecified.** §12 says `extend(lockAtMostFor, remainingLockAtLeastFor)` but never defines how `remainingLockAtLeastFor` is initialized or decremented across extend cycles. ShedLock initializes it to `config.lockAtLeastFor` and decrements by the extend interval. The spec omits this.
- **`TrackingSimpleLock.extend()` semantics.** §14 says the wrapper "removes itself from the set on `unlock()`" and "uses a boolean flag to ensure `unlock()` is only called once". It does NOT say what `extend()` does to the wrapper's membership in `activeLocks`. If `extend()` returns a new `SimpleLock`, is it wrapped in a new `TrackingSimpleLock`? Does the old wrapper stay in the set? The plan says "delegate to wrapped lock, wrap result" but doesn't address set membership. This is underspecified.
- **`parseDuration` edge cases.** §2 doesn't specify behavior for negative numbers, `0`, empty object `{}`, or strings like `"0s"` / `"0"`. Are these valid? Do they throw?
- **`DefaultLockingTaskExecutor` reentrancy case.** §8 step 1 says reentrancy emits only `onTaskStarted`/`onTaskFinished`. The listener contract should document that `onLockAttempt`/`onLockAcquired`/`onLockNotAcquired` are NOT emitted in the reentrancy path — metrics users will be surprised otherwise.

### File structure — clear
The 16-file `src/` layout and 11-file `__tests__/` layout are sensible and map 1:1 to the API sections.

## Plan Completeness

### Step coverage — all spec items covered
All 19 API sections map to a plan step:
- §1 LockConfiguration → Step 6
- §2 Duration → Step 5
- §3–4 SimpleLock/AbstractSimpleLock → Step 7
- §5–6 LockProvider/ExtensibleLockProvider → Step 8
- §7–8 LockingTaskExecutor/DefaultLockingTaskExecutor → Step 12
- §9 Listener → Step 11
- §10 LockAssert → Step 9
- §11 LockExtender → Step 10
- §12 KeepAliveLockProvider → Step 14
- §13 StorageBasedLockProvider → Step 15
- §14 TrackingLockProviderWrapper → Step 16
- §15 Utils → Step 4
- §16 ClockProvider → Step 3
- §17 LockException → Step 2
- §18 SimpleLockWithConfiguration → Step 17
- §19 Scheduler → Step 13
- index.ts → Step 18, tests → Step 19, verify → Step 20.

### Ordering — logical
The "Order of Implementation" section (§373–384) correctly bottom-up: exception/clock/utils → duration/config → simplelock/provider → assert/extender → executor → scheduler/keepalive → storage → tracking → index → tests. Dependencies respected.

### Test approach — adequate
11 test files covering all modules. The `abstract-simple-lock.test.ts` covers one-shot semantics, the `default-locking-task-executor.test.ts` covers reentrancy + listener errors, the `keep-alive-lock-provider.test.ts` uses fake timers, the `storage-based-lock-provider.test.ts` mocks the accessor and covers the `justInserted` cache-clear path. Good coverage.

### Risks — identified but some mitigations weak
The risk table covers `AsyncLocalStorage` edge cases, `enterWith` vs `run`, KeepAliveLock races, registry interleaving, `performance.now()`. However:
- The `enterWith` mitigation ("Research Node.js docs; prefer `run()` where possible") is vague and the plan's own decision (Step 9) commits to `enterWith` anyway. Node.js docs explicitly state `enterWith` "may be deprecated" and recommend `run()`. This is a real risk that needs a concrete decision, not a deferred one.
- The KeepAliveLock race mitigation ("Single-threaded event loop makes `active` flag safe") is too optimistic — see Technical Correctness below.

### Estimation — reasonable
"~15-20 files, ~800-1200 lines impl + ~600-800 lines tests, one focused session" is plausible for an experienced implementer. The 11 test files alone may push past 800 lines.

### Spec/plan inconsistencies
1. **`runWithLock` internal methods.** Plan Step 12 introduces internal `runWithLock(name, lock, callback)` methods on `LockAssert`/`LockExtender` to avoid exporting `storage`. The spec only mentions `startLock`/`endLock`. The plan's approach is cleaner but is an addition not reflected in the spec.
2. **`LockAssert.TestHelper.makeAllAssertsPass` implementation.** Spec §10 says "`true` pushes a sentinel, `false` pops it". Plan Step 9 has a long deliberation and commits to `enterWith` — but doesn't show the final code shape. The spec's `namespace LockAssert { namespace TestHelper { ... } }` syntax needs care in TS (requires `export` inside the namespace, and `declare namespace` merging for the class+namespace pattern).

## Technical Correctness

### AsyncLocalStorage usage — correct
- `LockAssert` uses `AsyncLocalStorage<string[]>` (stack of names) — correct.
- `LockExtender` uses `AsyncLocalStorage<SimpleLock[]>` (stack of locks) — correct.
- `DefaultLockingTaskExecutor` wraps the task in nested `storage.run(stack, ...)` calls for both stores — correct. The context propagates through `await` chains within the task but not to sibling async operations outside the task, which is the desired semantic.
- `alreadyLockedBy(name)` checks `store.includes(name)` — correct for reentrancy detection.

### Reentrancy model — correct
Same-name reentrant calls within the same async context skip lock acquisition. Cross-context attempts to acquire a held lock return `undefined`. Matches ShedLock and vision §5.3.

### One-shot semantics — correct, with one subtle consequence
`AbstractSimpleLock.extend()` sets `valid = false` on `this` even when `doExtend()` returns `undefined` (extend failed at storage layer). This means the caller cannot call `unlock()` on the original lock after a failed extend — the lock is orphaned until `lockAtMostFor` expires. This matches ShedLock's behavior, but it should be documented explicitly in the spec's error-handling table (currently only "extend() fails → return undefined" is listed; the side-effect of invalidating the original lock is not called out).

### `enterWith` concern — real
`AsyncLocalStorage.enterWith()` is documented in Node.js as: "Most use cases should use `AsyncLocalStorage.run()` instead." It mutates the current context without a callback boundary, which can leak into parent continuations. For `makeAllAssertsPass`, the test helper needs push/pop semantics that survive across `await` points in test code. `run()` requires a callback, which doesn't fit the push/pop API shape. Options:
- Redesign `makeAllAssertsPass` to return a disposable/teardown function (push returns `() => pop()`).
- Use `enterWith`/`disable` pair and accept the deprecation risk.
The plan defers this decision. It should be made before implementation.

### KeepAliveLock race — understated
The plan claims "No race condition" for `extendForNextPeriod` vs `doUnlock`. Consider this interleaving:
1. Interval fires → `extendForNextPeriod()` checks `active` (true) → enters `await lock.extend(...)`.
2. Caller invokes `doUnlock()` → sets `active = false`, clears interval, `await lock.unlock()` (succeeds).
3. The in-flight `lock.extend(...)` from step 1 resolves with a new lock → `extendForNextPeriod` resumes, tries to "update internal lock reference" on a lock that was just unlocked.

The new lock object from step 3 is now orphaned (never tracked, never unlocked) and the underlying storage record was just extended by the backend even though the user called `unlock()`. The `active` flag check at the top of `extendForNextPeriod` is insufficient — it must be re-checked AFTER the `await lock.extend(...)` resolves, before mutating internal state. The spec/plan should require a post-await `active` re-check.

### `LockRecordRegistry` interleaving — correctly acknowledged
The spec and plan both acknowledge that `lockRecordRecentlyCreated` can change between check and use. This is acceptable because the registry is an optimization; storage ops are atomic. Correct.

### `AbstractSimpleLock.unlock()` failure leaves `valid = true`
If `doUnlock()` throws, `valid` remains `true` (the assignment `this.valid = false` is after `await doUnlock()`). This means the caller could retry `unlock()`. In `DefaultLockingTaskExecutor`, unlock errors are caught in `finally`, so the lock stays "valid" but is never explicitly released — it will expire via `lockAtMostFor`. This is acceptable but should be documented.

### Scheduler interface — duplicated and divergent
§12 defines `Scheduler.setInterval(...): Disposable` (comment: "returns something with .clear()").
§19 defines `Scheduler.setInterval(...): { clear(): void }` and `DefaultScheduler`.
`Disposable` is not defined anywhere. The two definitions are shape-compatible but the duplicate is confusing. Consolidate into one (§19) and remove the §12 inline definition.

## Gaps and Issues
- `KeepAliveLock.remainingLockAtLeastFor`: initialization and decrement logic unspecified.
- `TrackingSimpleLock.extend()`: effect on `activeLocks` set membership undefined.
- `Scheduler` interface defined twice (§12 and §19) with `Disposable` undefined.
- `enterWith` chosen for `makeAllAssertsPass` — deprecated-path risk, decision deferred in plan.
- `extend()` returning `undefined` invalidates the original lock (side-effect not in error table).
- `AbstractSimpleLock.unlock()` failure leaves `valid = true` — not documented.
- `parseDuration` edge cases (negative, zero, empty object, `"0"`) unspecified.
- `DefaultLockingTaskExecutor` reentrancy path doesn't emit `onLockAttempt`/`onLockAcquired`/`onLockNotAcquired` — not documented in listener contract.
- KeepAliveLock `extendForNextPeriod` needs post-await `active` re-check to avoid post-unlock extend.
- Plan introduces `runWithLock` internal methods not in spec.
- `StorageBasedLockProvider.clearCache(name)` is public in spec but architecture shows the registry as private — reconcile.
- Architecture doc's builder pattern (`lockConfig(...).build()`) contradicts both vision and this spec — update architecture doc.

## Recommendations
- Add a `// ponytail: single-threaded, re-check active after await` guard in `extendForNextPeriod` to close the post-unlock extend hole. One line.
- Define `remainingLockAtLeastFor` lifecycle: initialize to `config.lockAtLeastFor`, decrement by `config.lockAtMostFor / 2` each cycle (clamped at 0). One sentence in §12.
- Specify `TrackingSimpleLock.extend()`: returns a new `TrackingSimpleLock` wrapping the result, removes `this` from `activeLocks`, adds the new wrapper. Old wrapper's `unlocked` flag set to true.
- Consolidate `Scheduler` into §19; remove §12 inline definition; drop `Disposable` in favor of `{ clear(): void }`.
- Resolve `enterWith` vs `run`: prefer a `makeAllAssertsPass(true): () => void` API returning a teardown function, using `storage.run()` internally. Update spec §10 signature.
- Add `parseDuration` edge-case rows to §2 (negative → throw, `0` → valid, empty object → throw or 0).
- Document in §8 that the reentrancy path emits only `onTaskStarted`/`onTaskFinished`.
- Add a row to the Error Handling Summary: "`extend()` returns `undefined` → original lock invalidated; will expire via `lockAtMostFor`."
- Reconcile architecture doc's builder example with the `createLockConfig` factory actually used.

## Verdict: APPROVED WITH NOTES
