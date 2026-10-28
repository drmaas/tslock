# Implementation Plan: @tslock/mongo

## Overview

Build the `@tslock/mongo` package — a DIRECT LockProvider backed by the official `mongodb` driver. Atomic `findOneAndUpdate` with `upsert: true` makes lock acquisition a single round-trip. The package depends only on `@tslock/core` (peer) and `mongodb` (peer).

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contracts)
- `mongodb` driver available as a dev dependency for type-checks and tests: `pnpm add -D mongodb`
- `testcontainers` available at repo root for integration tests
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/mongo/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/mongo",
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
  "peerDependencies": { "@tslock/core": "workspace:*", "mongodb": "^6.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": { "mongodb": "^6.0.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0", "typescript": "^5.5.0" }
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

### Step 2: Define MongoLockDocument

**File:** `src/mongo-lock-document.ts`

- Interface with `_id: string`, `lockUntil: Date`, `lockedAt: Date`, `lockedBy: string`.
- Export so consumers can type their `Collection<MongoLockDocument>`.

### Step 3: Implement MongoAccessor

**File:** `src/mongo-accessor.ts`

- Import `MongoServerError` from `mongodb` (for duplicate-key detection).
- Constructor: `(collection: Collection<MongoLockDocument>)`.
- `lock(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname();`
  2. `try { const result = await collection.findOneAndUpdate({ _id: config.name, lockUntil: { $lte: new Date(now) } }, { $set: { lockUntil: new Date(lockAtMostUntil(config)), lockedAt: new Date(now), lockedBy: hostname } }, { upsert: true, returnDocument: 'after' });`
  3. If `!result` → return `undefined`.
  4. Return `new MongoLock(config, this)`.
  5. `catch (e)`: if `e instanceof MongoServerError && e.code === 11000` → return `undefined`; else rethrow.
- `extend(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname();`
  2. `const result = await collection.findOneAndUpdate({ _id: config.name, lockUntil: { $gt: new Date(now) }, lockedBy: hostname }, { $set: { lockUntil: new Date(lockAtMostUntil(config)) } }, { returnDocument: 'after' });`
  3. If `!result` → return `undefined`.
  4. Return `new MongoLock(config, this)`.
  5. No duplicate-key path (no upsert).
- `unlock(config)`:
  1. `await collection.findOneAndUpdate({ _id: config.name }, { $set: { lockUntil: new Date(unlockTime(config)) } });`
  2. Return `void` (discard result).

### Step 4: Implement MongoLock

**File:** `src/mongo-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class MongoLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: MongoAccessor, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock(): Promise<void>` → `await this.accessor.unlock(this.config)`
  - `protected async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined>` → `return await this.accessor.extend(newConfig)` (returns `MongoLock | undefined`)

### Step 5: Implement MongoLockProvider + factory

**File:** `src/mongo-lock-provider.ts`

- `import type { Collection, Db } from 'mongodb'`
- `class MongoLockProvider implements ExtensibleLockProvider`:
  - `private readonly accessor: MongoAccessor`
  - `constructor(collection: Collection<MongoLockDocument>)` → `this.accessor = new MongoAccessor(collection)`
  - `async lock(config)` → `return await this.accessor.lock(config)`
- `function createMongoLockProvider(db: Db, options?: MongoLockProviderOptions): MongoLockProvider`:
  1. Resolve `collectionName = options?.collection ?? 'shedLock'`
  2. Resolve `writeConcern = { w: 'majority', ...options?.collectionOptions?.writeConcern }` (default majority; allow override)
  3. Resolve `readConcern = { level: 'majority', ...options?.collectionOptions?.readConcern }` (default majority)
  4. `const collection = db.collection<MongoLockDocument>(collectionName, { writeConcern, readConcern });`
  5. Return `new MongoLockProvider(collection)`

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `MongoLockProvider`
- `createMongoLockProvider`
- `MongoLockProviderOptions`
- `MongoLockDocument`

Do NOT export `MongoAccessor` or `MongoLock`.

### Step 7: Write unit tests (mocked Collection)

**File:** `__tests__/mongo-lock-provider.test.ts`

Mock the `Collection` object: `const collection = { findOneAndUpdate: vi.fn() } as unknown as Collection<MongoLockDocument>`. Use `new MongoLockProvider(collection)`.

- `lock()`:
  - `findOneAndUpdate` returns a doc → `MongoLock` returned (instance check)
  - `findOneAndUpdate` returns `null` → `undefined`
  - `findOneAndUpdate` throws `new MongoServerError({ code: 11000 })` → `undefined`
  - `findOneAndUpdate` throws `new MongoServerError({ code: 13 })` (not duplicate key) → propagates
  - Assert the filter args: `{ _id: config.name, lockUntil: { $lte: new Date(now) } }` (use `ClockProvider.setClock` to make `now` deterministic)
  - Assert `$set` writes `lockUntil`, `lockedAt`, `lockedBy` with the expected values
  - Assert options `{ upsert: true, returnDocument: 'after' }`
- `extend()`:
  - Returns a doc → `MongoLock`
  - Returns `null` → `undefined`
  - Assert filter includes `lockedBy: hostname` and `lockUntil: { $gt: new Date(now) }`
  - Assert no `upsert` in options
- `unlock()`:
  - Assert `$set: { lockUntil: new Date(unlockTime) }`
  - With `lockAtLeastFor=5s`, assert `unlockTime > now` (the minimum hold time is honored)
  - With `lockAtLeastFor=0`, assert `unlockTime === now`

### Step 8: Write integration tests (testcontainers MongoDB)

**File:** `__tests__/integration/mongo-lock-provider.integration.test.ts`

- Use `testcontainers` MongoDB container (single-node replica set — required for `w: 'majority'`):
  ```typescript
  import { MongoDBContainer } from '@testcontainers/mongodb';
  const container = await new MongoDBContainer('mongo:7').start();
  const client = new MongoClient(container.getConnectionUri());
  const db = client.db('tslock-test');
  ```
- `beforeAll`:
  - Start container (single-node replica set — the `@testcontainers/mongodb` image initializes `--replSet` automatically)
  - Create `MongoClient`, `db = client.db('tslock-test')`
  - `provider = createMongoLockProvider(db, { collection: 'shedlock-test' })`
- `afterAll`: close client, stop container.
- `beforeEach`: `await db.dropCollection('shedlock-test')`, `ClockProvider.resetClock()`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })` and `extensibleLockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.

