# Implementation Plan: @tslock/in-memory

## Overview

Build the `@tslock/in-memory` package — a DIRECT `ExtensibleLockProvider` backed by a plain `Map<string, number>`. The simplest provider: no driver, no container, no network. Supports `extend()`. Used as a test double and for local development. The package depends only on `@tslock/core` (peer).

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contracts)
- No external dependencies, no Docker required.

## Steps

### Step 1: Initialize package structure

```
packages/in-memory/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/in-memory",
  "version": "1.0.0",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": { "vitest": "^2.0.0", "typescript": "^5.5.0" }
}
```

**`tsup.config.ts`:** standard.

### Step 2: Implement InMemoryLock

**File:** `src/in-memory-lock.ts`

- `import { AbstractSimpleLock, ClockProvider, LockConfiguration, SimpleLock, lockAtLeastUntil, lockAtMostUntil } from '@tslock/core'`
- `import type { InMemoryLockProvider } from './in-memory-lock-provider.js'` (type-only import to avoid a runtime circular dep)
- `class InMemoryLock extends AbstractSimpleLock`:
  - `constructor(private readonly provider: InMemoryLockProvider, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock(): Promise<void>`:
    - `this.provider.locks.set(this.config.name, lockAtLeastUntil(this.config));`
  - `protected async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined>`:
    - `if (this.provider.isLocked(newConfig.name)) { this.provider.locks.set(newConfig.name, lockAtMostUntil(newConfig)); return new InMemoryLock(this.provider, newConfig); }`
    - `return undefined;`

**Circular dependency note:** `InMemoryLock` needs `InMemoryLockProvider` (for the `locks` Map), and `InMemoryLockProvider` needs `InMemoryLock` (to return from `lock()`). Use a type-only import (`import type`) for the provider in `InMemoryLock`, and a runtime import of `InMemoryLock` in the provider. This keeps the ESM/CJS graph acyclic at runtime.

### Step 3: Implement InMemoryLockProvider + factory

**File:** `src/in-memory-lock-provider.ts`

- `import { ClockProvider, ExtensibleLockProvider, LockConfiguration, SimpleLock, lockAtMostUntil } from '@tslock/core'`
- `import { InMemoryLock } from './in-memory-lock.js'`
- `class InMemoryLockProvider implements ExtensibleLockProvider`:
  - `private readonly locks = new Map<string, number>();`  (accessible from `InMemoryLock` — same package)
  - `isLocked(name: string): boolean { return this.locks.has(name) && (this.locks.get(name)! > ClockProvider.now()); }` (accessible from `InMemoryLock` — same package)
  - `async lock(config: LockConfiguration): Promise<SimpleLock | undefined>`:
    1. `if (this.isLocked(config.name)) return undefined;`
    2. `this.locks.set(config.name, lockAtMostUntil(config));`
    3. `return new InMemoryLock(this, config);`
- `function createInMemoryLockProvider(): InMemoryLockProvider { return new InMemoryLockProvider(); }`

**Visibility:** `locks` and `isLocked` need to be accessible from `InMemoryLock` (same package). Keep them public (TypeScript default) but document as package-internal. They are not exported from `index.ts`, so external consumers cannot reach them.

### Step 4: Wire index.ts

**File:** `src/index.ts`

Export:
- `InMemoryLockProvider`
- `createInMemoryLockProvider`

Do NOT export `InMemoryLock`.

### Step 5: Write unit tests

**File:** `__tests__/in-memory-lock-provider.test.ts`

Use `ClockProvider.setClock` / `resetClock` for deterministic time.

- `lock()`:
  - Fresh provider, `lock('test', 30s)` → `InMemoryLock` returned
  - `lock('test', 30s)` again → `undefined` (held)
  - Advance time 31s, `lock('test', 30s)` → `InMemoryLock` (expired)
