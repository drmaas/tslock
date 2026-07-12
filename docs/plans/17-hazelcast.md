# Implementation Plan: @tslock/hazelcast

## Overview

Build the `@tslock/hazelcast` package — a DIRECT LockProvider backed by a Hazelcast `IMap` with entry-level locking and per-entry TTL. The two-tier algorithm (entry-level lock → get-check-put → entry-level unlock) is unique to Hazelcast. The package depends only on `@tslock/core` (peer) and `hazelcast-client` (peer).

## Prerequisites

- `@tslock/core` and `@tslock/test-support` built and available in the pnpm workspace
- `hazelcast-client` driver available as a dev dependency for type-checks and tests: `pnpm add -D hazelcast-client`
- `testcontainers` available at repo root for integration tests (Hazelcast Docker image)
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/hazelcast/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/hazelcast",
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
  "engines": { "node": ">=20" },
  "peerDependencies": { "@tslock/core": "workspace:*", "hazelcast-client": "^5.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "hazelcast-client": "^5.0.0",
    "testcontainers": "^10.0.0",
    "vitest": "^2.0.0",
    "typescript": "^5.5.0"
  }
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

### Step 2: Define options + constants

**File:** `src/hazelcast-lock-provider-options.ts`

- `DEFAULT_LOCK_STORE_KEY = 'shedlock_storage'`
- `DEFAULT_LOCK_LEASE_TIME = 30_000`
- Interface `HazelcastLockProviderOptions` with `lockStoreKey?: string` and `lockLeaseTimeMs?: number`.
- `resolveOptions(opts?)` returns normalized options with defaults filled in:
  - `lockStoreKey: opts?.lockStoreKey ?? DEFAULT_LOCK_STORE_KEY`
  - `lockLeaseTimeMs: opts?.lockLeaseTimeMs ?? DEFAULT_LOCK_LEASE_TIME`

### Step 3: Implement HazelcastAccessor

**File:** `src/hazelcast-accessor.ts`

- Imports from `hazelcast-client`: `HazelcastClient`, `TimeUnit`.
- Import `HazelcastLockRecord` type (defined locally or in a shared types file).
- Constructor: `(client, lockStoreKey, lockLeaseTimeMs)`.
- `lock(config)`:
  1. `const now = ClockProvider.now(); const lockUntil = lockAtMostUntil(config); const keyLockTimeMs = lockUntil - now;`
  2. `const store = await client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);`
  3. `try { await store.lock(config.name, keyLockTimeMs, TimeUnit.MILLISECONDS); const existing = await store.get(config.name); if (existing === null) { await store.put(config.name, { lockUntil: Utils.toIsoString(lockUntil), lockedAt: Utils.toIsoString(now), lockedBy: Utils.getHostname() }, config.lockAtMostFor); return new HazelcastLock(config, this); } const existingLockUntil = Date.parse(existing.lockUntil); if (existingLockUntil <= now) { await store.put(config.name, { lockUntil: Utils.toIsoString(lockUntil), lockedAt: Utils.toIsoString(now), lockedBy: Utils.getHostname() }, config.lockAtMostFor); return new HazelcastLock(config, this); } return undefined; } finally { await store.unlock(config.name); }`
- `unlock(config)`:
  1. `const now = ClockProvider.now(); const lockAtLeastUntilValue = lockAtLeastUntil(config);`
  2. `const store = await client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);`
  3. `await store.lock(config.name, this.lockLeaseTimeMs, TimeUnit.MILLISECONDS);`
  4. `try { if (now >= lockAtLeastUntilValue) { await store.remove(config.name); } else { await store.put(config.name, { lockUntil: Utils.toIsoString(lockAtLeastUntilValue), lockedAt: Utils.toIsoString(now), lockedBy: Utils.getHostname() }, config.lockAtLeastFor); } } finally { try { await store.unlock(config.name); } catch { /* log: lock may have auto-released after TTL */ } }`

### Step 4: Implement HazelcastLock

**File:** `src/hazelcast-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class HazelcastLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: HazelcastAccessor, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock()` → `await this.accessor.unlock(this.config)`
  - Inherit `doExtend` from `AbstractSimpleLock` (throws `LockException('Extend not supported by this provider')`). No override.