### Step 9: Verify

```bash
cd packages/mongo
pnpm typecheck
pnpm test            # unit tests (no Docker required)
pnpm test:integration  # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `mongodb` driver v5 vs v6 API differences | Test against latest v6. Declare `peerDependencies: { mongodb: "^6.0.0" }` and document v5 compatibility in the README. The `findOneAndUpdate` API is stable across both. |
| Duplicate-key detection relies on `code === 11000` | This is the documented MongoDB error code for duplicate-key on unique indexes; stable across all server and driver versions. Add a unit test that throws a `MongoServerError` with `code: 11000` and asserts `undefined` is returned. |
| `WriteConcern.MAJORITY` requires a replica set | The MongoDB testcontainer image (`@testcontainers/mongodb`) initializes a single-node replica set. For users running standalone `mongod`, document that `w: 'majority'` blocks indefinitely; recommend a replica set. The factory's default concern is majority but can be overridden via `collectionOptions`. |
| `findOneAndUpdate` return shape across driver versions | v6 returns the matched doc or `null` when using `returnDocument: 'after'`. Add unit tests covering both `null` and doc-return cases. |
| No index on `lockUntil` — query performance | `_id` is the primary filter and is indexed. `lockUntil` is a secondary comparison on a single matched doc; no index needed. Document this. |
| Time-zone of `new Date()` in MongoDB | `new Date(epochMillis)` is UTC; MongoDB stores BSON Date as UTC millis. No timezone concern. Document that all dates are UTC. |
| `lockAtLeastFor` honored by `unlockTime()` in `unlock()` | Unit test: lock with `lockAtLeastFor=5s`, unlock immediately, assert the stored `lockUntil` is `>= now + 5s`. The integration test `shouldLockAtLeastFor` covers this end-to-end. |

## Estimation

~5 source files, ~300-400 lines of implementation + ~300-400 lines of tests. Half a focused session with Docker available.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `MongoLockDocument` interface
3. `MongoAccessor` (the meat — all `findOneAndUpdate` logic + duplicate-key mapping)
4. `MongoLock` (thin `AbstractSimpleLock` subclass)
5. `MongoLockProvider` + `createMongoLockProvider` factory
6. `index.ts` exports
7. Unit tests (mocked `Collection`)
8. Integration tests (testcontainers MongoDB, single-node replica set)