- `unlock()`:
  - `lockAtLeastFor=0`: unlock → `locks.get('test') === createdAt` (past) → `isLocked` false
  - `lockAtLeastFor=5s`: unlock immediately → `locks.get('test') === createdAt + 5s` (future) → `isLocked` true; advance 6s → `isLocked` false
- `extend()`:
  - Lock, extend with `10s` → new `InMemoryLock` returned
  - Assert `locks.get('test') === newCreatedAt + 10s`
  - Original lock `unlock()` throws `LockException` (already extended)
  - Lock, advance time past expiry, `extend()` → `undefined`
- `lock()` then `unlock()` then `lock()` cycle:
  - After unlock with `lockAtLeastFor=0`, immediate re-lock succeeds
  - After unlock with `lockAtLeastFor=5s`, immediate re-lock fails (still held)
- Reentrancy is handled by `DefaultLockingTaskExecutor`, not the provider — no test here.
- Multiple providers: two `InMemoryLockProvider` instances are independent — lock on one does not block the other.

### Step 6: Write contract tests

**File:** `__tests__/in-memory-lock-provider.contract.test.ts`

Run the shared integration test contracts against the in-memory provider. Uses mock clock (`ClockProvider.setClock`) — no Docker, no real-time waits.

```typescript
import { lockProviderIntegrationTests, extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { createInMemoryLockProvider } from '../src/index.js';

describe('InMemoryLockProvider', () => {
  lockProviderIntegrationTests(() => Promise.resolve(createInMemoryLockProvider()), { timeMode: 'mock' });
  extensibleLockProviderIntegrationTests(() => Promise.resolve(createInMemoryLockProvider()), { timeMode: 'mock' });
  fuzzTests(() => Promise.resolve(createInMemoryLockProvider()));
});
```

- `timeMode: 'mock'` tells the contract suite to use `ClockProvider.setClock` for time advancement (no `setTimeout`).
- `fuzzTests`: launch 50 concurrent `lock()` calls, assert exactly 1 winner. In-memory is single-threaded so concurrency is interleaving; the synchronous check-and-set in `lock()` guarantees exactly one winner.
- The in-memory provider is the reference implementation that the contract suite must pass — if it fails here, the contract is wrong.

### Step 7: Verify

```bash
cd packages/in-memory
pnpm typecheck
pnpm test   # all tests are unit/contract, no Docker required
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Circular import between `InMemoryLock` and `InMemoryLockProvider` | Use `import type` for the provider reference in `InMemoryLock` (type-only, no runtime cycle). Runtime import of `InMemoryLock` in the provider is one-directional. ESM handles this cleanly. |
| `locks` / `isLocked` visibility | Keep them public (TypeScript default) but not exported from `index.ts`. Document as package-internal. Avoids a shared internal module. |
| Stale entries accumulate in the `Map` | Bounded by the number of distinct lock names (small). Not a leak in practice. Matches ShedLock. No cleanup needed. |
| Async interleaving breaks check-then-set | `isLocked()` + `locks.set()` in `lock()` are synchronous with no `await` between them — atomic in the event loop. Document this. The contract fuzz test (50 concurrent lockers, exactly 1 winner) verifies it. |
| `extend()` returns a lock that shares the same `Map` | Correct — the new `InMemoryLock` references the same provider, so `unlock()` on the extended lock updates the same entry. Unit test verifies the `lockedUntil` is updated. |
| Clock mock leaking between tests | Each test calls `ClockProvider.resetClock()` in `afterEach` (the contract suite handles this; unit tests do it explicitly). |
| Users mistake this for a distributed lock | Document prominently in the spec, README, and JSDoc on the class. The name `InMemoryLockProvider` and the warning in the overview make it clear. |

## Estimation

~2-3 source files, ~150-200 lines of implementation + ~200-300 lines of tests. Less than half a session — the simplest provider.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `InMemoryLock` (depends on provider type only)
3. `InMemoryLockProvider` + `createInMemoryLockProvider` factory
4. `index.ts` exports
5. Unit tests (mock clock)
6. Contract tests (shared integration test suites, mock clock)
