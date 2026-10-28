# Spec: @tslock/test-support

## Overview

The `@tslock/test-support` package defines the canonical integration test contracts that **every** provider must pass. It provides abstract test base classes that provider test suites extend, ensuring behavioral parity across all 23 providers.

This is a direct port of ShedLock's `shedlock-test-support` module: `AbstractLockProviderIntegrationTest`, `AbstractExtensibleLockProviderIntegrationTest`, `AbstractStorageBasedLockProviderIntegrationTest`, and `FuzzTester`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/test-support` |
| **Dependencies** | `@tslock/core` (peer), `vitest` (dev) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |

## Design

The test contracts are implemented as **Vitest test suites** that provider packages import and extend. Each abstract test class is a function that takes a `LockProvider` factory and returns a set of test cases.

```typescript
// Pattern: function-based test factories (TS has no abstract test classes)
function lockProviderIntegrationTests(getProvider: () => Promise<LockProvider>): void;
function extensibleLockProviderIntegrationTests(getProvider: () => Promise<ExtensibleLockProvider>): void;
function storageBasedLockProviderIntegrationTests(getProvider: () => Promise<StorageBasedLockProvider>): void;
function fuzzTests(getProvider: () => Promise<LockProvider>): void;
```

Provider packages call these in their test files:
```typescript
import { lockProviderIntegrationTests } from '@tslock/test-support';

describe('MongoLockProvider', () => {
  lockProviderIntegrationTests(async () => new MongoLockProvider(getMongoCollection()));
});
```

## Test Contract: lockProviderIntegrationTests

### setup
- Each test gets a fresh `LockProvider` via `getProvider()`.
- Each test uses a unique lock name (UUID or incrementing counter) to avoid cross-test interference.
- `ClockProvider.resetClock()` before each test.

### shouldLockOnce
1. `const lock = await provider.lock(config('test', '1m'))`
2. Assert: `lock` is not `undefined`.
3. `await lock!.unlock()`

### shouldSkipIfLocked
1. `const lock1 = await provider.lock(config('test', '1m'))`
2. `const lock2 = await provider.lock(config('test', '1m'))`
3. Assert: `lock1` is not `undefined`, `lock2` is `undefined`.
4. `await lock1!.unlock()`

### shouldUnlock
1. `await provider.lock(config('test', '1m'))` → unlock
2. `const lock2 = await provider.lock(config('test', '1m'))`
3. Assert: `lock2` is not `undefined` (lock was released).
4. `await lock2!.unlock()`

### shouldLockAtLeastFor
1. `const lock1 = await provider.lock(config('test', '10s', '5s'))` — lockAtLeastFor=5s
2. `await lock1!.unlock()` — unlock immediately
3. `const lock2 = await provider.lock(config('test', '10s'))`
4. Assert: `lock2` is `undefined` — lock is still held for at least 5s despite unlock.
5. Advance ClockProvider by 6s (or wait 6s in real integration tests).
6. `const lock3 = await provider.lock(config('test', '10s'))`
7. Assert: `lock3` is not `undefined`.

### shouldNotExtendIfNotExtensible
1. `const lock = await provider.lock(config('test', '1m'))`
2. `const result = await lock!.extend('1m', 0)`
3. Assert: `result` is `undefined` OR throws `LockException`.
4. `await lock!.unlock()` (if still valid — some providers invalidate on failed extend; test should handle both).

## Test Contract: extensibleLockProviderIntegrationTests

Extends `lockProviderIntegrationTests` (all above tests) and adds:

### shouldExtendLock
1. `const lock = await provider.lock(config('test', '10s'))`
2. Advance time 6s (lock is 4s from expiry).
3. `const extended = await lock!.extend('10s', 0)`
4. Assert: `extended` is not `undefined`.
5. Advance time 8s (would have expired without extend, but extended lock is still valid).
6. `const lock2 = await provider.lock(config('test', '10s'))`
7. Assert: `lock2` is `undefined` (extended lock still holds).
8. `await extended!.unlock()`

### shouldNotExtendIfExpired
1. `const lock = await provider.lock(config('test', '1s'))`
2. Advance time 2s (lock expired).
3. `const extended = await lock!.extend('10s', 0)`
4. Assert: `extended` is `undefined`.

## Test Contract: storageBasedLockProviderIntegrationTests

Extends `extensibleLockProviderIntegrationTests` and adds:

### shouldCreateLockRecord
1. `await provider.lock(config('test', '1m'))` → unlock
2. Verify: lock record exists in storage (provider-specific verification via `StorageAccessor` or direct query).

### shouldNotCreateDuplicateRecord
1. `await provider.lock(config('test', '1m'))`
2. Attempt insert directly via accessor → should fail (record exists).
3. `await lock!.unlock()`

### shouldUpdateRecordIfExpired
1. `await provider.lock(config('test', '1s'))` → unlock
2. Advance time 2s (lock expired).
3. `const lock2 = await provider.lock(config('test', '1m'))`
4. Assert: `lock2` is not `undefined` (existing record was updated, not re-inserted).
5. `await lock2!.unlock()`

## Test Contract: fuzzTests

### shouldHandleConcurrentLockAttempts
1. Launch N=50 concurrent `provider.lock(config('fuzz', '30s'))` calls.
2. Assert: exactly 1 returns a `SimpleLock`, the other 49 return `undefined`.
3. Unlock the winning lock.
4. Repeat 10 times with different lock names.
5. Each iteration: exactly 1 winner.

### shouldHandleFuzzWithExtend (extensible providers only)
1. Launch N=20 concurrent tasks that:
   a. Try to lock.
   b. If acquired: sleep random 10-50ms, extend, sleep random 10-50ms, unlock.
   c. If not acquired: return immediately.
2. Run for 5 seconds.
3. Assert: no exceptions, no deadlocks, no more than 1 concurrent lock holder at any time.

## Helper Utilities

### config helper
```typescript
function config(
  name: string,
  lockAtMostFor: string | number,
  lockAtLeastFor?: string | number,
): LockConfiguration;
```
Wraps `createLockConfig(name, parseDuration(lockAtMostFor), lockAtLeastFor ? parseDuration(lockAtLeastFor) : 0)`.

### time advancement
For unit tests (InMemory): `ClockProvider.setClock(() => fixedTime)` to advance time.
For integration tests (real backends): use `setTimeout` / `await sleep(ms)` to wait real time.

```typescript
function sleep(ms: number): Promise<void>;
```

### cleanup
```typescript
function cleanupLock(provider: LockProvider, name: string): Promise<void>;
```
Best-effort lock cleanup for test teardown — acquires and releases the lock with lockAtLeastFor=0.

## File Structure

```
packages/test-support/
├── src/
│   ├── index.ts
│   ├── integration-tests.ts       # lockProviderIntegrationTests
│   ├── extensible-integration-tests.ts  # extensibleLockProviderIntegrationTests
│   ├── storage-based-integration-tests.ts
│   ├── fuzz-tests.ts              # fuzzTests
│   └── helpers.ts                 # config helper, sleep, cleanup
├── __tests__/
│   └── helpers.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Dependencies

- **Peer**: `@tslock/core`
- **Dev**: `vitest`, `typescript`, `tsup`, `@types/node`
