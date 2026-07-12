# Implementation Plan: @tslock/test-support

## Overview

Build the `@tslock/test-support` package providing shared integration test contracts. This is a test-only utility package — it is never shipped to production. It provides test factories that provider packages call in their Vitest suites.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- Vitest configured at repo root or per-package

## Steps

### Step 1: Initialize package

```
packages/test-support/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts
```

**`package.json`:**
```json
{
  "name": "@tslock/test-support",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "typecheck": "tsc --noEmit" },
  "peerDependencies": { "@tslock/core": "workspace:*" },
  "devDependencies": { "vitest": "^2.0.0", "typescript": "^5.5.0" }
}
```

### Step 2: Implement helpers

**File:** `src/helpers.ts`

- `config(name, lockAtMostFor, lockAtLeastFor?)`: wraps `createLockConfig` + `parseDuration`
- `sleep(ms)`: `new Promise(resolve => setTimeout(resolve, ms))`
- `cleanupLock(provider, name)`: acquire with 1s lockAtMostFor, unlock immediately. Best-effort, catch errors.
- `uniqueLockName(prefix?)`: returns `prefix + '-' + randomUUID()` or incrementing counter

### Step 3: Implement lockProviderIntegrationTests

**File:** `src/integration-tests.ts`

Export function `lockProviderIntegrationTests(getProvider: () => Promise<LockProvider>)`.

Each test:
1. `beforeEach`: `ClockProvider.resetClock()`, get provider via `getProvider()`.
2. Use `uniqueLockName()` per test.

Tests to implement (see spec for detailed steps):
- `shouldLockOnce`
- `shouldSkipIfLocked`
- `shouldUnlock`
- `shouldLockAtLeastFor` (use `ClockProvider.setClock` for unit tests; `sleep` for integration tests — the test factory should accept a `timeMode: 'mock' | 'real'` option)
- `shouldNotExtendIfNotExtensible`

**Time mode:** The factory accepts an options object:
```typescript
function lockProviderIntegrationTests(
  getProvider: () => Promise<LockProvider>,
  options?: { timeMode?: 'mock' | 'real' },
): void;
```
- `'mock'`: use `ClockProvider.setClock()` to advance time. For InMemory provider only.
- `'real'` (default): use `sleep()` to wait real time. For real backends.

### Step 4: Implement extensibleLockProviderIntegrationTests

**File:** `src/extensible-integration-tests.ts`

Call `lockProviderIntegrationTests(getProvider, options)` first, then add:
- `shouldExtendLock`
- `shouldNotExtendIfExpired`

### Step 5: Implement storageBasedLockProviderIntegrationTests

**File:** `src/storage-based-integration-tests.ts`

Call `extensibleLockProviderIntegrationTests(getProvider, options)` first, then add:
- `shouldCreateLockRecord`
- `shouldNotCreateDuplicateRecord`
- `shouldUpdateRecordIfExpired`

These tests need access to the `StorageAccessor` for direct record verification. The factory accepts an optional `getAccessor`:
```typescript
function storageBasedLockProviderIntegrationTests(
  getProvider: () => Promise<StorageBasedLockProvider>,
  options?: { timeMode?: 'mock' | 'real'; getAccessor?: () => Promise<StorageAccessor> },
): void;
```

### Step 6: Implement fuzzTests

**File:** `src/fuzz-tests.ts`

- `shouldHandleConcurrentLockAttempts`:
  ```typescript
  const promises = Array.from({ length: 50 }, () => provider.lock(config(name, '30s')));
  const results = await Promise.all(promises);
  const locks = results.filter(r => r !== undefined);
  expect(locks.length).toBe(1);
  await locks[0].unlock();
  ```

- `shouldHandleFuzzWithExtend` (only call if provider is extensible):
  - 20 concurrent workers, 5-second duration, random sleep + extend + unlock
  - Track max concurrent holders, assert <= 1 at any time

### Step 7: Write index.ts

Export all test factory functions + helpers.

### Step 8: Write tests for helpers

**File:** `__tests__/helpers.test.ts`

- `config()` produces valid LockConfiguration
- `sleep()` resolves after approximately the right time
- `uniqueLockName()` produces unique names

### Step 9: Verify

```bash
cd packages/test-support
pnpm typecheck
pnpm test
pnpm build
```

## Risks

| Risk | Mitigation |
|---|---|
| Mock time vs real time test mode confusion | Default to `'real'` mode. Document `'mock'` is for InMemory only. |
| Fuzz test flakiness on slow CI | Use reasonable timeouts (5s fuzz duration). Mark fuzz tests as `test.slow` or separate suite. |
| Storage-based tests need accessor access | Make `getAccessor` optional — if not provided, skip record-verification tests. |
| Integration tests with real backends are slow | These are only run in provider packages with containers, not in test-support itself. |

## Estimation

~5 files, ~400-600 lines. Quick to build after core is done.
