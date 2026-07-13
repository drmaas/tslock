# Implementation Plan: @tslock/zookeeper

## Overview

Build the `@tslock/zookeeper` package — a DIRECT LockProvider backed by ZooKeeper PERSISTENT znodes with optimistic concurrency (`setData` with `version` CAS, or `create` for new znodes). The package depends only on `@tslock/core` (peer) and `zookeeper` (peer — the `zk` / `node-zookeeper` npm package, the most widely adopted ZooKeeper client for Node.js).

## Prerequisites

- `@tslock/core` and `@tslock/test-support` built and available in the pnpm workspace
- `zookeeper` driver available as a dev dependency for type-checks and tests: `pnpm add -D zookeeper`
- `testcontainers` available at repo root for integration tests (ZooKeeper Docker image)
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/zookeeper/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/zookeeper",
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
  "peerDependencies": { "@tslock/core": "workspace:*", "zookeeper": "^6.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "zookeeper": "^6.0.0",
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

### Step 2: Define options + constant

**File:** `src/zookeeper-lock-provider-options.ts`

- `DEFAULT_PATH = '/shedlock'`
- Interface `ZooKeeperLockProviderOptions` with `basePath?: string`.
- `resolveOptions(opts?)` returns `{ basePath: normalizePath(opts?.basePath ?? DEFAULT_PATH) }`.
- `normalizePath(path)`: strip trailing `/` (unless the path is just `/`); ensure leading `/`.

### Step 3: Implement error helpers

**File:** `src/zookeeper-errors.ts`

The `zookeeper` npm package throws `Exception` instances with a `.code` field that matches numeric constants exported from the package (`Exception.NO_NODE`, `Exception.BAD_VERSION`, `Exception.NODE_EXISTS`, `Exception.CONNECTION_LOSS`, `Exception.SESSION_EXPIRED`, etc.).

- `isNoNodeException(e: unknown): boolean` — `e?.code === Exception.NO_NODE` (or the numeric code `Exception.ZNO_NODE` — confirm against the installed driver).
- `isBadVersionException(e: unknown): boolean` — `e?.code === Exception.BAD_VERSION`.
- `isNodeExistsException(e: unknown): boolean` — `e?.code === Exception.NODE_EXISTS`.
- Add a unit test that throws mock errors with these codes and asserts the helpers recognize them. This catches import regressions if the constants change in a future driver major.

### Step 4: Implement ZooKeeperAccessor

**File:** `src/zookeeper-accessor.ts`

- Imports from `zookeeper`: `ZooKeeper`, `CreateMode`, `Exception` (for error code constants).
- Constructor: `(client, basePath)`.
- `lock(config)`:
  1. `const now = ClockProvider.now(); const lockAtMostUntilValue = lockAtMostUntil(config); const isoLockAtMostUntil = Utils.toIsoString(lockAtMostUntilValue); const nodePath = `${this.basePath}/${config.name}`;`
  2. `try { const stat = await client.getData(nodePath); const existingLockUntil = Date.parse(stat.data.toString('utf8')); if (existingLockUntil > now) return undefined; await client.setData(nodePath, Buffer.from(isoLockAtMostUntil), stat.version); return new ZooKeeperLock(config, this); }`
  3. `catch (e)`: if `isNoNodeException(e)` → `try { await client.create(nodePath, Buffer.from(isoLockAtMostUntil), CreateMode.PERSISTENT, true /* creatingParentsIfNeeded */); return new ZooKeeperLock(config, this); } catch (e2) { if (isNodeExistsException(e2)) return undefined; throw e2; }`
  4. else if `isBadVersionException(e)` → return `undefined`.
  5. else → `throw e`.
- `unlock(config)`:
  1. `const isoUnlock = Utils.toIsoString(unlockTime(config)); const nodePath = `${this.basePath}/${config.name}`;`
  2. `await client.setData(nodePath, Buffer.from(isoUnlock));` (no version — unconditional)

### Step 5: Implement ZooKeeperLock

**File:** `src/zookeeper-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class ZooKeeperLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: ZooKeeperAccessor, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock()` → `await this.accessor.unlock(this.config)`
  - Inherit `doExtend` from `AbstractSimpleLock` (throws `LockException('Extend not supported by this provider')`). No override.

### Step 6: Implement ZooKeeperLockProvider

**File:** `src/zookeeper-lock-provider.ts`

- `import type { ZooKeeper } from 'zookeeper'`
- `class ZooKeeperLockProvider implements LockProvider`:
  - `private readonly accessor: ZooKeeperAccessor`
  - `constructor(client: ZooKeeper, options?: ZooKeeperLockProviderOptions)`:
    1. `const opts = resolveOptions(options)`
    2. `this.accessor = new ZooKeeperAccessor(client, opts.basePath)`
  - `async lock(config)` → `return await this.accessor.lock(config)`

### Step 7: Wire index.ts

**File:** `src/index.ts`

Export:
- `ZooKeeperLockProvider`
- `ZooKeeperLockProviderOptions`

Do NOT export `ZooKeeperAccessor` or `ZooKeeperLock`.

### Step 8: Write unit tests (mocked ZooKeeper client)

**File:** `__tests__/zookeeper-lock-provider.test.ts`

Mock the `ZooKeeper` client:
```typescript
const client = {
  getData: vi.fn(),
  setData: vi.fn(),
  create: vi.fn(),
} as unknown as ZooKeeper;
const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
```

- `lock()`:
  - `getData` resolves `{ data: Buffer.from(<past ISO>), stat: { version: 5 } }` → `setData` called with `(path, Buffer, 5)` → `ZooKeeperLock` returned.
  - `getData` resolves with future `lockUntil` → `setData` NOT called → `undefined` returned.
  - `getData` rejects with `Exception` code `NO_NODE` → `create` called → if resolves → `ZooKeeperLock` returned.
  - `getData` rejects `NO_NODE`, `create` rejects `NODE_EXISTS` → `undefined` returned.
  - `getData` resolves past `lockUntil`, `setData` rejects `BAD_VERSION` → `undefined` returned.
  - `getData` rejects with `CONNECTION_LOSS` (not `NO_NODE`) → propagate.
  - Assert `nodePath = ${basePath}/${config.name}`.
  - Assert the buffer written to `setData` / `create` is `Buffer.from(Utils.toIsoString(lockAtMostUntil(config)))`.
  - Assert `create` called with `CreateMode.PERSISTENT` and `creatingParentsIfNeeded = true`.
- `unlock()`:
  - `setData` called with `(path, Buffer.from(Utils.toIsoString(unlockTime(config))))` — no version arg (unconditional).
  - With `lockAtLeastFor=5s` and called immediately, assert `unlockTime > now`.
  - With `lockAtLeastFor=0`, assert `unlockTime === now`.
- `extend()` on a returned `ZooKeeperLock` → throws `LockException`.
- Use `ClockProvider.setClock(fn)` to make `now` deterministic.

### Step 9: Write integration tests (ZooKeeper testcontainer)

**File:** `__tests__/integration/zookeeper-lock-provider.integration.test.ts`

- Use the ZooKeeper Docker image via testcontainers:
  ```typescript
  import { GenericContainer } from 'testcontainers';
  const container = await new GenericContainer('zookeeper:3.9.0')
    .withExposedPorts(2181)
    .start();
  const connectionString = `${container.getHost()}:${container.getMappedPort(2181)}`;
  ```
- `beforeAll`:
  1. Start container.
  2. `import { ZooKeeper } from 'zookeeper';`
  3. `const zk = new ZooKeeper({ connect: connectionString, timeout: 5000 });`
  4. Await the `connect` event: `await new Promise((resolve, reject) => { zk.on('connect', resolve); zk.on('error', reject); zk.connect(); });`
  5. `provider = new ZooKeeperLockProvider(zk, { basePath: '/shedlock-test' })`
- `afterAll`: `await zk.close(); await container.stop();`
- `beforeEach`: clean up any child znodes under the test basePath (or use a unique basePath per test):
  - Use a unique basePath per test (`/shedlock-test-${nanoid()}`) to avoid the recursive-delete dance. ZooKeeper has no "drop all" — `getChildren` + `delete` recursively is the alternative.
  - Reset `ClockProvider`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.
  - Not `extensibleLockProviderIntegrationTests` — ZooKeeper does not implement `ExtensibleLockProvider`. The `shouldNotExtendIfNotExtensible` test covers the throws-on-extend path.

### Step 10: Verify

```bash
cd packages/zookeeper
pnpm typecheck
pnpm test               # unit tests (no Docker required)
pnpm test:integration   # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `zookeeper` npm package error code constants differ across versions | The `zookeeper` package exposes error codes as numeric constants (`Exception.NO_NODE`, `Exception.BAD_VERSION`, `Exception.NODE_EXISTS`) on a thrown `Exception` instance's `.code` field. Pin `^6.0.0` in `peerDependencies`. Add a unit test that throws mock errors with the relevant codes and asserts the helpers recognize them. If the constants change in a future major, the unit test catches the regression. |
| `creatingParentsIfNeeded` argument signature in `zookeeper` npm package | The `create(path, data, mode, creatingParentsIfNeeded?)` signature is stable in v6. Add a unit test asserting `create` is called with `true` for the 4th argument. |
| `getData` return shape (`stat.data` vs `data` field) | The `zookeeper` npm package's `getData` resolves `{ data: Buffer, stat: Stat }` — confirm against the installed version. The unit test mocks the return shape; if the driver's shape differs, the unit test catches it. |
| Connection establishment timing | The provider does not wait for connection — the user must ensure the client is connected before calling `lock()`. Document this. The integration test awaits the `connect` event before constructing the provider. |
| ZooKeeper session expiry mid-operation | The `zookeeper` client throws `SESSION_EXPIRED` on any operation after session loss. The provider propagates this to the caller. Document that users should reconnect the client (or use a client that auto-reconnects) on session expiry. |
| Race between `getData` (NO_NODE) and `create` (NODE_EXISTS) | This is the expected optimistic-concurrency race. The provider handles it by returning `undefined` on `NODE_EXISTS`. The integration test's `shouldHandleConcurrentLockAttempts` fuzz test exercises this. |
| PERSISTENT znode accumulation | Lock znodes are never deleted (by design — they are reused across acquisitions). For high-cardinality lock names, the user may want a separate ZooKeeper namespace or periodic cleanup. Document this. |
| `setData` unconditional unlock vs. CAS-based lock | Unlock uses `setData` without a version (unconditional). This is correct: the holder is overwriting with an "unlocked" timestamp. A concurrent acquirer's CAS would have failed (the holder's `setData` changed the version), so the concurrent acquirer returned `undefined` and does not write. There is no race. |
| `Date.parse` of an ISO-8601 with 3-digit millis | `Date.parse('2018-12-07T12:30:37.810Z')` returns the correct epoch millis in Node.js (all supported versions). No concern. |
| `basePath` with trailing slash (e.g. `/shedlock/`) | `nodePath = `${basePath}/${config.name}`` would produce `//lock-name` if `basePath` ends with `/`. Normalize by stripping the trailing slash in `resolveOptions`. |
| ACL on created znodes | The provider creates znodes with the client's default ACL (`OPEN_ACL_UNSAFE`). Users with stricter ACL requirements should configure the client accordingly. Document this. |

## Estimation

~6 source files, ~250-350 lines of implementation + ~350-450 lines of tests. Half a focused session with Docker available.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `ZooKeeperLockProviderOptions` + `DEFAULT_PATH` + path normalization
3. Error helpers (`isNoNodeException`, `isBadVersionException`, `isNodeExistsException`)
4. `ZooKeeperAccessor` (getData/setData/create + error mapping)
5. `ZooKeeperLock` (thin `AbstractSimpleLock` subclass — no `doExtend` override)
6. `ZooKeeperLockProvider`
7. `index.ts` exports
8. Unit tests (mocked `ZooKeeper` client)
9. Integration tests (ZooKeeper testcontainer)
