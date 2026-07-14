# Implementation Plan: @tslock/core

## Overview

This plan covers building the `@tslock/core` package from scratch. It is the foundation that all provider packages depend on. No code exists yet — this is a greenfield implementation.

## Prerequisites

- pnpm workspace initialized at repo root
- `tsconfig.base.json` at repo root
- Node 22+ installed

## Steps

### Step 1: Initialize package structure

```
packages/core/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    └── index.ts  (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/core",
  "version": "1.0.0",
  "description": "Core distributed lock abstractions for TSLock",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" }
}
```

**`tsup.config.ts`:**
```typescript
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
});
```

### Step 2: Implement LockException + subclasses

**File:** `src/lock-exception.ts`

- `LockException extends Error` with `name = 'LockException'`
- `NoActiveLockException extends LockException`
- `LockCanNotBeExtendedException extends LockException`

### Step 3: Implement ClockProvider

**File:** `src/clock-provider.ts`

- Private `clock: () => number` field, default `() => Date.now()`
- `static now()`, `static setClock()`, `static resetClock()`

### Step 4: Implement Utils

**File:** `src/utils.ts`

- `getHostname()`: `os.hostname()` with try/catch fallback to `'unknown'`
- `toIsoString(epochMillis)`: `new Date(epochMillis).toISOString()` (Node.js already produces 3-digit millis)

### Step 5: Implement Duration parsing

**File:** `src/duration.ts`

- Type `DurationInput = number | string | { hours?, minutes?, seconds?, millis? }`
- `parseDuration(input)`:
  - If `number` → return as-is (millis)
  - If `string` → regex `^(\d+)(ms|s|m|h|d)?$`, parse value + unit, throw `LockException` on no match
  - If `object` → sum `hours * 3600000 + minutes * 60000 + seconds * 1000 + millis`
- Unit multipliers: `ms=1, s=1000, m=60000, h=3600000, d=86400000`
- Bare number string (e.g. `"250"`) → treat as millis (number)

### Step 6: Implement LockConfiguration

**File:** `src/lock-configuration.ts`

- `LockConfiguration` interface (readonly fields)
- `createLockConfig(name, lockAtMostFor, lockAtLeastFor = 0)`: validates and returns config with `createdAt: ClockProvider.now()`
- Derived helpers: `lockAtMostUntil()`, `lockAtLeastUntil()`, `unlockTime()`

### Step 7: Implement SimpleLock + AbstractSimpleLock

**File:** `src/simple-lock.ts`

- `SimpleLock` interface
- `AbstractSimpleLock` abstract class:
  - `protected valid = true`
  - `constructor(protected readonly config: LockConfiguration)`
  - `async unlock()`: `checkValidity()` → `await doUnlock()` → `valid = false`
  - `async extend(lockAtMostFor, lockAtLeastFor)`: `checkValidity()` → build new config with `ClockProvider.now()` → `await doExtend(newConfig)` → `valid = false` → return result
  - `protected abstract doUnlock(): Promise<void>`
  - `protected async doExtend(config)`: `throw new LockException('Extend not supported')`
  - `protected checkValidity()`: throw if `!valid`

### Step 8: Implement LockProvider interfaces

**File:** `src/lock-provider.ts`

- `LockProvider` interface
- `ExtensibleLockProvider` (extends `LockProvider`, empty — marker type)

### Step 9: Implement LockAssert

**File:** `src/lock-assert.ts`

- `import { AsyncLocalStorage } from 'node:async_hooks'`
- Private `storage = new AsyncLocalStorage<string[]>()`
- `assertLocked()`: get store, throw if empty/undefined
- `alreadyLockedBy(name)`: check if store includes name
- `startLock(name)`: internal — returns new stack `[...current, name]`
- `endLock(stack)`: internal — returns `stack.slice(0, -1)`
- `TestHelper.makeAllAssertsPass(value)`: push/pop sentinel on current context
  - Uses `storage.enterWith()` or `storage.run()` to establish context
  - Note: `makeAllAssertsPass` needs careful implementation — it should work within the current async context. Use `storage.enterWith([...(store ?? []), '__test_sentinel__'])` for true, and pop for false. Actually, since `enterWith` is low-level and can cause issues, better to use `storage.run()` wrapping. But `makeAllAssertsPass` is called by test code that may not wrap in a callback. Need to think about this. **Decision:** Use `enterWith` for push, and manual pop for false. This matches ShedLock's ThreadLocal behavior where tests push/pop a sentinel.

