# Implementation Plan: @tslock/memcached

## Overview

Build the `@tslock/memcached` package — a DIRECT `LockProvider` backed by the `memjs` memcached client. Lock acquisition uses the atomic `add` command; release uses `delete` (for `lockAtLeastFor=0`) or `replace` with a shorter TTL (for `lockAtLeastFor > 0`). The package depends only on `@tslock/core` (peer) and `memjs` (peer). No `extend()` support.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contracts)
- `memjs` available as a dev dependency: `pnpm add -D memjs`
- `testcontainers` available at repo root for integration tests
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/memcached/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/memcached",
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
  "peerDependencies": { "@tslock/core": "workspace:*", "memjs": "^1.5.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": { "memjs": "^1.5.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0", "typescript": "^5.5.0" }
}
```

**`tsup.config.ts`:** standard (entry `src/index.ts`, format `['esm','cjs']`, dts, clean, sourcemap).

**Note on `memjs` types:** `memjs` does not ship its own TypeScript types and there is no `@types/memjs` package. Add a minimal `src/memjs-types.d.ts` shim declaring the `Client` surface we use (`add`, `replace`, `delete` returning `{ success: boolean }`). Keeps the package type-safe without a runtime dep. Mark it a module with `declare module 'memjs'`.

### Step 2: Add the memjs type shim

**File:** `src/memjs-types.d.ts`

Minimal ambient declaration:
```typescript
declare module 'memjs' {
  interface ClientAddOptions { expires?: number; }
  interface ClientResult { success: boolean; }
  interface Client {
    add(key: string, value: string | Buffer, options?: ClientAddOptions): Promise<ClientResult>;
    replace(key: string, value: string | Buffer, options?: ClientAddOptions): Promise<ClientResult>;
    delete(key: string): Promise<ClientResult>;
  }
  interface ClientCreateOptions { [key: string]: unknown; }
  export const Client: { create(servers: string, options?: ClientCreateOptions): Client; };
  export type { Client, ClientResult, ClientAddOptions };
}
```

Keep the surface minimal so it does not drift from the real `memjs` API.

### Step 3: Define MemcachedLockProviderOptions

**File:** `src/memcached-configuration.ts`

- Interface: `servers: string` (required), `env?: string` (default `'default'`), `clientOptions?: Record<string, unknown>` (passed to `memjs.Client.create()`).
- Re-export the `ClientCreateOptions` type alias if useful.

### Step 4: Implement MemcachedLock

**File:** `src/memcached-lock.ts`

- `import { AbstractSimpleLock, ClockProvider, LockConfiguration, LockException, lockAtLeastUntil } from '@tslock/core'`
- `import type { Client as MemjsClient } from 'memjs'`
- `class MemcachedLock extends AbstractSimpleLock`:
  - `constructor(private readonly client: MemjsClient, private readonly key: string, private readonly value: string, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock(): Promise<void>`:
    1. `const keepLockFor = lockAtLeastUntil(this.config) - ClockProvider.now();`
    2. If `keepLockFor <= 0`:
       - `const result = await this.client.delete(this.key);`
       - If `!result.success` → `throw new LockException('Can not unlock ' + this.config.name + ' from memcached')`
    3. Else:
       - `const keepLockForSeconds = Math.ceil(keepLockFor / 1000);`
       - `const result = await this.client.replace(this.key, this.value, { expires: keepLockForSeconds });`
       - If `!result.success` → `throw new LockException('Can not unlock ' + this.config.name + ' from memcached')`
  - Do NOT override `doExtend` — inherit the default which throws `LockException('Extend not supported')`.

### Step 5: Implement MemcachedLockProvider + factory

**File:** `src/memcached-lock-provider.ts`

- `import { Client as MemjsClient } from 'memjs'` (runtime, for the factory)
- `import { ClockProvider, LockConfiguration, LockProvider, SimpleLock, Utils, lockAtMostUntil } from '@tslock/core'`
- `import { MemcachedLock } from './memcached-lock.js'`
- `class MemcachedLockProvider implements LockProvider`:
  - `constructor(private readonly client: MemjsClient, private readonly env: string = 'default')`
  - `async lock(config): Promise<SimpleLock | undefined>`:
    1. `const now = ClockProvider.now();`
    2. `const hostname = Utils.getHostname();`
    3. `const key = 'shedlock:' + this.env + ':' + config.name;`
    4. `const value = 'ADDED:' + Utils.toIsoString(now) + '@' + hostname;`
    5. `const expireTimeSeconds = Math.ceil(config.lockAtMostFor / 1000);`
    6. `const result = await this.client.add(key, value, { expires: expireTimeSeconds });`
    7. If `result.success` → `return new MemcachedLock(this.client, key, value, config);`
    8. Else → `return undefined;`
- `function createMemcachedLockProvider(options: MemcachedLockProviderOptions): MemcachedLockProvider`:
  1. Resolve `env = options.env ?? 'default'`
  2. `const client = memjs.Client.create(options.servers, options.clientOptions);`
  3. Return `new MemcachedLockProvider(client, env)`

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `MemcachedLockProvider`
- `createMemcachedLockProvider`
- `MemcachedLockProviderOptions`

Do NOT export `MemcachedLock` or the `memjs` type shim.

### Step 7: Write unit tests (mocked memjs.Client)

**File:** `__tests__/memcached-lock-provider.test.ts`

Mock the `memjs.Client` object: `const client = { add: vi.fn(), replace: vi.fn(), delete: vi.fn() }`. Each returns `{ success: boolean }`. Use `new MemcachedLockProvider(client, 'test')`.

- `lock()`:
  - `add` returns `{ success: true }` → `MemcachedLock` returned (instance check)
  - `add` returns `{ success: false }` → `undefined` (lock held)
  - Assert `add` called with key `shedlock:test:my-task` (custom env), value matching `ADDED:...@...`, `{ expires: 60 }` for `lockAtMostFor=60s`
  - Assert default env when none set: `shedlock:default:my-task`
  - `add` throws (network error) → propagates
  - Use `ClockProvider.setClock` to make `now` deterministic for the value string assertion
- `unlock()`:
  - `lockAtLeastFor=0`: `delete` called, returns `{ success: true }` → resolves void
  - `lockAtLeastFor=0`: `delete` returns `{ success: false }` → throws `LockException`
  - `lockAtLeastFor=5s`, unlock immediately: `replace` called with `{ expires: 5 }` (ceil of remaining ~5s), returns `{ success: true }` → void
  - `lockAtLeastFor=5s`: `replace` returns `{ success: false }` → throws `LockException`
  - Assert `replace` reuses the original `value` (lock value is preserved on replace)
  - Use `ClockProvider.setClock` for deterministic `keepLockFor` computation
- `extend()`:
  - Inherited default throws `LockException('Extend not supported')`

### Step 8: Write integration tests (testcontainers memcached)

**File:** `__tests__/integration/memcached-lock-provider.integration.test.ts`

- Use `testcontainers` memcached image:
  ```typescript
  import { GenericContainer } from 'testcontainers';
  const container = await new GenericContainer('memcached:1.6').withExposedPorts(11211).start();
  const servers = `${container.getHost()}:${container.getMappedPort(11211)}`;
  ```
- `beforeAll`:
  - Start container
  - `provider = createMemcachedLockProvider({ servers, env: 'test' })`
- `afterAll`: stop container.
- `beforeEach`: flush memcached (send `flush_all` via a raw `memjs` client, or use `nc`/telnet), `ClockProvider.resetClock()`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.
- Do NOT call `extensibleLockProviderIntegrationTests` — memcached does not support extend.
- Use real-time waits (`await sleep(ms)`) rather than mock clock for TTL expiry tests.

### Step 9: Verify

```bash
cd packages/memcached
pnpm typecheck
pnpm test            # unit tests (no Docker required)
pnpm test:integration  # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `memjs` has no TypeScript types | Ship a minimal `src/memjs-types.d.ts` shim covering `add`, `replace`, `delete` returning `{ success: boolean }`. Keep the surface minimal so it does not drift from the real `memjs` API. Unit tests use the shim via the real import path. |
| `memjs.add` success semantics | Verify via unit + integration tests: `add` on a fresh key returns `{ success: true }`; on an existing key returns `{ success: false }`. Confirmed in the `memjs` README. |
| `Math.ceil` vs ShedLock's `/1000 + 1` for TTL | `Math.ceil(30000/1000) = 30`, ShedLock does `30000/1000 + 1 = 31`. Consider `Math.floor(ttl/1000) + 1` to match ShedLock's 1s safety buffer against clock drift. Document the choice in the spec; either is acceptable. |
| Eviction breaks the at-most-once guarantee | Document prominently in the spec and README. Recommend a dedicated memcached instance and proper sizing. Inherent — no code fix. |
| `delete` / `replace` returning failure on unlock | Throw `LockException` (matches ShedLock). The lock is already gone (evicted/expired), so the throw is informational. `DefaultLockingTaskExecutor` catches unlock errors in `finally`. |
| `lockAtLeastFor` honored correctly | Unit test: lock with `lockAtLeastFor=5s`, unlock immediately, assert `replace` called with `expires >= 5`. Integration test `shouldLockAtLeastFor` covers this end-to-end with real TTL. |
| memjs `expires` unit (seconds vs millis) | `memjs` uses seconds for `expires`. Confirmed in the memjs API. Unit test asserts `{ expires: 60 }` not `60000`. |
| Testcontainer memcached image availability | Use the official `memcached:1.6` Docker image, widely available. Fallback: `memcached:alpine`. |
| Flushing memcached between integration tests | Use a separate `memjs` client to call `flush_all` in `beforeEach`, or rely on unique lock names per test (the contract suite already does this). Prefer unique names to avoid flush complexity. |

## Estimation

~4 source files + 1 type shim, ~250-350 lines of implementation + ~250-350 lines of tests. Half a focused session with Docker available.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `memjs` type shim (`src/memjs-types.d.ts`)
3. `MemcachedLockProviderOptions` interface
4. `MemcachedLock` (thin `AbstractSimpleLock` subclass with `doUnlock`)
5. `MemcachedLockProvider` + `createMemcachedLockProvider` factory
6. `index.ts` exports
7. Unit tests (mocked `memjs.Client`)
8. Integration tests (testcontainers memcached image)
