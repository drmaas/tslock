# Implementation Plan: @tslock/datastore

## Overview

Build the `@tslock/datastore` package: a `StorageAccessor` backed by Google Cloud Datastore, wrapped in `StorageBasedLockProvider`. Operations use `datastore.runTransaction(async (txn) => ...)` with `txn.get` (read) and `txn.upsert` (write) for atomic conditional updates.

Integration tests run against the Datastore emulator via `gcloud beta emulators datastore`.

## Prerequisites

- `@tslock/core` and `@tslock/test-support` available in the pnpm workspace.
- `@google-cloud/datastore` available (peer dep; devDep for types + tests).
- Datastore emulator installed (`gcloud components install cloud-datastore-emulator`).

## Steps

### Step 1: Initialize package

```
packages/datastore/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts
```

**`package.json`:**
```json
{
  "name": "@tslock/datastore",
  "version": "1.0.0",
  "description": "TSLock provider for Google Cloud Datastore",
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
    "test:integration": "vitest run --config vitest.integration.config.ts",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "@google-cloud/datastore": "^8.0.0"
  },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*",
    "@google-cloud/datastore": "^8.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsup": "^8.0.0"
  }
}
```

**`tsup.config.ts`:** standard (entry `src/index.ts`, format `['esm','cjs']`, dts, sourcemap, clean).

**`tsconfig.json`:** extends root `tsconfig.base.json`.

### Step 2: Implement DatastoreConfiguration

**File:** `src/datastore-configuration.ts`

- `DatastoreFieldNames` interface (defaults: lockUntil="lockUntil", lockedAt="lockedAt", lockedBy="lockedBy").
- `DatastoreConfiguration` interface.
- `DEFAULT_FIELD_NAMES` constant.
- `resolveDatastoreConfiguration(input): ResolvedDatastoreConfiguration`:
  - Merge `fieldNames` partial over defaults.
  - `entityName = input.entityName ?? 'shedlock'`.
  - `lockedByValue = input.lockedByValue ?? Utils.getHostname()`.
  - `useDate = input.useDate ?? false`.
  - Validate: `datastore` required; `entityName` non-empty; field names non-empty.
  - Return a frozen resolved object with plain readonly fields.

### Step 3: Implement DatastoreStorageAccessor

**File:** `src/datastore-storage-accessor.ts`

```typescript
class DatastoreStorageAccessor extends AbstractStorageAccessor {
  constructor(config: DatastoreConfiguration);
}
```

Stored fields (from resolved config): `datastore`, `entityName`, `fieldNames` (`{ lockUntil, lockedAt, lockedBy }`), `lockedByValue`, `useDate`.

Private helpers:
- `key(lockName): DatastoreKey` returns `this.datastore.key([this.entityName, lockName])`.
- `toFieldValue(epochMillis): string | Date` returns ISO string or `new Date(epochMillis)` based on `useDate`.
- `parseFieldValue(value): number` returns `value.getTime()` if `value instanceof Date`, else `Date.parse(value)`.
- `toData(config): Record<string, string | Date>` returns `{ [lockUntil]: toFieldValue(lockAtMostUntil(config)), [lockedAt]: toFieldValue(now), [lockedBy]: lockedByValue }`.
- `isNotFound(e): boolean` checks `e.code === 5` (gRPC NOT_FOUND) or error message includes "not found".
- `safeGet(txn, key): Promise<entity | undefined>`:
  ```typescript
  try {
    const [entity] = await txn.get(key);
    return entity;
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
  ```

#### insertRecord

```typescript
async insertRecord(config: LockConfiguration): Promise<boolean> {
  const key = this.key(config.name);
  return await this.datastore.runTransaction(async (txn) => {
    const existing = await this.safeGet(txn, key);
    if (existing) return false;
    txn.upsert({ key, data: this.toData(config) });
    return true;
  });
}
```

#### updateRecord

```typescript
async updateRecord(config: LockConfiguration): Promise<boolean> {
  const key = this.key(config.name);
  return await this.datastore.runTransaction(async (txn) => {
    const existing = await this.safeGet(txn, key);
    if (!existing) return false;
    const current = this.parseFieldValue(existing[this.fieldNames.lockUntil]);
    if (current > ClockProvider.now()) return false;
    txn.upsert({ key, data: this.toData(config) });
    return true;
  });
}
```

