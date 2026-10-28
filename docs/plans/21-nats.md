# Implementation Plan: @tslock/nats

## Overview

Build the `@tslock/nats` package — a DIRECT `LockProvider` backed by NATS JetStream's Key-Value store (via the official `nats` client). Lock acquisition uses `kv.create` (key absent) or `kv.update` with revision (key expired); release uses `kv.delete` or `kv.update` with a shorter `lockUntil`. The package depends only on `@tslock/core` (peer) and `nats` (peer). No `extend()` support.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contracts)
- `nats` available as a dev dependency: `pnpm add -D nats`
- `testcontainers` available at repo root for integration tests
- Docker available for integration test runs (NATS image with JetStream enabled)

## Steps

### Step 1: Initialize package structure

```
packages/nats/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/nats",
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
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=22" },
  "peerDependencies": { "@tslock/core": "workspace:*", "nats": "^2.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": { "nats": "^2.0.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0", "typescript": "^5.5.0" }
}
```

**`tsup.config.ts`:** standard.

### Step 2: Implement long-utils

**File:** `src/long-utils.ts`

- `function longToBytes(epochMillis: number): Buffer`:
  - `const buf = Buffer.alloc(8); buf.writeBigInt64BE(BigInt(epochMillis), 0); return buf;`
- `function bytesToLong(buf: Uint8Array): number`:
  - `return Number(Buffer.from(buf).readBigInt64BE(0));`
- No overflow check (epoch millis are ~1.7e12, far below 2^53 — YAGNI).

### Step 3: Define NatsLockProviderOptions

**File:** `src/nats-configuration.ts`

- Interface: `servers: string` (required), `bucketName?: string` (default `'shedlock-locks'`), `storage?: StorageType` (default `StorageType.Memory`), `connectionOptions?: ConnectionOptions`.
- Import `StorageType`, `ConnectionOptions` from `nats` as types.

### Step 4: Implement NatsLock

**File:** `src/nats-lock.ts`

- `import { AbstractSimpleLock, ClockProvider, LockConfiguration, SimpleLock, lockAtLeastUntil, lockAtMostUntil } from '@tslock/core'`
- `import type { KV } from 'nats'`
- `import { bytesToLong, longToBytes } from './long-utils.js'`
- Note: `NatsLock` does NOT need a back-reference to the provider; it holds the `KV` directly. No circular import. Only `nats-lock-provider.ts` imports `NatsLock`.
- `class NatsLock extends AbstractSimpleLock`:
  - `constructor(private readonly kv: KV, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock(): Promise<void>`:
    1. `const entry = await this.kv.get(this.config.name);`
    2. If `entry === null` → return.
    3. `const lockUntil = bytesToLong(entry.value);`
    4. If `lockUntil > lockAtMostUntil(this.config)` → return (lock taken/extended).
    5. `const now = ClockProvider.now();`
    6. If `lockAtLeastUntil(this.config) > now`:
       - `await this.kv.update(this.config.name, longToBytes(lockAtLeastUntil(this.config)), entry.revision);`
    7. Else:
       - `await this.kv.delete(this.config.name);`
  - Do NOT override `doExtend` — inherit the default throwing.

### Step 5: Implement NatsLockProvider + factory + conflict helper

**File:** `src/nats-lock-provider.ts`

- `import { connect, StorageType } from 'nats'` (factory only)
- `import type { KV } from 'nats'`
- `import { ClockProvider, LockConfiguration, LockProvider, SimpleLock, lockAtMostUntil } from '@tslock/core'`
- `import { bytesToLong, longToBytes } from './long-utils.js'`
- `import { NatsLock } from './nats-lock.js'`
- `function isNatsConflictError(e: unknown): boolean`:
  - Check `e?.code === 10071` (JetStream ApiError code for KV update/create conflict).
  - Also check `e?.message?.includes('stream name already in use')` as a fallback for bucket-create conflicts.
  - Return `false` for unknown shapes (caller will rethrow).
- `class NatsLockProvider implements LockProvider`:
  - `constructor(private readonly kv: KV)`
  - `async lock(config): Promise<SimpleLock | undefined>`:
    1. `const now = ClockProvider.now(); const newLockUntil = lockAtMostUntil(config); const value = longToBytes(newLockUntil);`
    2. `const entry = await this.kv.get(config.name);`
    3. If `entry === null`:
       - `try { await this.kv.create(config.name, value); return new NatsLock(this.kv, config); }`
       - `catch (e) { if (isNatsConflictError(e)) return undefined; throw e; }`
    4. `const existingLockUntil = bytesToLong(entry.value);`
    5. If `existingLockUntil > now` → return `undefined` (held).
    6. `try { await this.kv.update(config.name, value, entry.revision); return new NatsLock(this.kv, config); }`
    7. `catch (e) { if (isNatsConflictError(e)) return undefined; throw e; }`
- `async function createNatsLockProvider(options: NatsLockProviderOptions): Promise<NatsLockProvider>`:
  1. `const nc = await connect({ servers: options.servers, ...options.connectionOptions });`
  2. `const js = nc.jetstream();`
  3. `const bucketName = options.bucketName ?? 'shedlock-locks';`
  4. `const storage = options.storage ?? StorageType.Memory;`
  5. `const kv = await js.views.kv(bucketName, { storage });` — get-or-create the bucket.
  6. Return `new NatsLockProvider(kv)`.
  7. Note: the `NatsConnection` is held by the `kv` handle; closing it is the user's responsibility. Document this in the README. The factory does not store `nc` separately.

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `NatsLockProvider`
- `createNatsLockProvider`
- `NatsLockProviderOptions`

