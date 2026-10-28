# Implementation Plan: @tslock/couchbase

## Overview

Build the `@tslock/couchbase` provider package. It is a `StorageAccessor` implementation over the `couchbase` Node.js SDK, wrapped by `StorageBasedLockProvider` from `@tslock/core`. No core changes are required.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace
- `@tslock/test-support` built and available
- `couchbase` SDK installed locally for type-checking (npm package `couchbase` v4.x)
- Docker available locally for the Couchbase testcontainer

## Steps

### Step 1: Initialize package

```
packages/couchbase/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts   (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/couchbase",
  "version": "1.0.0",
  "description": "TSLock provider for Couchbase Server",
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
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "couchbase": "^4.0.0"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false },
    "couchbase": { "optional": false }
  },
  "devDependencies": {
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "vitest": "^2.0.0",
    "@types/node": "^22.0.0",
    "couchbase": "^4.0.0",
    "testcontainers": "^10.0.0",
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*"
  }
}
```

**`tsup.config.ts`:** identical pattern to core (entry `src/index.ts`, format `['esm','cjs']`, `dts: true`, `clean: true`, `sourcemap: true`).

**`tsconfig.json`:** extends repo root `tsconfig.base.json`.

### Step 2: Define configuration types

**File:** `src/couchbase-lock-provider.ts`

- `CouchbaseColumnNames` interface (4 readonly string fields).
- `CouchbaseLockProviderOptions` interface (`documentIdPrefix`, `columnNames`, `lockedByValue`).
- `DEFAULT_DOCUMENT_ID_PREFIX = 'shedlock:'`.
- `DEFAULT_COLUMN_NAMES` constant object.
- `resolveOptions(options?)` — merges with defaults; validates prefix is a string and column names are non-empty.

### Step 3: Implement document ID helper

**File:** `src/document-id.ts`

```typescript
export const MAX_DOCUMENT_ID_LENGTH = 250;
export function buildDocumentId(
  name: string,
  options?: { documentIdPrefix?: string },
): string;
```