### Step 10: Implement LockExtender

**File:** `src/lock-extender.ts`

- Private `storage = new AsyncLocalStorage<SimpleLock[]>()`
- `extendActiveLock(lockAtMostFor, lockAtLeastFor)`:
  - Get store, throw `NoActiveLockException` if empty/undefined
  - Peek last lock
  - Call `await lock.extend(lockAtMostFor, lockAtLeastFor)`
  - If `undefined` → throw `LockCanNotBeExtendedException`
  - Replace last element in store array with new lock
- `startLock(lock)`: internal — returns new stack
- `endLock(stack)`: internal — returns `stack.slice(0, -1)`

**Note on in-place replacement:** `AsyncLocalStorage` stores are mutable if you mutate the array. But to be safe, we should check if the store array is the one we created. Since we control the lifecycle (DefaultLockingTaskExecutor creates a fresh array for each task), mutation is safe.

### Step 11: Implement LockingTaskExecutorListener

**File:** `src/locking-task-executor-listener.ts`

- Interface with 5 methods
- `NO_OP_LISTENER` constant with empty implementations

### Step 12: Implement LockingTaskExecutor + DefaultLockingTaskExecutor

**File:** `src/locking-task-executor.ts`

- `TaskResult<T>` interface + `result()` / `notExecuted()` factories
- `LockingTaskExecutor` interface
- `DefaultLockingTaskExecutor` class:
  - Constructor: `(lockProvider, listener = NO_OP_LISTENER)`
  - `executeWithLock(task, config)`:
    1. If `LockAssert.alreadyLockedBy(config.name)` → `return executeTask(task, config)`
    2. `safeEmit(() => listener.onLockAttempt(config))`
    3. `const lock = await lockProvider.lock(config)`
    4. If `!lock` → `safeEmit(() => listener.onLockNotAcquired(config))` → return `TaskResult.notExecuted()`
    5. `safeEmit(() => listener.onLockAcquired(config))`
    6. `const assertStack = LockAssert.startLock(config.name)`
    7. `const extenderStack = LockExtender.startLock(lock)`
    8. `return await LockAssert.storage.run(assertStack, async () => { return await LockExtender.storage.run(extenderStack, async () => { try { return await executeTask(task, config) } finally { try { await lock.unlock() } catch (e) { /* log */ } } }) })`
  - `executeTask(task, config)`:
    1. `safeEmit(() => listener.onTaskStarted(config))`
    2. `const start = performance.now()`
    3. `try { const result = await task(); return TaskResult.result(result) } finally { safeEmit(() => listener.onTaskFinished(config, performance.now() - start)) }`
  - `safeEmit(fn)`: `try { fn() } catch (e) { /* log, never throw */ }`

**Important:** Need to export `LockAssert.storage` and `LockExtender.storage` or provide internal methods for `DefaultLockingTaskExecutor` to use. Since they're in the same package, we can export internal helpers or use a shared internal module. **Decision:** Add internal (non-exported from index.ts) methods `runWithLock(name, lock, callback)` on LockAssert and LockExtender that wrap `storage.run()`.

### Step 13: Implement Scheduler

**File:** `src/scheduler.ts`

- `Scheduler` interface: `setInterval(callback, ms): { clear(): void }`
- `DefaultScheduler`: uses Node.js `setInterval`/`clearInterval`

### Step 14: Implement KeepAliveLockProvider

**File:** `src/keep-alive-lock-provider.ts`

- `MIN_LOCK_AT_MOST_FOR = 30_000`
- Constructor: `(provider: ExtensibleLockProvider, scheduler = new DefaultScheduler())`
- `async lock(config)`:
  1. Validate `config.lockAtMostFor >= MIN_LOCK_AT_MOST_FOR`
  2. `const lock = await provider.lock(config)` → if undefined return undefined
  3. Return `new KeepAliveLock(lock, config, scheduler)`
