# Spec: @tslock/core

## Overview

The `@tslock/core` package provides the fundamental abstractions for distributed locking: `LockProvider`, `SimpleLock`, `LockConfiguration`, `LockingTaskExecutor`, `LockAssert`, `LockExtender`, `KeepAliveLockProvider`, `Utils`, and related types. It has zero runtime dependencies. Every provider package depends on it.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/core` |
| **Dependencies** | None (zero runtime deps) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. LockConfiguration

```typescript
interface LockConfiguration {
  readonly name: string;
  readonly lockAtMostFor: number;    // millis, must be >= 0
  readonly lockAtLeastFor: number;   // millis, must be >= 0 and <= lockAtMostFor
  readonly createdAt: number;        // epoch millis, set by ClockProvider
}
```

**Validation** (in `createLockConfig()` factory):
- `name` must be non-empty string.
- `lockAtMostFor` must be >= 0.
- `lockAtLeastFor` must be >= 0 and <= `lockAtMostFor`.

**Derived values** (helper functions, not methods — TS has no idiomatic interface getters):
```typescript
function lockAtMostUntil(config: LockConfiguration): number;  // config.createdAt + config.lockAtMostFor
function lockAtLeastUntil(config: LockConfiguration): number;  // config.createdAt + config.lockAtLeastFor
function unlockTime(config: LockConfiguration): number;        // Math.max(ClockProvider.now(), lockAtLeastUntil(config))
```

**Factory:**
```typescript
function createLockConfig(name: string, lockAtMostFor: number, lockAtLeastFor?: number): LockConfiguration;
```

### 2. Duration Parsing

```typescript
type DurationInput = number | string | { hours?: number; minutes?: number; seconds?: number; millis?: number };

function parseDuration(input: DurationInput): number;  // returns millis
```

**Accepted string formats:** `"30s"`, `"5m"`, `"1h"`, `"1d"`, `"500ms"`, `"250"` (bare number string = millis).
**Accepted object:** `{ hours: 1, minutes: 30, seconds: 0 }` → 5400000.
**Number input:** treated as millis directly.
**Throws:** `LockException` on unparseable string.

### 3. SimpleLock

```typescript
interface SimpleLock {
  unlock(): Promise<void>;
  extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined>;
}
```

**Contract:**
- `unlock()` releases the lock. After calling, no other method may be called (throws `LockException`).
- `extend()` attempts to extend the lock. Returns new `SimpleLock` on success, `undefined` on failure. After calling, the original lock is invalid (throws `LockException` on subsequent calls).
- Both methods are one-shot: calling `unlock()` twice throws. Calling `extend()` then `unlock()` on the original throws (use the returned lock).
- `extend()` default: providers that don't support extend throw `LockException('Extend not supported')`.

### 4. AbstractSimpleLock

```typescript
abstract class AbstractSimpleLock implements SimpleLock {
  protected valid: boolean = true;
  constructor(protected readonly config: LockConfiguration) {}
  
  async unlock(): Promise<void> {
    this.checkValidity();
    await this.doUnlock();
    this.valid = false;
  }
  
  async extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined> {
    this.checkValidity();
    const newConfig: LockConfiguration = {
      name: this.config.name,
      lockAtMostFor,
      lockAtLeastFor,
      createdAt: ClockProvider.now(),
    };
    const result = await this.doExtend(newConfig);
    this.valid = false;
    return result;
  }
  
  protected abstract doUnlock(): Promise<void>;
  
  protected async doExtend(config: LockConfiguration): Promise<SimpleLock | undefined> {
    throw new LockException('Extend not supported by this provider');
  }
  