#### unlock

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const key = this.key(config.name);
  await this.datastore.runTransaction(async (txn) => {
    const existing = await this.safeGet(txn, key);
    if (!existing) return;
    if (existing[this.fieldNames.lockedBy] !== this.lockedByValue) return;
    txn.upsert({
      key,
      data: {
        ...existing,
        [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)),
      },
    });
  });
}
```

**Note on spread of `existing`:** Datastore entities returned by `txn.get` are plain objects keyed by field name. Spreading preserves any fields the user may have added to the lock entity (defensive). TSLock only writes `lockUntil`, `lockedAt`, `lockedBy`, but preserving unknown fields avoids data loss on `upsert` (which overwrites the entire entity).

#### extend

```typescript
async extend(config: LockConfiguration): Promise<boolean> {
  const key = this.key(config.name);
  return await this.datastore.runTransaction(async (txn) => {
    const existing = await this.safeGet(txn, key);
    if (!existing) return false;
    if (existing[this.fieldNames.lockedBy] !== this.lockedByValue) return false;
    const current = this.parseFieldValue(existing[this.fieldNames.lockUntil]);
    if (current < ClockProvider.now()) return false;
    txn.upsert({
      key,
      data: {
        ...existing,
        [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
      },
    });
    return true;
  });
}
```

### Step 4: Implement createDatastoreProvider

**File:** `src/datastore-lock-provider.ts`

```typescript
function createDatastoreProvider(config: DatastoreConfiguration): StorageBasedLockProvider {
  return new StorageBasedLockProvider(new DatastoreStorageAccessor(config));
}
```

### Step 5: Wire index.ts

**File:** `src/index.ts`

Export `createDatastoreProvider`, `DatastoreConfiguration`, `DatastoreFieldNames`, `DatastoreStorageAccessor`, plus core re-exports (`StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `LockProvider`, `ExtensibleLockProvider`, `SimpleLock`, `LockException`).

### Step 6: Write unit tests — DatastoreStorageAccessor

**File:** `__tests__/datastore-storage-accessor.test.ts`

Mock the `Datastore` client and its `runTransaction(callback)` method. The mock invokes `callback` with a fake `txn` exposing:
- `get(key)` returns `[entity]` (entity is a plain object) or throws a `NOT_FOUND`-shaped error.
- `upsert({ key, data })` records the call (capture key, data).

Tests:

**insertRecord:**
- `safeGet` returns `undefined` (NOT_FOUND) → `upsert` called with `toData(config)`, returns `true`.
- `safeGet` returns an entity → returns `false`, no `upsert`.

**updateRecord:**
- `safeGet` returns `undefined` → returns `false`, no `upsert`.
- `safeGet` returns entity with `lockUntil` in past → `upsert` called with `toData(config)`, returns `true`.
- `safeGet` returns entity with `lockUntil` in future → returns `false`, no `upsert`.

**unlock:**
- `safeGet` returns `undefined` → no-op.
- `safeGet` returns entity, `lockedBy` matches → `upsert` called with `lockUntil = unlockTime` and other fields preserved (spread).
- `safeGet` returns entity, `lockedBy` mismatch → no `upsert`.

**extend:**
- `safeGet` returns entity, `lockedBy` matches, `lockUntil >= now` → `upsert` called, returns `true`.
- `lockedBy` mismatch → returns `false`, no `upsert`.
- `lockUntil < now` (expired) → returns `false`, no `upsert`.
- `safeGet` returns `undefined` → returns `false`.

**Field encoding:**
- `useDate: false` (default) → values written via `toData` are ISO strings; `parseFieldValue` uses `Date.parse`.
- `useDate: true` → values written are `Date` objects; `parseFieldValue` uses `getTime()`.
- Round-trip: a value written by `toFieldValue` parses back to the same epoch millis via `parseFieldValue`.

**NOT_FOUND handling:**
- `txn.get` throws an error with `code: 5` → `safeGet` returns `undefined`.
- `txn.get` throws an error with message containing "not found" but no `code` field → `safeGet` returns `undefined`.
- `txn.get` throws a non-NOT_FOUND error (e.g., permission denied) → `safeGet` rethrows.

**Spread preservation:**
- `unlock`/`extend` with an entity containing an extra field `foo: "bar"` → `upsert` data includes `foo: "bar"` (preserved via spread).

**Configuration / hostname:**
- `lockedByValue` defaults to `Utils.getHostname()` when not provided.
- Custom `lockedByValue` appears in `toData` and `lockedBy` comparisons.
- Custom `entityName` and `fieldNames` appear in `key` and field keys.

### Step 7: Write unit tests — provider via StorageBasedLockProvider

**File:** `__tests__/datastore-lock-provider.test.ts`

Same mock-based approach as Step 6, but exercise `createDatastoreProvider(...).lock(config)`:
- First lock on a name → `insertRecord` returns `true` → lock acquired.
- Second lock on same name → `insertRecord` returns `false` → `updateRecord` returns `true` → lock acquired.
- `insertRecord` false + `updateRecord` false → returns `undefined`.
- `updateRecord` throws after a fresh insert → `clearCache(name)` called (verify by attempting another lock and observing `insertRecord` called again).
- `StorageLock.unlock()` → `accessor.unlock` called.
- `StorageLock.extend(newConfig)` → `accessor.extend` returns `true` → new `StorageLock`; `false` → `undefined`.
- Double `unlock()` on the same `StorageLock` → second throws `LockException`.

