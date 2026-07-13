# Implementation Plan: @tslock/etcd

## Overview

Build the `@tslock/etcd` package — a DIRECT LockProvider backed by etcd v3 via the official `etcd3` Node.js client. Locks use a transactional `if(version === 0)` + `Op.put` with lease pattern. Unlock revokes the lease (or re-puts with a short lease for `lockAtLeastFor > 0`). The package depends only on `@tslock/core` (peer) and `etcd3` (peer).

## Prerequisites

- `@tslock/core` and `@tslock/test-support` built and available in the pnpm workspace
- `etcd3` driver available as a dev dependency for type-checks and tests: `pnpm add -D etcd3`
- `testcontainers` available at repo root for integration tests (etcd Docker image)
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/etcd/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/etcd",
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
  "peerDependencies": { "@tslock/core": "workspace:*", "etcd3": "^1.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "etcd3": "^1.0.0",
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

**File:** `src/etcd-lock-provider-options.ts`

- `DEFAULT_ENV = 'default'`
- `MILLIS_IN_SECOND = 1000`
- Interface `EtcdLockProviderOptions` with `env?: string`.
- `resolveOptions(opts?)` returns `{ env: opts?.env ?? DEFAULT_ENV }`.

### Step 3: Implement EtcdAccessor

**File:** `src/etcd-accessor.ts`

- Imports from `etcd3`: `Etcd3`, `Cmp`, `Op` (and `LeaseId` type if exported).
- Constructor: `(client, env)`.
- `lock(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname(); const key = `shedlock:${this.env}:${config.name}`; const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`; const ttlSeconds = Math.ceil(config.lockAtMostFor / MILLIS_IN_SECOND);`
  2. `const lease = this.client.lease(ttlSeconds); const leaseId = lease.id;`
  3. `try { const txn = this.client.txn().if(Cmp.key(key).version === 0).then(Op.put(key, value, { lease: leaseId })).else(Op.get(key)); const result = await txn.commit(); if (result.succeeded) { return new EtcdLock(config, this, leaseId); } await lease.revoke(); return undefined; } catch (e) { try { await lease.revoke(); } catch { /* swallow */ } throw e; }`
- `unlock(config, leaseId)`:
  1. `const key = `shedlock:${this.env}:${config.name}`;`
  2. If `config.lockAtLeastFor <= 0`: `await this.client.lease(0, { id: leaseId }).revoke();` return.
  3. Else: `const now = ClockProvider.now(); const hostname = Utils.getHostname(); const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`; const newTtlSeconds = Math.ceil(config.lockAtLeastFor / MILLIS_IN_SECOND); const newLease = this.client.lease(newTtlSeconds); const newLeaseId = newLease.id; await this.client.put(key).value(value).lease(newLeaseId).exec(); await this.client.lease(0, { id: leaseId }).revoke();`

### Step 4: Implement EtcdLock

**File:** `src/etcd-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class EtcdLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: EtcdAccessor, private readonly leaseId: number | bigint, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock()` → `await this.accessor.unlock(this.config, this.leaseId)`
  - Inherit `doExtend` from `AbstractSimpleLock` (throws `LockException('Extend not supported by this provider')`). No override.

### Step 5: Implement EtcdLockProvider

**File:** `src/etcd-lock-provider.ts`

- `import type { Etcd3 } from 'etcd3'`
- `class EtcdLockProvider implements LockProvider`:
  - `private readonly accessor: EtcdAccessor`
  - `constructor(client: Etcd3, options?: EtcdLockProviderOptions)`:
    1. `const opts = resolveOptions(options)`
    2. `this.accessor = new EtcdAccessor(client, opts.env)`
  - `async lock(config)` → `return await this.accessor.lock(config)`

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `EtcdLockProvider`
- `EtcdLockProviderOptions`

Do NOT export `EtcdLockAccessor` or `EtcdLock`.

### Step 7: Write unit tests (mocked Etcd3 client)

**File:** `__tests__/etcd-lock-provider.test.ts`

Mock the `Etcd3` client and its fluent builders. The `etcd3` API uses chaining (`.txn().if().then().else().commit()`), so the mock must support the chain:

```typescript
const txnChain = {
  if: vi.fn().returnThis(),
  then: vi.fn().returnThis(),
  else: vi.fn().returnThis(),
  commit: vi.fn(),
};
const putChain = {
  value: vi.fn().returnThis(),
  lease: vi.fn().returnThis(),
  exec: vi.fn(),
};
const leaseMock = { id: 12345, revoke: vi.fn() };
const client = {
  txn: vi.fn(() => txnChain),
  put: vi.fn(() => putChain),
  lease: vi.fn(() => leaseMock),
} as unknown as Etcd3;
const provider = new EtcdLockProvider(client, { env: 'test' });
```

- `lock()`:
  - `txn.commit` resolves `{ succeeded: true }` → `lease.revoke` NOT called → `EtcdLock` returned.
  - `txn.commit` resolves `{ succeeded: false }` → `lease.revoke` called → `undefined` returned.
  - `txn.commit` rejects → `lease.revoke` called (best-effort) → original error rethrown.
  - Assert key is `shedlock:test:${config.name}` (with `env: 'test'`).
  - Assert value matches `ADDED:${Utils.toIsoString(now)}@${hostname}`.
  - Assert `lease` called with `Math.ceil(config.lockAtMostFor / 1000)`.
  - Assert txn chain: `.if(Cmp.key(key).version === 0)`, `.then(Op.put(key, value, { lease: leaseId }))`, `.else(Op.get(key))`.
  - Assert `EtcdLock` carries the leaseId (test via unlock path below).
- `unlock()`:
  - `lockAtLeastFor = 0` → `lease(0, { id: leaseId }).revoke()` called. Assert `lease` called with `{ id: leaseId }`.
  - `lockAtLeastFor = 5000` → new `lease(5)` created, `put(key).value(value).lease(newLeaseId).exec()` called, old `lease(0, { id: oldLeaseId }).revoke()` called.
  - Assert `lockAtLeastFor = 500` (sub-second) → `lease(Math.ceil(500/1000)) === lease(1)`.
  - Assert order: re-put FIRST, then revoke old lease (the order matters for correctness).
- `extend()` on a returned `EtcdLock` → throws `LockException`.
- Use `ClockProvider.setClock(fn)` to make `now` deterministic.

### Step 8: Write integration tests (etcd testcontainer)

**File:** `__tests__/integration/etcd-lock-provider.integration.test.ts`

- Use the etcd Docker image via testcontainers:
  ```typescript
  import { GenericContainer } from 'testcontainers';
  const container = await new GenericContainer('quay.io/coreos/etcd:v3.5.0')
    .withExposedPorts(2379)
    .withCmd([
      'etcd',
      '--advertise-client-urls=http://0.0.0.0:2379',
      '--listen-client-urls=http://0.0.0.0:2379',
    ])
    .start();
  const endpoints = `${container.getHost()}:${container.getMappedPort(2379)}`;
  ```
- `beforeAll`:
  1. Start container.
  2. `import { Etcd3 } from 'etcd3';`
  3. `const etcd = new Etcd3({ hosts: endpoints });`
  4. `provider = new EtcdLockProvider(etcd, { env: 'test' })`
- `afterAll`: `await etcd.close(); await container.stop();`
- `beforeEach`: `await etcd.delete().prefix('shedlock:test:');` `ClockProvider.resetClock();`
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.
  - Not `extensibleLockProviderIntegrationTests` — etcd does not implement `ExtensibleLockProvider`. The `shouldNotExtendIfNotExtensible` test covers the throws-on-extend path.

### Step 9: Verify

```bash
cd packages/etcd
pnpm typecheck
pnpm test               # unit tests (no Docker required)
pnpm test:integration   # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `etcd3` API drift on `txn` / `lease` chaining | The `etcd3` v1 API is stable: `client.txn().if(Cmp...).then(Op...).else(Op...).commit()`, `client.lease(ttl)` returns `Lease` with `.id` and `.revoke()`. Pin `^1.0.0` in `peerDependencies`. The unit test's mock chain catches signature regressions. |
| `lease.id` available before grant (lazy) | The `etcd3` client returns a `Lease` object whose `.id` is assigned synchronously (a generated ID), and the lease is granted on the next await (the txn commit). Document this in a comment. The unit test mocks `lease.id = 12345` to verify the flow. |
| `Math.ceil(lockAtMostFor / 1000)` for sub-second TTL | Sub-second `lockAtMostFor` (e.g. 500ms) → TTL 1 second. Document the rounding behavior. The integration test's `shouldLockAtLeastFor` and `shouldLockOnce` tests use multi-second durations to avoid sub-second edge cases. |
| Lease orphaned on `lock()` failure | The `catch` block revokes the lease (best-effort). If the revoke itself fails (network down), the lease expires after `lockAtMostFor` seconds — no permanent orphan. Document this. |
| `unlock()` with `lockAtLeastFor > 0` revokes the wrong lease | The order matters: re-put with the new lease FIRST, then revoke the OLD lease. If the order is reversed, revoking the old lease deletes the key before the new put attaches the new lease. The unit test asserts the order. |
| `lease(0, { id: leaseId })` wraps an existing lease for revoke | The `etcd3` API: `client.lease(ttl, { id })` returns a `Lease` wrapper around the existing ID. `.revoke()` on it revokes that lease. If the API differs in a future version, the unit test catches it. Alternative: `client.leaseClient.revoke(leaseId)` — confirm against the installed version. |
| `Op.put(key, value, { lease: leaseId })` — lease option name | The `etcd3` `Op.put` options use `lease` (or `leaseId`) as the key. Confirm against the installed version. The unit test asserts the option name. |
| etcd testcontainer image / startup args | The `quay.io/coreos/etcd` image requires explicit `--advertise-client-urls` and `--listen-client-urls` to listen on all interfaces. The integration test setup documents this. |
| Lease keepalive keeps the lease alive forever | The `etcd3` client auto-keeps-alive active leases. This is correct: the lease should not expire while the holder is alive. On process crash, the keepalive stops and the lease expires. Document this. |
| Concurrent acquirers on the same key | The transaction's `if(version === 0)` ensures only one `put` succeeds. The others see `!succeeded` and revoke their leases. No orphaned keys. The integration test's fuzz test (`shouldHandleConcurrentLockAttempts`) exercises this. |
| `lockAtMostFor` exceeds etcd max TTL (5,000,000 seconds ≈ 5,400 days) | Document the etcd max TTL. TSLock's default `lockAtMostFor` is much shorter. |

## Estimation

~5 source files, ~250-350 lines of implementation + ~350-450 lines of tests. Half a focused session with Docker available.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `EtcdLockProviderOptions` + constants (`DEFAULT_ENV`, `MILLIS_IN_SECOND`)
3. `EtcdAccessor` (txn + lease + put + revoke)
4. `EtcdLock` (carries `leaseId`; thin `AbstractSimpleLock` subclass — no `doExtend` override)
5. `EtcdLockProvider`
6. `index.ts` exports
7. Unit tests (mocked `Etcd3` client with fluent chain mocks)
8. Integration tests (etcd testcontainer)