### Step 5: Implement HazelcastLockProvider

**File:** `src/hazelcast-lock-provider.ts`

- `import type { HazelcastClient } from 'hazelcast-client'`
- `class HazelcastLockProvider implements LockProvider`:
  - `private readonly accessor: HazelcastAccessor`
  - `constructor(client: HazelcastClient, options?: HazelcastLockProviderOptions)`:
    1. `const opts = resolveOptions(options)`
    2. `this.accessor = new HazelcastAccessor(client, opts.lockStoreKey, opts.lockLeaseTimeMs)`
  - `async lock(config)` → `return await this.accessor.lock(config)`

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `HazelcastLockProvider`
- `HazelcastLockProviderOptions`

Do NOT export `HazelcastAccessor`, `HazelcastLock`, or `HazelcastLockRecord`.

### Step 7: Write unit tests (mocked HazelcastClient / IMap)

**File:** `__tests__/hazelcast-lock-provider.test.ts`

Mock the `HazelcastClient` and `IMap`:
```typescript
const store = {
  lock: vi.fn().mockResolvedValue(undefined),
  unlock: vi.fn().mockResolvedValue(undefined),
  get: vi.fn(),
  put: vi.fn().mockResolvedValue(undefined),
  remove: vi.fn().mockResolvedValue(undefined),
};
const client = { getMap: vi.fn().mockResolvedValue(store) } as unknown as HazelcastClient;
const provider = new HazelcastLockProvider(client);
```

- `lock()`:
  - `store.get` resolves `null` → `store.put` called with TTL = `config.lockAtMostFor` → `HazelcastLock` returned. Assert `store.lock` called with `(name, keyLockTimeMs, TimeUnit.MILLISECONDS)`.
  - `store.get` resolves `{ lockUntil: <past ISO>, lockedAt, lockedBy }` (expired) → `store.put` called → `HazelcastLock` returned.
  - `store.get` resolves `{ lockUntil: <future ISO>, lockedAt, lockedBy }` (held) → `undefined` returned, `store.put` NOT called.
  - `store.unlock` always called in `finally` — assert even when `store.get` rejects.
  - Assert `put` TTL argument equals `config.lockAtMostFor`.
  - Assert lock record fields: `lockUntil = Utils.toIsoString(lockAtMostUntil(config))`, `lockedAt = Utils.toIsoString(now)`, `lockedBy = Utils.getHostname()`.
- `unlock()`:
  - `now >= lockAtLeastUntil` (e.g. `lockAtLeastFor=0`) → `store.remove` called, `store.put` NOT called.
  - `now < lockAtLeastUntil` (e.g. `lockAtLeastFor=10s`, called immediately) → `store.put` called with TTL = `lockAtLeastFor`, `lockUntil = Utils.toIsoString(lockAtLeastUntil)`.
  - `store.lock` called with `(name, lockLeaseTimeMs, TimeUnit.MILLISECONDS)` (default 30000).
  - `store.unlock` always called in `finally`.
  - Custom `lockLeaseTimeMs` (e.g. 5000) → `store.lock` called with `5000` for the TTL arg.
- Use `ClockProvider.setClock(fn)` to make `now` deterministic.
- `extend()` on a returned `HazelcastLock` → throws `LockException`.

### Step 8: Write integration tests (Hazelcast testcontainer)

**File:** `__tests__/integration/hazelcast-lock-provider.integration.test.ts`

- Use the Hazelcast Docker image via testcontainers:
  ```typescript
  import { GenericContainer } from 'testcontainers';
  const container = await new GenericContainer('hazelcast/hazelcast:5.3.0')
    .withExposedPorts(5701)
    .withEnvironment({ HZ_NETWORK_PUBLICADDRESS: 'auto' })
    .start();
  const host = container.getHost();
  const port = container.getMappedPort(5701);
  ```