### Step 8: Set up Datastore emulator integration tests

**File:** `__tests__/integration.test.ts`

Start the Datastore emulator via `gcloud beta emulators datastore start` (or spawn from a `globalSetup` hook) and point `DATASTORE_EMULATOR_HOST` at it:

```typescript
import { Datastore } from '@google-cloud/datastore';
import { createDatastoreProvider } from '../src/index.js';
import { storageBasedLockProviderIntegrationTests } from '@tslock/test-support';

let datastore: Datastore;
beforeAll(async () => {
  // Emulator must be running on localhost:8081 (env: DATASTORE_EMULATOR_HOST=localhost:8081)
  datastore = new Datastore({ projectId: 'tslock-test' });
});
afterAll(async () => {
  // cleanup: delete all shedlock entities (query + delete)
});

describe('DatastoreLockProvider (emulator)', () => {
  storageBasedLockProviderIntegrationTests(
    async () => createDatastoreProvider({ datastore }),
    { timeMode: 'real', getAccessor: ... },
  );
});
```

**Cleanup between tests:** delete all entities of the `shedlock` kind in `beforeEach` (query by kind + delete), or rely on the contract's `uniqueLockName()` helper to unique-ify lock names per test (cross-test interference is avoided even without cleanup, but stale entities accumulate).

Configure `vitest.integration.config.ts`:
- Sets `DATASTORE_EMULATOR_HOST=localhost:8081`.
- Includes only `__tests__/integration/**`.
- Excludes integration tests from the default `pnpm test` run.

Tests covered by the shared contract (no need to re-implement):
- `shouldLockOnce`, `shouldSkipIfLocked`, `shouldUnlock`, `shouldLockAtLeastFor`, `shouldNotExtendIfNotExtensible`
- `shouldExtendLock`, `shouldNotExtendIfExpired`
- `shouldCreateLockRecord`, `shouldNotCreateDuplicateRecord`, `shouldUpdateRecordIfExpired`
- `shouldHandleConcurrentLockAttempts` (fuzz)

### Step 9: Verify

```bash
cd packages/datastore
pnpm typecheck
pnpm test              # unit tests (mocked)
pnpm test:integration  # emulator-backed contract tests (requires emulator)
pnpm build
```

Document the integration test preflight in the package README:

```bash
# Terminal 1
gcloud beta emulators datastore start --host-port=localhost:8081 --project=tslock-test
# Terminal 2
DATASTORE_EMULATOR_HOST=localhost:8081 pnpm test:integration
```

For CI, spawn the emulator in `vitest.integration.config.ts`'s `globalSetup` / `globalTeardown` (or a dedicated script), poll the port until ready, then run the tests.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Datastore emulator behavior differs from production (transaction retry, eventual consistency) | Run fuzz tests against emulator. Provide a skipped live-integration test for manual GCP verification. Document emulator limitations in README. |
| `txn.get` NOT_FOUND error shape varies across SDK versions | `isNotFound` checks both `code === 5` (gRPC NOT_FOUND) and message substring. Unit tests cover both shapes. |
| `txn.upsert` overwrites entire entity, losing user-added fields | Spread `existing` into the upsert data to preserve unknown fields. Defensive; TSLock only writes three fields. Unit test verifies spread preservation. |
| Emulator startup flakiness in CI | Spawn emulator in `globalSetup`, wait for ready (poll port), tear down in `globalTeardown`. Or require the emulator to be pre-started and document it. |
| Entity name restrictions (UTF-8, no leading `!`, max 1500 bytes) | Document; user responsible for lock names. TSLock does not validate per-call names (overhead). Invalid names surface as Datastore errors. |
| Transaction retry exhaustion surfaces as an error | Propagate. Document. |
| Namespace handling (Datastore supports namespaces) | Out of scope for v1. User configures namespace via the `Datastore` client constructor (`new Datastore({ namespace })`). TSLock uses whatever the client is configured with. Document. |
| `instanceof Date` check fails across SDK module duplicates (rare ESM/CJS dual-package hazard) | Document that `useDate` requires a single Datastore SDK instance in the runtime. If cross-realm `instanceof` fails, fall back to duck-typing (`typeof value.getTime === 'function' && typeof value.toISOString === 'function'`). Add a unit test for the duck-type fallback. |

## Estimation

~4 source files, ~250-350 lines of implementation + ~500-600 lines of tests (unit + integration). Half a session to a full session.

## Order of Implementation

1. Package scaffold.
2. `DatastoreConfiguration` + resolver.
3. `DatastoreStorageAccessor` (insert, update, unlock, extend) with `safeGet` helper and field encoding.
4. `createDatastoreProvider` factory.
5. `index.ts` exports.
6. Unit tests (storage accessor) with mocked Datastore.
7. Unit tests (provider via `StorageBasedLockProvider`).
8. Emulator-backed integration tests (shared contract).
9. Verify (typecheck, unit, integration, build).
