# Implementation Plan: @tslock/arangodb

## Overview

Build the `@tslock/arangodb` package — a DIRECT `ExtensibleLockProvider` backed by the official `arangojs` driver. Lock acquisition wraps a read-check-write sequence in a single stream transaction with an exclusive collection lock, serializing concurrent attempts. The package depends only on `@tslock/core` (peer) and `arangojs` (peer).

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built (for integration test contracts)
- `arangojs` driver installed as a dev dependency for type-checks and tests: `pnpm add -D arangojs`
- `testcontainers` available at repo root for integration tests
- Docker available for integration test runs

## Steps

### Step 1: Initialize package structure

```
packages/arangodb/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/arangodb",
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
  "peerDependencies": { "@tslock/core": "workspace:*", "arangojs": "^8.0.0" },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": { "arangojs": "^8.0.0", "testcontainers": "^10.0.0", "vitest": "^2.0.0", "typescript": "^5.5.0" }
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

### Step 2: Define ArangoDbLockDocument

**File:** `src/arangodb-lock-document.ts`

- Interface with `_key: string`, `lockUntil: string`, `lockedAt: string`, `lockedBy: string`.
- Export so consumers can type their `Collection<ArangoDbLockDocument>`.

### Step 3: Implement ArangoDbAccessor

**File:** `src/arangodb-accessor.ts`

- Import `Collection` and `Database` types from `arangojs`.
- Constructor: `(collection: Collection<ArangoDbLockDocument>)`.
- Helper `isDocumentNotFoundError(e)`: returns `true` if `e?.errorNum === 1202` || `e?.code === 1202` || `e?.name === 'ArangoError' && e.errorNum === 1202`. Covers the `arangojs` error shape (ArangoDB error code `1202` = `ERROR_ARANGO_DOCUMENT_NOT_FOUND`).
- `lock(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname();`
  2. `const collectionName = this.collection.name; const documentId = config.name;`
  3. `const txn = await this.collection.database().beginTransaction({ exclusiveCollections: [collectionName] });`
  4. `try`:
     a. `let existing: ArangoDbLockDocument | null = null;`
     b. `try { existing = await this.collection.document(documentId); } catch (e) { if (isDocumentNotFoundError(e)) existing = null; else { await txn.abort(); throw e; } }`
     c. If `existing === null`:
        - `await this.collection.save({ _key: documentId, lockUntil: Utils.toIsoString(lockAtMostUntil(config)), lockedAt: Utils.toIsoString(now), lockedBy: hostname });`
        - `await txn.commit();`
        - Return `new ArangoDbLock(config, this)`.
     d. If `existing !== null`:
        - `const lockUntilMillis = Date.parse(existing.lockUntil);`
        - If `lockUntilMillis <= now` (expired):
          - `await this.collection.update(documentId, { lockUntil: Utils.toIsoString(lockAtMostUntil(config)), lockedAt: Utils.toIsoString(now), lockedBy: hostname });`
          - `await txn.commit();`
          - Return `new ArangoDbLock(config, this)`.
        - Else (lock held):
          - `await txn.abort();`
          - Return `undefined`.
  5. `catch (e) { try { await txn.abort(); } catch { /* best-effort */ } throw e; }`
- `extend(config)`:
  1. `const now = ClockProvider.now(); const hostname = Utils.getHostname();`
  2. `let existing: ArangoDbLockDocument;`
  3. `try { existing = await this.collection.document(config.name); } catch (e) { if (isDocumentNotFoundError(e)) return undefined; throw e; }`
  4. If `existing.lockedBy !== hostname` → return `undefined`.
  5. If `Date.parse(existing.lockUntil) <= now` → return `undefined`.
  6. `await this.collection.update(config.name, { lockUntil: Utils.toIsoString(lockAtMostUntil(config)) });`
  7. Return `new ArangoDbLock(config, this)`.
- `unlock(config)`:
  1. `try { await this.collection.update(config.name, { lockUntil: Utils.toIsoString(unlockTime(config)) }); }`
  2. `catch (e) { if (isDocumentNotFoundError(e)) return; throw e; }`

### Step 4: Implement ArangoDbLock

**File:** `src/arangodb-lock.ts`

- `import { AbstractSimpleLock, LockConfiguration, SimpleLock } from '@tslock/core'`
- `class ArangoDbLock extends AbstractSimpleLock`:
  - `constructor(private readonly accessor: ArangoDbAccessor, config: LockConfiguration)` — pass `config` to `super(config)`.
  - `protected async doUnlock(): Promise<void>` → `await this.accessor.unlock(this.config)`
  - `protected async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined>` → `return await this.accessor.extend(newConfig)` (returns `ArangoDbLock | undefined`)

### Step 5: Implement ArangoDbLockProvider + factory

**File:** `src/arangodb-lock-provider.ts`

- `import type { Database } from 'arangojs'`
- `class ArangoDbLockProvider implements ExtensibleLockProvider`:
  - `private readonly accessor: ArangoDbAccessor`
  - `constructor(collection: Collection<ArangoDbLockDocument>)` → `this.accessor = new ArangoDbAccessor(collection)`
  - `async lock(config)` → `return await this.accessor.lock(config)`
- `function createArangoDbLockProvider(database: Database, options?: ArangoDbLockProviderOptions): ArangoDbLockProvider`:
  1. Resolve `collectionName = options?.collection ?? 'shedLock'`
  2. `const collection = database.collection<ArangoDbLockDocument>(collectionName)`
  3. Return `new ArangoDbLockProvider(collection)`
  - **Note:** `database.collection(name)` returns a lightweight handle; it does not create the collection. The user must create the collection before the first `lock()` call. The factory does NOT call `db.createCollection` — users who want auto-creation can call it themselves. Document this in the README.

### Step 6: Wire index.ts

**File:** `src/index.ts`

Export:
- `ArangoDbLockProvider`
- `createArangoDbLockProvider`
- `ArangoDbLockProviderOptions`
- `ArangoDbLockDocument`

Do NOT export `ArangoDbAccessor` or `ArangoDbLock`.

### Step 7: Write unit tests (mocked Collection)

**File:** `__tests__/arangodb-lock-provider.test.ts`

Mock the `Collection` and the transaction object. The `Collection` is complex because `lock()` calls `collection.database().beginTransaction(...)` which returns a transaction with `commit()` / `abort()`. Build the mock as:

```typescript
const txn = { commit: vi.fn().mockResolvedValue(undefined), abort: vi.fn().mockResolvedValue(undefined) };
const database = { beginTransaction: vi.fn().mockResolvedValue(txn) };
const collection = {
  name: 'shedLock',
  database: vi.fn().mockReturnValue(database),
  document: vi.fn(),
  save: vi.fn().mockResolvedValue({}),
  update: vi.fn().mockResolvedValue({}),
} as unknown as Collection<ArangoDbLockDocument>;
const provider = new ArangoDbLockProvider(collection);
```

Use `ClockProvider.setClock(() => fixedTime)` to make `now` deterministic.

- `lock()`:
  - First lock (doc not found):
    - `collection.document` rejects with `{ errorNum: 1202, name: 'ArangoError' }` → `collection.save` called with `{ _key, lockUntil, lockedAt, lockedBy }` → `txn.commit` called → `ArangoDbLock` returned.
    - Assert `beginTransaction` called with `{ exclusiveCollections: ['shedLock'] }`.
    - Assert ISO strings in `save` payload.
  - Lock expired (doc exists, `lockUntil <= now`):
    - `collection.document` resolves with `{ _key, lockUntil: pastIso, lockedAt, lockedBy }` → `collection.update` called → `txn.commit` called → `ArangoDbLock` returned.
  - Lock held (doc exists, `lockUntil > now`):
    - `collection.document` resolves with `{ lockUntil: futureIso }` → `txn.abort` called → `undefined` returned.
    - Assert `collection.save` and `collection.update` NOT called.
  - `collection.document` rejects with non-1202 error → `txn.abort` called, error propagates.
- `extend()`:
  - Doc exists, `lockedBy === hostname`, `lockUntil > now` → `collection.update` called with new `lockUntil` → `ArangoDbLock` returned.
  - `lockedBy !== hostname` → `undefined`, `update` NOT called.
  - `lockUntil <= now` → `undefined`, `update` NOT called.
  - Doc not found (`errorNum: 1202`) → `undefined`.
- `unlock()`:
  - Assert `collection.update` called with `{ lockUntil: isoUnlockTime }`.
  - With `lockAtLeastFor=5s`, assert `unlockTime > now` (minimum hold time honored).
  - With `lockAtLeastFor=0`, assert `unlockTime === now`.
  - `update` rejects with `errorNum: 1202` → swallowed (no throw).
  - `update` rejects with other error → propagates.

### Step 8: Write integration tests (testcontainers ArangoDB)

**File:** `__tests__/integration/arangodb-lock-provider.integration.test.ts`

- Use `testcontainers` ArangoDB image:
  ```typescript
  import { ArangoDBContainer } from '@testcontainers/arangodb';
  const container = await new ArangoDBContainer('arangodb:3.11').start();
  const db = new Database({ url: container.getUrl() });
  await db.createDatabase('tslock-test');
  const database = db.database('tslock-test');
  await database.createCollection('shedlock-test');
  ```
- `beforeAll`:
  1. Start container.
  2. Create `Database`, `database = db.database('tslock-test')`.
  3. `await database.createCollection('shedlock-test')` — stream transactions require the collection to exist.
  4. `provider = createArangoDbLockProvider(database, { collection: 'shedlock-test' })`.
- `afterAll`: drop database, close connection, stop container.
- `beforeEach`: `await database.collection('shedlock-test').truncate()`, `ClockProvider.resetClock()`.
- Call `lockProviderIntegrationTests(async () => provider, { timeMode: 'real' })` and `extensibleLockProviderIntegrationTests(async () => provider, { timeMode: 'real' })`.

### Step 9: Verify

```bash
cd packages/arangodb
pnpm typecheck
pnpm test            # unit tests (no Docker required)
pnpm test:integration  # requires Docker
pnpm build
```

All must pass with zero errors.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `arangojs` stream-transaction API differs across versions | The current `arangojs` v8 API exposes `db.transaction()` + `trx.step()` + `trx.commit()`/`trx.abort()`. Older v7 exposed `db.beginTransaction(options)` returning a `Transaction` with direct collection operations. Pin `arangojs: "^8.0.0"` in `peerDependencies`. If the installed version exposes `db.transaction()` instead of `beginTransaction`, adapt the accessor to use `trx.step(() => collection.document(...), { read: [...] })` / `trx.step(() => collection.save(...), { write: [...] })` / `trx.commit()` / `trx.abort()`. The exclusive-collection semantics are identical; only the call shape differs. Document the chosen API in the accessor's module header. |
| `exclusiveCollections` is Enterprise-only in ArangoDB | On the Community Edition, `exclusiveCollections` is rejected. Fall back to `writeCollections: [collectionName]` — write transactions on the same collection are serialized by ArangoDB, which provides the same at-most-one guarantee for this provider's read-then-write pattern. Detect the edition at runtime by catching the "not supported" error and retrying with `writeCollections`, OR document the requirement and let users on Community Edition pass a flag. **Decision:** support both — try `exclusiveCollections`, fall back to `writeCollections` on error. Document this in the README. |
| Stream transactions require the collection to pre-exist | `database.collection(name)` returns a handle; it does not create the collection. `beginTransaction` fails if the collection does not exist. Document that users must create the collection before the first `lock()` call. The integration test's `beforeAll` calls `database.createCollection`. |
| `collection.database()` returns the database handle | Verify this method exists on the `arangojs` `Collection` type. If not, accept the `Database` in the accessor constructor alongside the `Collection`. **Decision:** accept both — the accessor stores the `database` reference passed from the provider to avoid relying on `collection.database()`. |
| `Date.parse` on ISO-8601 strings is timezone-safe | `Utils.toIsoString` always produces UTC `Z`-suffixed strings; `Date.parse` interprets them as UTC. No timezone drift. Unit test with a known timestamp. |
| `txn.abort()` called twice (once in the held-lock path, once in `catch`) | The held-lock path calls `abort()` then returns `undefined` — it does NOT throw, so the `catch` is not entered. The `catch` only runs when an operation throws. No double-abort. Still, wrap `abort()` in `try/catch` (best-effort) in case the server already rolled back the transaction. |
| ArangoDB testcontainer image edition (Community vs Enterprise) | The public `arangodb:3.11` image is Community Edition — `exclusiveCollections` will fail. The integration test must use the `writeCollections` fallback. Verify the fallback path works; if the spec's `exclusiveCollections` is required, use the ArangoDB Enterprise image (`arangodb/enterprise:3.11`) for the integration test. **Decision:** integration test uses Community image + `writeCollections` fallback; unit tests cover both `exclusiveCollections` and `writeCollections` code paths. |
| `collection.update` on a non-existent key throws (not a no-op) | Unlike MongoDB, ArangoDB's `update` throws `ERROR_ARANGO_DOCUMENT_NOT_FOUND` (`1202`) when the key does not exist. The `unlock()` and `extend()` paths catch `1202` and treat it as a benign no-op. Unit test covers this. |
| No `@testcontainers/arangodb` package | Verify a `testcontainers` ArangoDB module exists. If not, use `GenericContainer` with the `arangodb` image, expose port `8529`, and build the `Database` from the mapped URL. The `arangojs` `Database` constructor accepts `{ url }`. |

## Estimation

~5 source files, ~300-400 lines of implementation + ~300-400 lines of tests. Half a focused session with Docker.

## Order of Implementation

1. Package scaffolding (`package.json`, `tsconfig.json`, `tsup.config.ts`)
2. `ArangoDbLockDocument` interface
3. `ArangoDbAccessor` (the meat — stream transaction + document ops + `isDocumentNotFoundError` helper; handle `exclusiveCollections` / `writeCollections` fallback)
4. `ArangoDbLock` (thin `AbstractSimpleLock` subclass)
5. `ArangoDbLockProvider` + `createArangoDbLockProvider` factory
6. `index.ts` exports
7. Unit tests (mocked `Collection` + transaction)
8. Integration tests (testcontainers ArangoDB, Community image + `writeCollections` fallback)