- `beforeAll`:
  1. Start container.
  2. `import { Client } from 'hazelcast-client';`
  3. `const hzClient = await Client.newHazelcastClient({ clusterName: 'dev', network: { clusterMembers: [`${host}:${port}`] } });`
  4. `provider = new HazelcastLockProvider(hzClient, { lockStoreKey: 'shedlock-test' })`
- `afterAll`: `await hzClient.shutdown(); await container.stop();`
- `beforeEach`: `const store = await hzClient.getMap('shedlock-test'); await store.clear(); ClockProvider.resetClock();`
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.
  - Note: NOT `extensibleLockProviderIntegrationTests` — Hazelcast does not implement `ExtensibleLockProvider`. The `shouldNotExtendIfNotExtensible` test from `AbstractLockProviderIntegrationTest` covers the throws-on-extend path.

### Step 9: Verify

```bash
cd packages/hazelcast
pnpm typecheck
pnpm test               # unit tests (no Docker required)
pnpm test:integration   # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `hazelcast-client` v5 API drift (`IMap.lock`, `put` TTL signature) | Pin `^5.0.0` in `peerDependencies`. The `lock(key, ttl, TimeUnit)` and `put(key, value, ttlMillis)` signatures are stable across v5.x. Add a unit test asserting these are called with the expected args. |
| `TimeUnit.MILLISECONDS` import path | Import from the top-level `hazelcast-client` export. Add a smoke test that constructs a provider and calls `lock` to catch import regressions early. |
| Entry-level lock TTL too short | `keyLockTimeMs = lockAtMostFor` — if a user sets `lockAtMostFor` very small (e.g. 100ms), the entry-level lock could expire mid get-check-put, allowing a race. Mitigation: document that `lockAtMostFor` must be > the get-check-put round-trip (typically < 50ms on a healthy cluster). The default `lockAtMostFor` in ShedLock is 1h, so this is rarely a concern. |
| Hazelcast max lock lease time | Hazelcast has a default max lock lease time. If `keyLockTimeMs` exceeds it, the client clamps. Document this and note that very long `lockAtMostFor` values may be clamped. |
| Holder crashes between `store.lock` and `store.unlock` | The TTL on `store.lock` (either `keyLockTimeMs` during `lock()` or `lockLeaseTimeMs` during `unlock()`) ensures the entry-level lock auto-releases. Default `lockLeaseTimeMs = 30s` is safe for normal cleanup. |
| `store.unlock` called without holding the entry lock (e.g. after TTL expiry) | Hazelcast throws `IllegalMonitorStateException`. Wrap `store.unlock` in try/catch and log a warning — do not propagate (the lock acquisition/unlock decision has already been made). |
| `HazelcastLockRecord` serialization | The record is a plain object with string fields. Hazelcast's default serialization handles it. For users with custom serialization configs, document that they may need to register the record class. The integration test should exercise the default serialization path. |
| Cluster partition / split-brain | Hazelcast's `IMap.lock` has well-defined behavior under partitions (locks are released on the minority side). The lock record's per-entry TTL (`lockAtMostFor`) is the ultimate safety net. Document that `lockAtMostFor` must be longer than the worst-case partition healing time. |
| `client.getMap` returns a fresh proxy each call | The Node.js client returns a lightweight proxy; calling `getMap` per operation is fine (no per-call cost beyond a lookup). Cache the proxy in the accessor if profiling shows it matters. |
| `Date.parse` of an ISO-8601 with 3-digit millis | `Date.parse('2018-12-07T12:30:37.810Z')` returns the correct epoch millis in Node.js (all supported versions). No concern. |

## Estimation

~5 source files, ~250-350 lines of implementation + ~300-400 lines of tests. Half a focused session with Docker available.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `HazelcastLockProviderOptions` + constants (`DEFAULT_LOCK_STORE_KEY`, `DEFAULT_LOCK_LEASE_TIME`)
3. `HazelcastAccessor` (the meat — IMap lock/get/put/remove/unlock)
4. `HazelcastLock` (thin `AbstractSimpleLock` subclass — no `doExtend` override)
5. `HazelcastLockProvider`
6. `index.ts` exports
7. Unit tests (mocked `HazelcastClient` / `IMap`)
8. Integration tests (Hazelcast testcontainer)