- `KeepAliveLock extends AbstractSimpleLock`:
  - `private active = true`
  - `private remainingLockAtLeastFor: number`
  - `private intervalHandle: { clear(): void }`
  - Constructor: schedule `setInterval(extendForNextPeriod, lockAtMostFor / 2)`
  - `extendForNextPeriod()` (synchronized via `active` flag):
    1. If `!active` return
    2. If `lockAtMostUntil(config) < ClockProvider.now()` → `active = false`, `intervalHandle.clear()` return
    3. `const newLock = await lock.extend(config.lockAtMostFor, Math.max(0, remainingLockAtLeastFor))`
    4. If `newLock` → update internal lock reference, decrement `remainingLockAtLeastFor`
    5. If `!newLock` → stop (lock lost)
  - `async doUnlock()`: `active = false`, `intervalHandle.clear()`, `await lock.unlock()`
  - `async doExtend()`: `throw new LockException('KeepAliveLock does not support manual extension')`

**Note on `async extendForNextPeriod` race:** Since Node.js is single-threaded, the `active` flag check is safe between tick boundaries. The `await lock.extend(...)` yields, but `active` is only set to false by `doUnlock()` or `extendForNextPeriod()` itself. No race condition.

### Step 15: Implement StorageBasedLockProvider + StorageAccessor

**File:** `src/storage-based-lock-provider.ts`

- `StorageAccessor` interface
- `AbstractStorageAccessor` abstract class (getHostname via Utils)
- `LockRecordRegistry` class (Set-based)
- `StorageBasedLockProvider` class:
  - Constructor: `(accessor: StorageAccessor)`
  - `async lock(config)`:
    1. If `!registry.lockRecordRecentlyCreated(config.name)`:
       a. `const inserted = await accessor.insertRecord(config)`
       b. `registry.addRecord(config.name)`
       c. If `inserted` → return `new StorageLock(config, accessor)`
    2. `try { const updated = await accessor.updateRecord(config) } catch (e) { if (justInserted) registry.clearCache(config.name); throw e }`
    3. If `updated` → return `new StorageLock(config, accessor)`
    4. Return `undefined`
  - `clearCache(name)`: `registry.clearCache(name)`
- `StorageLock extends AbstractSimpleLock`:
  - `constructor(config, accessor)`
  - `async doUnlock()` → `await accessor.unlock(config)`
  - `async doExtend(newConfig)` → `const ok = await accessor.extend(newConfig); return ok ? new StorageLock(newConfig, accessor) : undefined`

**`justInserted` tracking:** Need a local boolean in `lock()` to track whether we attempted insert. If update throws and we did insert, clear cache.

### Step 16: Implement TrackingLockProviderWrapper

**File:** `src/tracking-lock-provider.ts`

- `TrackingLockProviderWrapper` class:
  - `private activeLocks = new Set<SimpleLock>()`
  - `async lock(config)` → delegate, if lock acquired wrap in `TrackingSimpleLock`
  - `getActiveLocks()` → `this.activeLocks` as readonly
- `TrackingSimpleLock` (inner):
  - `private unlocked = false`
  - `async unlock()` → if `!unlocked` → `unlocked = true`, `activeLocks.delete(this)`, `await delegate.unlock()`
  - `async extend(...)` → delegate to wrapped lock, wrap result

### Step 17: Implement SimpleLockWithConfiguration

**File:** `src/simple-lock-with-configuration.ts`

- Interface extending `SimpleLock` with `getLockConfiguration(): LockConfiguration`

### Step 18: Wire up index.ts

**File:** `src/index.ts`

Export all public types, classes, functions. Do NOT export internal helpers (LockAssert storage, LockExtender storage — these are internal to DefaultLockingTaskExecutor).

### Step 19: Write unit tests

All tests in `__tests__/` using Vitest.

**`duration.test.ts`:**
- Parse: `30000` → 30000, `"30s"` → 30000, `"5m"` → 300000, `"1h"` → 3600000, `"1d"` → 86400000, `"500ms"` → 500, `"250"` → 250, `{ hours: 1, minutes: 30 }` → 5400000
- Throw on: `"abc"`, `""`, `null`, `undefined`

**`lock-configuration.test.ts`:**
- `createLockConfig('test', 30000, 5000)` → correct fields
- Throws on: empty name, negative lockAtMostFor, lockAtLeastFor > lockAtMostFor
- Derived helpers: `lockAtMostUntil`, `lockAtLeastUntil`, `unlockTime` (mock ClockProvider)

**`clock-provider.test.ts`:**
- `now()` returns Date.now()-ish value
- `setClock()` overrides
- `resetClock()` restores