Do NOT export `NatsLock`, `longToBytes`, `bytesToLong`, or `isNatsConflictError`.

### Step 7: Write unit tests (mocked KV)

**File:** `__tests__/nats-lock-provider.test.ts`

Mock the `KV` object: `const kv = { get: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() }`. Use `new NatsLockProvider(kv)`.

**File:** `__tests__/long-utils.test.ts`

- `longToBytes(0)` → 8 zero bytes.
- `longToBytes(1544185837810)` → known 8-byte big-endian buffer.
- `bytesToLong(longToBytes(x)) === x` round-trip for several values (0, 1, 1e12, 1.7e12).
- `bytesToLong(Buffer.from([0,0,0,0,0,0,0,1]))` → 1.
- `bytesToLong` accepts both `Buffer` and `Uint8Array` inputs.

**`nats-lock-provider.test.ts`:**
- `lock()`:
  - `get` returns `null`, `create` succeeds → `NatsLock` returned
  - `get` returns `null`, `create` throws conflict error (code 10071) → `undefined`
  - `get` returns `null`, `create` throws non-conflict → propagates
  - `get` returns entry with `lockUntil > now` → `undefined` (held)
  - `get` returns entry with `lockUntil <= now`, `update` succeeds → `NatsLock`
  - `get` returns entry with `lockUntil <= now`, `update` throws conflict → `undefined`
  - `get` returns entry with `lockUntil <= now`, `update` throws non-conflict → propagates
  - Use `ClockProvider.setClock` for deterministic `now`.
- `unlock()`:
  - `get` returns `null` → no-op (assert `delete`/`update` not called)
  - `get` returns entry with `lockUntil > lockAtMostUntil` → no-op
  - `lockAtLeastFor=0`: `delete` called
  - `lockAtLeastFor=5s`, unlock immediately: `update` called with `longToBytes(lockAtLeastUntil)` and `entry.revision`
- `extend()`:
  - Inherited default throws `LockException('Extend not supported')`

### Step 8: Write integration tests (testcontainers NATS)

**File:** `__tests__/integration/nats-lock-provider.integration.test.ts`

- Use `testcontainers` NATS image with JetStream enabled:
  ```typescript
  import { GenericContainer } from 'testcontainers';
  const container = await new GenericContainer('nats:2.10')
    .withExposedPorts(4222)
    .withCommand(['-js'])  // enable JetStream
    .start();
  const servers = `nats://${container.getHost()}:${container.getMappedPort(4222)}`;
  ```
- `beforeAll`:
  - Start container
  - `provider = await createNatsLockProvider({ servers, bucketName: 'shedlock-test', storage: StorageType.Memory })`
- `afterAll`: close NATS connection, stop container.
- `beforeEach`: purge the KV bucket (`await kv.purge()` if available, or delete+recreate), `ClockProvider.resetClock()`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.
- Do NOT call `extensibleLockProviderIntegrationTests` — NATS does not support extend.
- Use real-time waits for expiry tests.

### Step 9: Verify

```bash
cd packages/nats
pnpm typecheck
pnpm test            # unit tests (no Docker required)
pnpm test:integration  # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `nats` JetStream KV `create`/`update` conflict error code | Verify the exact error code (10071 for "KV update conflict" / key-exists) against the `nats` client source. `isNatsConflictError` checks both `e.code` and the message string for resilience. Unit-test both paths (conflict → `undefined`, non-conflict → rethrow). |
| `nats` client v2 API drift | The `jetstream().views.kv(name, { storage })` API is stable in nats.js v2. Pin `peerDependencies: { nats: "^2.0.0" }`. |
| `Number(buf.readBigInt64BE(0))` precision loss for very large values | Epoch millis are ~1.7e12, far below 2^53 (~9e15). No precision loss. Document the range assumption in the spec. |
| `lockUntil > lockAtMostUntil` skip-unlock logic | Unit test: set `lockAtMostUntil = T`, mock `kv.get` to return a value decoding to `T + 1`, assert `delete`/`update` not called. |
| `lockAtLeastFor` honored correctly | Unit + integration tests: lock with `lockAtLeastFor=5s`, unlock immediately, assert `kv.update` called with value decoding to `~ now + 5s`. |
| KV bucket auto-create requires JetStream | If JetStream is not enabled on the NATS server, `js.views.kv()` throws. Document that JetStream must be enabled. Integration test container starts with `-js`. |
| Memory storage loses locks on server restart | Documented as a property of `StorageType.Memory` (the default). Users who need durability configure `StorageType.File`. |
| Testcontainer NATS image with JetStream | Use `nats:2.10` with `.withCommand(['-js'])`. Verify JetStream is enabled in the integration test before running the contract. |
| `kv.get` returns `Uint8Array` vs `Buffer` | `nats` returns `Uint8Array` for KV entry values. `bytesToLong` wraps with `Buffer.from(buf)` before `readBigInt64BE`, which handles both `Uint8Array` and `Buffer` inputs. Unit test with both. |

## Estimation

~5 source files, ~350-450 lines of implementation + ~350-450 lines of tests. Half to one full session with Docker available.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `long-utils.ts` (no deps; test immediately)
3. `NatsLockProviderOptions` interface
4. `NatsLock` (thin `AbstractSimpleLock` subclass with `doUnlock`)
5. `NatsLockProvider` + `createNatsLockProvider` factory + `isNatsConflictError` helper
6. `index.ts` exports
7. Unit tests (mocked `KV` + `long-utils` tests)
8. Integration tests (testcontainers NATS with `-js`)
