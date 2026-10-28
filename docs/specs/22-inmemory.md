# Spec: @tslock/in-memory

## Overview

The `@tslock/in-memory` package provides a DIRECT `LockProvider` implementation backed by a plain in-process `Map<string, number>`. It implements `ExtensibleLockProvider` (supports `extend()`). There is no external driver — the package is pure TypeScript depending only on `@tslock/core`.

> **⚠️ Test / local development only — NOT for production distributed locking.** This provider locks only within a single Node.js process. Multiple instances of your application will each have their own `Map` and will NOT coordinate. Use this for unit tests, local development, and single-process demos. For any deployment with more than one instance, use a real distributed backend.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/in-memory` |
| **Driver** | None (pure TypeScript) |
| **Dependencies** | `@tslock/core` (peer) only |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. InMemoryLockProvider

```typescript
class InMemoryLockProvider implements ExtensibleLockProvider {
  constructor();
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

No configuration required. Each instance has its own lock `Map`. Create one provider per process (or per test) and reuse it for all locks.

### 2. createInMemoryLockProvider factory

```typescript
function createInMemoryLockProvider(): InMemoryLockProvider;
```

Convenience factory returning `new InMemoryLockProvider()`. Included for API symmetry with other providers.

### 3. InMemoryLock

```typescript
class InMemoryLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `InMemoryLockProvider.lock()` on successful acquisition. Overrides both `doUnlock()` and `doExtend()` — this is the only DIRECT-category provider that supports `extend()`.

## Locking Mechanism

### State

```typescript
private readonly locks = new Map<string, number>();  // name -> lockedUntilEpochMillis
```

A plain `Map`. Node.js is single-threaded (event loop), so no synchronization is required. Async operations interleave at `await` points, but each `Map` operation (`has`, `get`, `set`, `delete`) is synchronous and atomic — no interleaving occurs *within* a `Map` call.

### isLocked(name)

```typescript
private isLocked(name: string): boolean {
  return this.locks.has(name) && this.locks.get(name)! > ClockProvider.now();
}
```

A lock is held if the key exists AND its `lockedUntil` is in the future. An entry with a past `lockedUntil` is considered expired (stale entry — left in the `Map` by a previous unlock with `lockAtLeastFor` in the past).

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  if (this.isLocked(config.name)) {
    return undefined;
  }
  this.locks.set(config.name, lockAtMostUntil(config));
  return new InMemoryLock(this, config);
}
```

- If the lock is held (`isLocked` returns true), return `undefined`.
- Otherwise, set `lockedUntil = lockAtMostUntil(config)` and return an `InMemoryLock`.
- Note: stale entries (past `lockedUntil`) are overwritten — no need to delete them first.

### unlock (InMemoryLock.doUnlock)

```typescript
protected async doUnlock(): Promise<void> {
  this.provider.locks.set(this.config.name, lockAtLeastUntil(this.config));
}
```

- Sets `lockedUntil` to `lockAtLeastUntil(config)`.
- If `lockAtLeastFor = 0`, `lockAtLeastUntil = createdAt + 0 = createdAt`, which is in the past → `isLocked` returns false → the lock is effectively released.
- If `lockAtLeastFor > 0`, `lockAtLeastUntil` is in the future → the lock stays held until that time, then `isLocked` returns false naturally.
- The entry is NOT deleted from the `Map`; it becomes a stale entry that the next `lock()` overwrites. This avoids a `delete`-then-`set` race and matches ShedLock's behavior.

### extend (InMemoryLock.doExtend)

```typescript
protected async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
  if (this.provider.isLocked(newConfig.name)) {
    this.provider.locks.set(newConfig.name, lockAtMostUntil(newConfig));
    return new InMemoryLock(this.provider, newConfig);
  }
  return undefined;
}
```

- If the lock is still held (not expired), update `lockedUntil = lockAtMostUntil(newConfig)` and return a new `InMemoryLock` for the new config.
- If the lock has expired, return `undefined` (cannot extend a lock we no longer hold).
- The `newConfig` is built by `AbstractSimpleLock.extend()` with `createdAt = ClockProvider.now()`.

### Thread Safety

Node.js is single-threaded (event loop). A plain `Map` is safe — there is no concurrent access from multiple threads. Async operations interleave at `await` points, but:
- `isLocked()` + `locks.set()` in `lock()` is synchronous (no `await` between them), so no interleaving.
- `doUnlock()` and `doExtend()` perform synchronous `Map` operations wrapped in async functions.

No `Mutex`, `Atomic`, or `synchronized` equivalent is needed. This matches ShedLock's `InMemoryLockProvider`, which uses a `ConcurrentHashMap` (safe because `ConcurrentHashMap` is thread-safe); TSLock's is safe because of single-threadedness.

## File Structure

```
packages/in-memory/
├── src/
│   ├── index.ts
│   ├── in-memory-lock-provider.ts  # InMemoryLockProvider + createInMemoryLockProvider
│   └── in-memory-lock.ts          # InMemoryLock extends AbstractSimpleLock
├── __tests__/
│   ├── in-memory-lock-provider.test.ts          # unit tests
│   └── in-memory-lock-provider.contract.test.ts # extends lockProviderIntegrationTests + extensibleLockProviderIntegrationTests
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another (same process) | `isLocked` returns true → `undefined` |
| First lock on a name | `locks.set(name, lockAtMostUntil)` → `InMemoryLock` |
| `unlock()` with `lockAtLeastFor=0` | `locks.set(name, createdAt)` (past) → effectively released |
| `unlock()` with `lockAtLeastFor>0` | `locks.set(name, lockAtLeastUntil)` (future) → held until `lockAtLeastUntil` |
| `extend()` on a still-held lock | `locks.set(name, newLockAtMostUntil)` → new `InMemoryLock` |
| `extend()` on an expired lock | `isLocked` returns false → `undefined` |
| `extend()` after `unlock()` | `AbstractSimpleLock.checkValidity()` throws `LockException` |
| Multiple `InMemoryLockProvider` instances | Independent — no shared state. Each has its own `Map`. |
| Process restart | All locks lost (in-memory). Acceptable for test/local. |

## Dependencies

- **Peer**: `@tslock/core`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`

No external driver. No `testcontainers` (no container needed).

## Exports

From `src/index.ts`:
- `InMemoryLockProvider`
- `createInMemoryLockProvider`

`InMemoryLock` is not exported as public API.

## Non-Goals (for this package)

- **NOT for production distributed locking.** No cross-process coordination. Documented prominently.
- No persistence: locks are lost on process restart.
- No cross-process visibility: multiple `InMemoryLockProvider` instances (even in the same process) do not share state.
- No cluster/worker-thread awareness: worker threads have their own event loops and `Map` instances. TSLock does not coordinate across worker threads.
- No metrics: this provider is for testing; wire metrics via `LockingTaskExecutorListener` like any other provider.