  protected checkValidity(): void {
    if (!this.valid) throw new LockException('Lock has already been released or extended');
  }
}
```

Provider lock implementations extend this class and implement `doUnlock()` and optionally `doExtend()`.

### 5. LockProvider

```typescript
interface LockProvider {
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

**Contract:**
- Returns `SimpleLock` if the lock was acquired (caller must release).
- Returns `undefined` if the lock was not acquired (held by another instance).
- Throws on storage/driver errors (connection failures, etc.).

### 6. ExtensibleLockProvider

```typescript
interface ExtensibleLockProvider extends LockProvider {}
```

Marker type — no additional methods. Providers that support `extend()` implement this marker. Used by `KeepAliveLockProvider` to verify at construction time that the wrapped provider supports extension.

### 7. LockingTaskExecutor

```typescript
interface TaskResult<T> {
  readonly wasExecuted: boolean;
  getResult(): T | undefined;
}

interface LockingTaskExecutor {
  executeWithLock(
    task: () => Promise<void>,
    config: LockConfiguration,
  ): Promise<TaskResult<void>>;
  executeWithLock<T>(
    task: () => Promise<T>,
    config: LockConfiguration,
  ): Promise<TaskResult<T>>;
}

declare namespace TaskResult {
  function result<T>(value: T): TaskResult<T>;
  function notExecuted<T>(): TaskResult<T>;
}
```

**Contract:**
- If lock acquired: execute task, return `TaskResult.result(taskResult)`.
- If lock not acquired: skip task, return `TaskResult.notExecuted()`.
- If already locked by same name in this async context (reentrancy): execute task without re-acquiring lock.
- If task throws: propagate the error (after releasing lock in `finally`).
- `wasExecuted` is true if the task ran (whether or not it threw).
- `getResult()` returns the task's return value, or `undefined` if the task was not executed or threw.

### 8. DefaultLockingTaskExecutor

```typescript
class DefaultLockingTaskExecutor implements LockingTaskExecutor {
  constructor(
    lockProvider: LockProvider,
    listener?: LockingTaskExecutorListener,
  );
}
```

**Behavior:**
1. Check `LockAssert.alreadyLockedBy(config.name)`. If true → execute task directly (reentrancy), emit `onTaskStarted`/`onTaskFinished` only, return `TaskResult.result(...)`.
2. Emit `onLockAttempt(config)`.
3. Call `lockProvider.lock(config)`.
4. If `undefined` → emit `onLockNotAcquired(config)`, return `TaskResult.notExecuted()`.
5. If lock acquired:
   a. Emit `onLockAcquired(config)`.
   b. Run task within `LockAssert.storage.run(stack, async () => ...)` and `LockExtender.storage.run(stack, async () => ...)`.
   c. Emit `onTaskStarted(config)`.
   d. Measure `performance.now()` before/after.
   e. Execute task.
   f. In `finally`: emit `onTaskFinished(config, duration)`, then `await lock.unlock()` (catch + log errors).
   g. Return `TaskResult.result(taskResult)`.
6. Listener calls are wrapped in try/catch — listener failures never block lock release or task execution.

### 9. LockingTaskExecutorListener

```typescript
interface LockingTaskExecutorListener {
  onLockAttempt(config: LockConfiguration): void;
  onLockAcquired(config: LockConfiguration): void;
  onLockNotAcquired(config: LockConfiguration): void;
  onTaskStarted(config: LockConfiguration): void;
  onTaskFinished(config: LockConfiguration, executionTimeMillis: number): void;
}

const NO_OP_LISTENER: LockingTaskExecutorListener;
```

This is the **metrics extension point**. Users implement this to wire Prometheus, OpenTelemetry, etc. No metrics framework in core.

### 10. LockAssert

```typescript
class LockAssert {
  static assertLocked(): void;  // throws LockException if no active lock in current async context
  static alreadyLockedBy(name: string): boolean;
}

namespace LockAssert {
  namespace TestHelper {
    function makeAllAssertsPass(value: boolean): void;
  }
}
```

**Implementation:** Uses `AsyncLocalStorage<string[]>` to track a stack of lock names in the current async context. `DefaultLockingTaskExecutor` pushes the lock name before task execution and pops after.

`TestHelper.makeAllAssertsPass(true)` pushes a sentinel lock name onto the current context's stack; `false` pops it. This allows unit tests to run code that calls `LockAssert.assertLocked()` without actually holding a lock.

### 11. LockExtender

```typescript
class LockExtender {
  static extendActiveLock(lockAtMostFor: number, lockAtLeastFor: number): Promise<void>;
}

class NoActiveLockException extends LockException {}
class LockCanNotBeExtendedException extends LockException {}
```

**Implementation:** Uses `AsyncLocalStorage<SimpleLock[]>` to track a stack of active locks. `DefaultLockingTaskExecutor` pushes the lock before task execution and pops after.

`extendActiveLock()` peeks the innermost lock, calls `lock.extend(...)`, and replaces it in the stack. Throws `NoActiveLockException` if no active lock. Throws `LockCanNotBeExtendedException` if `extend()` returns `undefined`.

### 12. KeepAliveLockProvider

```typescript
class KeepAliveLockProvider implements LockProvider {
  static readonly MIN_LOCK_AT_MOST_FOR: number; // 30_000 millis
  
  constructor(
    provider: ExtensibleLockProvider,
    scheduler?: Scheduler,
  );
}
```

**Behavior:**
- Wraps an `ExtensibleLockProvider`.
- `lock(config)`: validates `lockAtMostFor >= 30s`, delegates to wrapped provider, wraps returned `SimpleLock` in `KeepAliveLock`.
- `KeepAliveLock`: on construction, schedules `setInterval` at `lockAtMostFor / 2` to call `extend(lockAtMostFor, remainingLockAtLeastFor)`.
  - `extendForNextPeriod()`: if `!active` return; if `currentLockAtMostUntil < now` stop; else extend.
  - `doUnlock()`: set `active = false`, cancel interval, call wrapped `lock.unlock()`.
  - `extend()`: throws `LockException('KeepAliveLock does not support manual extension')`.
- **Scheduler**: thin interface wrapping `setInterval`/`clearInterval`. Default implementation uses Node.js globals. Injectable for testing.

```typescript
interface Scheduler {
  setInterval(callback: () => void, ms: number): Disposable;  // returns something with .clear()
}
```

### 13. StorageBasedLockProvider + StorageAccessor (support layer)

```typescript
interface StorageAccessor {
  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration): Promise<boolean>;
}

abstract class AbstractStorageAccessor implements StorageAccessor {
  protected getHostname(): string;
}

class StorageBasedLockProvider implements ExtensibleLockProvider {
  constructor(accessor: StorageAccessor);
  async lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  clearCache(name: string): void;
}

class LockRecordRegistry {
  lockRecordRecentlyCreated(name: string): boolean;
  addRecord(name: string): void;
  clearCache(name: string): void;
}
```

**`StorageBasedLockProvider.lock()` algorithm:**
1. If `!lockRecordRegistry.lockRecordRecentlyCreated(name)`:
   a. `inserted = await accessor.insertRecord(config)`
   b. `lockRecordRegistry.addRecord(name)` (whether inserted or not — record exists now)
   c. If `inserted` → return `new StorageLock(config, accessor)`
2. `updated = await accessor.updateRecord(config)`
   - On exception: if we just tried insert (step 1), `lockRecordRegistry.clearCache(name)` (record may have been deleted externally)
3. If `updated` → return `new StorageLock(config, accessor)`
4. If `!updated` → return `undefined` (lock held)

**`StorageLock` (inner class extends `AbstractSimpleLock`):**
- `doUnlock()` → `accessor.unlock(config)`
- `doExtend(newConfig)` → `accessor.extend(newConfig)` ? `new StorageLock(newConfig, accessor)` : `undefined`

### 14. TrackingLockProviderWrapper

```typescript
class TrackingLockProviderWrapper implements LockProvider {
  constructor(delegate: LockProvider);
  async lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  getActiveLocks(): ReadonlySet<SimpleLock>;
}
```

Wraps a `LockProvider` and tracks active locks in a `Set`. Returned `SimpleLock` is a wrapper that removes itself from the set on `unlock()`. Uses a boolean flag to ensure `unlock()` is only called once on the wrapper.

### 15. Utils

```typescript
class Utils {
  static getHostname(): string;     // os.hostname(), fallback "unknown"
  static toIsoString(epochMillis: number): string;  // ISO-8601 with 3-digit millis
}
```

### 16. ClockProvider

```typescript
class ClockProvider {
  static now(): number;              // epoch millis
  static setClock(clock: () => number): void;  // override for tests
  static resetClock(): void;         // reset to Date.now()
}
```

### 17. LockException

```typescript
class LockException extends Error {
  constructor(message: string, options?: ErrorOptions);
}

class NoActiveLockException extends LockException {}
class LockCanNotBeExtendedException extends LockException {}
```

### 18. SimpleLockWithConfiguration (utility)

```typescript
interface SimpleLockWithConfiguration extends SimpleLock {
  getLockConfiguration(): LockConfiguration;
}
```

### 19. Scheduler Interface

```typescript
interface Scheduler {
  setInterval(callback: () => void, ms: number): { clear(): void };
}

class DefaultScheduler implements Scheduler {
  setInterval(callback: () => void, ms: number): { clear(): void };
}
```

## File Structure

```
packages/core/
├── src/
│   ├── index.ts                    # public exports
│   ├── lock-configuration.ts       # LockConfiguration, createLockConfig, derived helpers
│   ├── duration.ts                 # parseDuration, DurationInput
│   ├── simple-lock.ts              # SimpleLock, AbstractSimpleLock
│   ├── lock-provider.ts            # LockProvider, ExtensibleLockProvider
│   ├── locking-task-executor.ts    # LockingTaskExecutor, TaskResult, DefaultLockingTaskExecutor
│   ├── locking-task-executor-listener.ts
│   ├── lock-assert.ts              # LockAssert + AsyncLocalStorage
│   ├── lock-extender.ts            # LockExtender + AsyncLocalStorage
│   ├── keep-alive-lock-provider.ts # KeepAliveLockProvider, KeepAliveLock
│   ├── scheduler.ts                # Scheduler, DefaultScheduler
│   ├── storage-based-lock-provider.ts  # StorageBasedLockProvider, StorageAccessor, AbstractStorageAccessor, StorageLock, LockRecordRegistry
│   ├── tracking-lock-provider.ts   # TrackingLockProviderWrapper
│   ├── clock-provider.ts           # ClockProvider
│   ├── utils.ts                    # Utils (getHostname, toIsoString)
│   ├── lock-exception.ts           # LockException + subclasses
│   └── simple-lock-with-configuration.ts
├── __tests__/
│   ├── lock-configuration.test.ts
│   ├── duration.test.ts
│   ├── abstract-simple-lock.test.ts
│   ├── default-locking-task-executor.test.ts
│   ├── lock-assert.test.ts
│   ├── lock-extender.test.ts
│   ├── keep-alive-lock-provider.test.ts
│   ├── storage-based-lock-provider.test.ts
│   ├── tracking-lock-provider.test.ts
│   ├── clock-provider.test.ts
│   └── utils.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | Return `undefined` (not an error) |
| Storage/driver error during lock | Throw the error |
| `unlock()` called twice | Throw `LockException` |
| `extend()` on non-extensible provider | Throw `LockException('Extend not supported')` |
| `extend()` fails at storage layer | Return `undefined` (not an error) |
| Task throws | Propagate error after releasing lock |
| Listener throws | Catch, log, continue |
| `LockAssert.assertLocked()` outside lock | Throw `LockException` |
| `LockExtender.extendActiveLock()` with no active lock | Throw `NoActiveLockException` |

## Dependencies

- **Runtime**: none
- **Dev**: typescript, tsup, vitest, @types/node

## Exports

All types, classes, and functions listed in the Public API section are exported from `src/index.ts`.

## Non-Goals (for this package)

- No driver-specific code (that's in provider packages)
- No metrics framework integration (listener is the extension point)
- No decorator/annotation support
- No scheduler/cron integration