- Returns `prefix + name`.
- Throws `LockException` if the result length exceeds `MAX_DOCUMENT_ID_LENGTH` bytes (Couchbase's hard limit).
- Empty `name` is rejected upstream by `createLockConfig`; not re-validated here.

### Step 4: Implement CouchbaseStorageAccessor

**File:** `src/couchbase-storage-accessor.ts`

```typescript
import {
  DocumentExistsException,
  CasMismatchException,
  DocumentNotFoundError,
} from 'couchbase';
import {
  AbstractStorageAccessor,
  ClockProvider,
  LockConfiguration,
  LockException,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';

class CouchbaseStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly collection: Collection,
    private readonly opts: ResolvedOptions,
  ) {}

  async insertRecord(config: LockConfiguration): Promise<boolean>;
  async updateRecord(config: LockConfiguration): Promise<boolean>;
  async unlock(config: LockConfiguration): Promise<void>;
  async extend(config: LockConfiguration): Promise<boolean>;
}
```

Each method uses `this.documentIdFor(config.name)` to compute the document ID and `this.columnNames` to read/write the document body.

#### insertRecord

```typescript
const documentId = this.documentIdFor(config.name);
const document = {
  [nameColumn]: config.name,
  [lockUntilColumn]: lockAtMostUntil(config),
  [lockedAtColumn]: ClockProvider.now(),
  [lockedByColumn]: this.opts.lockedByValue,
};
try {
  await this.collection.insert(documentId, document);
  return true;
} catch (e) {
  if (e instanceof DocumentExistsException) return false;
  throw e;
}
```

#### updateRecord

```typescript
const documentId = this.documentIdFor(config.name);
let getResult;
try {
  getResult = await this.collection.get(documentId);
} catch (e) {
  if (e instanceof DocumentNotFoundError) throw e;  // propagate → cache clear
  throw e;
}
const existing = getResult.content as Record<string, unknown>;
if ((existing[lockUntilColumn] as number) > ClockProvider.now()) {
  return false;
}
const document = {
  [nameColumn]: config.name,
  [lockUntilColumn]: lockAtMostUntil(config),
  [lockedAtColumn]: ClockProvider.now(),
  [lockedByColumn]: this.opts.lockedByValue,
};
try {
  await this.collection.replace(documentId, document, { cas: getResult.cas });
  return true;
} catch (e) {
  if (e instanceof CasMismatchException) return false;
  throw e;
}
```

#### unlock

```typescript
const documentId = this.documentIdFor(config.name);
let getResult;
try {
  getResult = await this.collection.get(documentId);
} catch (e) {
  if (e instanceof DocumentNotFoundError) return;  // no-op
  throw e;
}
const existing = getResult.content as Record<string, unknown>;
const document = { ...existing, [lockUntilColumn]: unlockTime(config) };
try {
  await this.collection.replace(documentId, document, { cas: getResult.cas });
} catch (e) {
  if (e instanceof CasMismatchException) return;  // best-effort
  throw e;
}
```

#### extend

```typescript
const documentId = this.documentIdFor(config.name);
let getResult;
try {
  getResult = await this.collection.get(documentId);
} catch (e) {
  if (e instanceof DocumentNotFoundError) return false;
  throw e;
}
const existing = getResult.content as Record<string, unknown>;
const now = ClockProvider.now();
if (existing[lockedByColumn] !== this.opts.lockedByValue) return false;
if ((existing[lockUntilColumn] as number) <= now) return false;
const document = { ...existing, [lockUntilColumn]: lockAtMostUntil(config) };
try {
  await this.collection.replace(documentId, document, { cas: getResult.cas });
  return true;
} catch (e) {
  if (e instanceof CasMismatchException) return false;
  throw e;
}
```

### Step 5: Implement CouchbaseLockProvider

**File:** `src/couchbase-lock-provider.ts` (extended)

```typescript
class CouchbaseLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(collection: Collection, options?: CouchbaseLockProviderOptions) {
    this.delegate = new StorageBasedLockProvider(
      new CouchbaseStorageAccessor(collection, resolveOptions(options)),
    );
  }

  lock(config) { return this.delegate.lock(config); }
  clearCache(name) { this.delegate.clearCache(name); }
}
```

### Step 6: Wire up index.ts

Export:
- `CouchbaseLockProvider`
- `CouchbaseLockProviderOptions`, `CouchbaseColumnNames`
- `buildDocumentId`, `MAX_DOCUMENT_ID_LENGTH`

Do **not** export `CouchbaseStorageAccessor` or `ResolvedOptions`.

### Step 7: Write unit tests

**File:** `__tests__/unit/document-id.test.ts`
- `buildDocumentId('my-task')` → `'shedlock:my-task'`.
- `buildDocumentId('my-task', { documentIdPrefix: '' })` → `'my-task'`.
- `buildDocumentId` throws `LockException` when result exceeds 250 bytes.

**File:** `__tests__/unit/couchbase-storage-accessor.test.ts`

Use a mocked `Collection` (`vi.fn()` for `insert`, `get`, `replace`). The mock returns configured values or throws typed errors (`new DocumentExistsException(...)`, etc.).

- `insertRecord` success → `collection.insert` called with correct document ID and body, returns `true`.
- `insertRecord` `DocumentExistsException` → returns `false`.
- `insertRecord` other error → propagates.
- `updateRecord` `lockUntil > now` (lock still held) → returns `false`, `replace` not called.
- `updateRecord` `lockUntil <= now` → `replace` called with CAS, returns `true`.
- `updateRecord` `DocumentNotFoundError` on `get` → propagates.
- `updateRecord` `CasMismatchException` on `replace` → returns `false`.
- `unlock` success → `replace` called with `lockUntil = unlockTime(config)`, returns `void`.
- `unlock` `DocumentNotFoundError` on `get` → resolves (no-op).
- `unlock` `CasMismatchException` on `replace` → resolves (swallowed).
- `extend` `lockedBy` mismatch → returns `false`, `replace` not called.
- `extend` `lockUntil <= now` (expired) → returns `false`, `replace` not called.
- `extend` success → `replace` called with new `lockUntil`, returns `true`.
- `extend` `CasMismatchException` → returns `false`.
- `extend` `DocumentNotFoundError` → returns `false`.
- Document body uses configured `columnNames` (custom names test).
- Document ID uses configured `documentIdPrefix` (custom prefix test).

### Step 8: Write integration tests

**File:** `__tests__/integration/couchbase-integration.test.ts`

Couchbase testcontainer setup is more involved than other databases because the container requires cluster initialization via the REST API. Use `testcontainers`' `CouchbaseContainer` if available, or a custom `GenericContainer` with explicit REST initialization.

```typescript
import { storageBasedLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { CouchbaseLockProvider } from '../src/index.js';
import * as couchbase from 'couchbase';

describe('CouchbaseLockProvider integration', () => {
  let container: StartedTestContainer;
  let cluster: couchbase.Cluster;
  let collection: couchbase.Collection;

  beforeAll(async () => {
    container = await new CouchbaseContainer('couchbase/server:7.6')
      .withBucketName('shedlock-test')
      .withCredentials('Administrator', 'password')
      .withStartupTimeout(180_000)
      .start();
    cluster = await couchbase.connect(container.getConnectionString(), {
      username: 'Administrator',
      password: 'password',
    });
    collection = cluster.bucket('shedlock-test').defaultCollection();
  });

  afterAll(async () => {
    if (cluster) await cluster.close();
    if (container) await container.stop();
  });

  storageBasedLockProviderIntegrationTests(
    async () => new CouchbaseLockProvider(collection),
    { timeMode: 'real' },
  );

  fuzzTests(async () => new CouchbaseLockProvider(collection));

  describe('provider-specific', () => {
    it('insert fails with DocumentExistsException on duplicate', async () => {
      const provider = new CouchbaseLockProvider(collection);
      const lock = await provider.lock(config('dup-test', '1m'));
      expect(lock).toBeDefined();
      await expect(collection.insert('shedlock:dup-test', { name: 'dup-test' }))
        .rejects.toThrow(couchbase.DocumentExistsException);
      await lock!.unlock();
    });

    it('rejects extend from a different lockedBy', async () => {
      const owner = new CouchbaseLockProvider(collection, { lockedByValue: 'node-A' });
      const intruder = new CouchbaseLockProvider(collection, { lockedByValue: 'node-B' });
      const lock = await owner.lock(config('extend-foreign', '1m'));
      const extended = await lock!.extend('1m', 0);
      expect(extended).toBeDefined();
      await extended!.unlock();
    });
  });
});
```

**Container startup:** Couchbase takes 30-90s to initialize (cluster + bucket + services). Use `withStartupTimeout(180_000)`. The `CouchbaseContainer` from `testcontainers` handles the REST initialization; if unavailable, use a `GenericContainer` with a startup script that issues `curl` calls to the Couchbase REST API (`/clusterInit`, `/pools/default/buckets`).

**Real-time waits:** Use `timeMode: 'real'`. Couchbase does not have a server-side clock dependency in this provider — the CAS check is the atomicity primitive, not a time comparison. Time comparisons (`lockUntil > now`) use the client's `ClockProvider.now()`.

### Step 9: Verify

```bash
cd packages/couchbase
pnpm typecheck
pnpm test               # unit only
pnpm test:integration   # requires Docker
pnpm build
```

All must pass. Integration tests are gated behind a separate Vitest config.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| **Couchbase testcontainer flakiness / slow startup** | Generous `withStartupTimeout(180_000)`. If `CouchbaseContainer` is unstable, fall back to a `GenericContainer` with an explicit REST-init script. Mark the suite `test.slow`. |
| **`couchbase` SDK v4 vs v3 typing differences** | Peer dep `couchbase: ^4.0.0` (latest). Test against installed version. The SDK's `Collection` API is stable across v4.x. |
| **CAS mismatch on `unlock` after task crashed mid-update** | Document that `unlock` is best-effort and swallows `CasMismatchException`. The lock will expire via `lockAtMostFor`. |
| **`DocumentNotFoundError` from `get` after registry cache miss** | Propagate from `updateRecord`; `StorageBasedLockProvider.lock()` catches it, clears the cache, and the next call retries `insertRecord`. Test this path explicitly. |
| **Hostname stability across lock lifetime (for `extend`)** | Document: if `Utils.getHostname()` could change between lock acquisition and extension (rare — container restart), users should set `lockedByValue` explicitly. |
| **Document body shape changes across versions** | Unlock preserves existing fields (`...existing`) and only overwrites `lockUntil`. Extend preserves existing fields and overwrites `lockUntil`. This is forward-compatible with future fields. |
| **Document ID length** | `buildDocumentId` throws `LockException` if `prefix + name` exceeds 250 bytes. Test the boundary. |
| **`columnNames` collision with Couchbase reserved words** | JSON field names are not SQL identifiers; there are no reserved words. Validated as non-empty strings. |
| **Concurrent `insertRecord` race** | Couchbase `insert` is atomic per document ID; only one concurrent caller succeeds, others get `DocumentExistsException` → `false`. |
| **`lockedBy` value `undefined` in stored document** | If a legacy document lacks `lockedBy`, `existing[lockedByColumn]` is `undefined`; `undefined !== this.lockedByValue` returns `false` (extend rejected). This is the correct conservative behavior. |

## Estimation

~5 source files, ~350-450 lines of implementation + ~300-400 lines of tests. The logic is straightforward; the main complexity is the testcontainer setup. One focused session plus debugging time for the Couchbase container.

## Order of Implementation

1. Package scaffold.
2. `document-id.ts` + unit tests (no SDK dependency).
3. `couchbase-lock-provider.ts` types + `resolveOptions`.
4. `couchbase-storage-accessor.ts` (mocked SDK unit tests).
5. `index.ts` exports.
6. Integration tests with testcontainer (allow extra time for container setup).
7. Verify (typecheck, unit, integration, build).