**`utils.test.ts`:**
- `getHostname()` returns non-empty string
- `toIsoString(0)` → `"1970-01-01T00:00:00.000Z"`
- `toIsoString(1544185837810)` → `"2018-12-07T12:30:37.810Z"`

**`abstract-simple-lock.test.ts`:**
- Subclass with mock doUnlock/doExtend
- `unlock()` calls doUnlock, sets invalid
- Second `unlock()` throws
- `extend()` calls doExtend, returns new lock, sets original invalid
- `extend()` then `unlock()` on original throws
- Default `doExtend()` throws

**`default-locking-task-executor.test.ts`:**
- Mock LockProvider returning mock SimpleLock
- Lock acquired → task runs → unlock called → TaskResult with wasExecuted=true
- Lock not acquired → task skipped → TaskResult with wasExecuted=false
- Task throws → error propagated, lock still released
- Reentrancy: alreadyLockedBy returns true → task runs without lock attempt
- Listener: all events fired in correct order
- Listener throws → does not block task or lock release

**`lock-assert.test.ts`:**
- Outside lock context: `assertLocked()` throws
- Inside `storage.run(stack, ...)`: `assertLocked()` passes
- `alreadyLockedBy` returns true for active lock, false for inactive
- `TestHelper.makeAllAssertsPass(true/false)` push/pop sentinel

**`lock-extender.test.ts`:**
- Inside lock context: `extendActiveLock` calls lock.extend
- No active lock: throws `NoActiveLockException`
- Extend returns undefined: throws `LockCanNotBeExtendedException`

**`keep-alive-lock-provider.test.ts`:**
- lockAtMostFor < 30s → throws
- Lock acquired → interval scheduled
- Use fake scheduler/timers (Vitest `vi.useFakeTimers()`)
- After lockAtMostFor/2: extend called
- Unlock: interval cleared, delegate unlock called
- Manual extend: throws

**`storage-based-lock-provider.test.ts`:**
- Mock StorageAccessor
- First lock: insertRecord returns true → lock acquired (no updateRecord called)
- Second lock (same name): insertRecord returns false → updateRecord returns true → lock acquired
- Second lock, updateRecord returns false → undefined
- UpdateRecord throws after insert: cache cleared
- StorageLock.unlock → accessor.unlock
- StorageLock.extend → accessor.extend true → new StorageLock; false → undefined

**`tracking-lock-provider.test.ts`:**
- Delegate returns lock → wrapper added to activeLocks
- Wrapper unlock → removed from activeLocks, delegate unlock called
- Double unlock → delegate called once

### Step 20: Verify

```bash
cd packages/core
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run
pnpm build       # tsup
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `AsyncLocalStorage` behavior differs from ThreadLocal in edge cases | Write thorough tests for `LockAssert` and `LockExtender` covering nested async contexts, parallel async operations, and context isolation |
| `enterWith` vs `run` for `makeAllAssertsPass` | Research Node.js docs; prefer `run()` where possible, `enterWith()` for push/pop semantics. Test thoroughly. |
| KeepAliveLock extend race conditions | Single-threaded event loop makes `active` flag safe. Document the single-threaded assumption. |
| `LockRecordRegistry` interleaving across async operations | Acceptable — it's an optimization. Storage operations are atomic. Document this. |
| `performance.now()` availability | Available since Node 8. No concern for Node 22+. |

## Estimation

~15-20 files, ~800-1200 lines of implementation + ~600-800 lines of tests. Should take one focused session.

## Order of Implementation

1. LockException → ClockProvider → Utils (no deps)
2. Duration → LockConfiguration (depends on ClockProvider)
3. SimpleLock → LockProvider (depends on LockConfiguration, LockException)
4. LockAssert → LockExtender (depends on SimpleLock, LockException)
5. LockingTaskExecutorListener → LockingTaskExecutor (depends on LockProvider, LockAssert, LockExtender)
6. Scheduler → KeepAliveLockProvider (depends on LockProvider, AbstractSimpleLock)
7. StorageBasedLockProvider (depends on LockProvider, AbstractSimpleLock, LockRecordRegistry)
8. TrackingLockProviderWrapper (depends on LockProvider, SimpleLock)
9. SimpleLockWithConfiguration (depends on SimpleLock, LockConfiguration)
10. index.ts (wire all exports)
11. Tests (after each module or all at end)
