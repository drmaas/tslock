# Implementation Plan: @tslock/firestore

## Overview

Build the `@tslock/firestore` package: a `StorageAccessor` backed by Google Cloud Firestore, wrapped in `StorageBasedLockProvider`. Operations use `firestore.runTransaction(async (txn) => ...)` with `txn.get` (read) and `txn.create` / `txn.update` (write) for atomic conditional updates.

Integration tests run against the Firestore emulator via `@firebase/rules-unit-testing` (preferred — auto-starts the emulator) or `gcloud beta emulators firestore start`.

## Prerequisites

- `@tslock/core` and `@tslock/test-support` available in the pnpm workspace.
- `@google-cloud/firestore` available (peer dep; devDep for types + tests).
- Firestore emulator available:
  - Preferred: `@firebase/rules-unit-testing` (bundles its own emulator binary, no external process needed).
  - Alternative: `gcloud components install cloud-firestore-emulator` and run `gcloud beta emulators firestore start`.

## Steps

### Step 1: Initialize package

```
packages/firestore/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts
```

**`package.json`:**
```json
{
  "name": "@tslock/firestore",
  "version": "1.0.0",
  "description": "TSLock provider for Google Cloud Firestore",
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
  "engines": { "node": ">=22" },
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "@google-cloud/firestore": "^7.0.0"
  },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*",
    "@google-cloud/firestore": "^7.0.0",
    "@firebase/rules-unit-testing": "^3.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsup": "^8.0.0"
  }
}
```

**`tsup.config.ts`:** standard (entry `src/index.ts`, format `['esm','cjs']`, dts, sourcemap, clean).

**`tsconfig.json`:** extends root `tsconfig.base.json`.

### Step 2: Implement FirestoreConfiguration

**File:** `src/firestore-configuration.ts`

- `FirestoreFieldNames` interface (defaults: lockUntil="lockUntil", lockedAt="lockedAt", lockedBy="lockedBy").
- `FirestoreConfiguration` interface.
- `DEFAULT_FIELD_NAMES` constant.
- `resolveFirestoreConfiguration(input): ResolvedFirestoreConfiguration`:
  - Merge `fieldNames` partial over defaults.
  - `collectionName = input.collectionName ?? 'shedlock'`.
  - `lockedByValue = input.lockedByValue ?? Utils.getHostname()`.
  - `useTimestamps = input.useTimestamps ?? false`.
  - Validate: `firestore` required; `collectionName` non-empty; field names non-empty.
  - Return a frozen resolved object with plain readonly fields.

### Step 3: Implement FirestoreStorageAccessor

**File:** `src/firestore-storage-accessor.ts`

```typescript
class FirestoreStorageAccessor extends AbstractStorageAccessor {
  constructor(config: FirestoreConfiguration);
}
```

Stored fields (from resolved config): `firestore`, `collectionName`, `fieldNames` (`{ lockUntil, lockedAt, lockedBy }`), `lockedByValue`, `useTimestamps`.

Private helpers:
- `docRef(name): DocumentReference` returns `this.firestore.collection(this.collectionName).doc(name)`.
- `toFieldValue(epochMillis): string | Timestamp` returns ISO string or `Timestamp.fromMillis(epochMillis)` based on `useTimestamps`.
- `parseFieldValue(value): number` returns `value.toMillis()` if `value instanceof Timestamp`, else `Date.parse(value)`.
- `toData(config): Record<string, string | Timestamp>` returns `{ [lockUntil]: toFieldValue(lockAtMostUntil(config)), [lockedAt]: toFieldValue(now), [lockedBy]: lockedByValue }`.

#### insertRecord

```typescript
async insertRecord(config: LockConfiguration): Promise<boolean> {
  const ref = this.docRef(config.name);
  return await this.firestore.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (snap.exists) return false;
    txn.create(ref, this.toData(config));
    return true;
  });
}
```

#### updateRecord

```typescript
async updateRecord(config: LockConfiguration): Promise<boolean> {
  const ref = this.docRef(config.name);
  return await this.firestore.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    const current = this.parseFieldValue(snap.get(this.fieldNames.lockUntil));
    if (current > ClockProvider.now()) return false;
    txn.update(ref, this.toData(config));
    return true;
  });
}
```

#### unlock

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const ref = this.docRef(config.name);
  await this.firestore.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return;
    if (snap.get(this.fieldNames.lockedBy) !== this.lockedByValue) return;
    txn.update(ref, {
      [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)),
    });
  });
}
```

#### extend

```typescript
async extend(config: LockConfiguration): Promise<boolean> {
  const ref = this.docRef(config.name);
  return await this.firestore.runTransaction(async (txn) => {
    const snap = await txn.get(ref);
    if (!snap.exists) return false;
    if (snap.get(this.fieldNames.lockedBy) !== this.lockedByValue) return false;
    const current = this.parseFieldValue(snap.get(this.fieldNames.lockUntil));
    if (current < ClockProvider.now()) return false;
    txn.update(ref, {
      [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
    });
    return true;
  });
}
```

### Step 4: Implement createFirestoreProvider

**File:** `src/firestore-lock-provider.ts`

```typescript
function createFirestoreProvider(config: FirestoreConfiguration): StorageBasedLockProvider {
  return new StorageBasedLockProvider(new FirestoreStorageAccessor(config));
}
```

### Step 5: Wire index.ts

**File:** `src/index.ts`

Export `createFirestoreProvider`, `FirestoreConfiguration`, `FirestoreFieldNames`, `FirestoreStorageAccessor`, plus core re-exports (`StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `LockProvider`, `ExtensibleLockProvider`, `SimpleLock`, `LockException`).

### Step 6: Write unit tests — FirestoreStorageAccessor

**File:** `__tests__/firestore-storage-accessor.test.ts`

Mock the `Firestore` client and its `runTransaction(callback)` method. The mock invokes `callback` with a fake `txn` exposing:
- `get(ref)` returns a fake `DocumentSnapshot` with `exists: boolean` and `get(field): any`, configured per test.
- `create(ref, data)` records the call; optionally throws a "already exists" error when configured.
- `update(ref, data)` records the call.

Tests:

**insertRecord:**
- `snap.exists = false` → `txn.create` called with `toData(config)`, returns `true`.
- `snap.exists = true` → returns `false`, no `create`.
- `txn.create` throws "already exists" → returns `false` (simulates retry exhaustion where the doc was created by a concurrent transaction).

**updateRecord:**
- `snap.exists = false` → returns `false`, no `update`.
- `snap.exists = true`, `lockUntil` in past → `txn.update` called with `toData(config)`, returns `true`.
- `snap.exists = true`, `lockUntil` in future → returns `false`, no `update`.

**unlock:**
- `snap.exists = false` → no-op.
- `snap.exists = true`, `lockedBy` matches → `txn.update` called with `lockUntil = unlockTime` (only the `lockUntil` field is written).
- `snap.exists = true`, `lockedBy` mismatch → no `update`.

**extend:**
- `snap.exists = true`, `lockedBy` matches, `lockUntil >= now` → `txn.update` called, returns `true`.
- `lockedBy` mismatch → returns `false`, no `update`.
- `lockUntil < now` (expired) → returns `false`, no `update`.
- `snap.exists = false` → returns `false`.

**Field encoding:**
- `useTimestamps: false` (default) → values written via `toData` are ISO strings; `parseFieldValue` uses `Date.parse`.
- `useTimestamps: true` → values written are `Timestamp` objects; `parseFieldValue` uses `toMillis()`.
- Round-trip: a value written by `toFieldValue` parses back to the same epoch millis via `parseFieldValue`.

**Configuration / hostname:**
- `lockedByValue` defaults to `Utils.getHostname()` when not provided.
- Custom `lockedByValue` appears in `toData` and unlock/extend `lockedBy` comparisons.
- Custom `collectionName` and `fieldNames` appear in `docRef` and field keys.

### Step 7: Write unit tests — provider via StorageBasedLockProvider

**File:** `__tests__/firestore-lock-provider.test.ts`

Same mock-based approach as Step 6, but exercise `createFirestoreProvider(...).lock(config)`:
- First lock on a name → `insertRecord` returns `true` → lock acquired.
- Second lock on same name → `insertRecord` returns `false` → `updateRecord` returns `true` → lock acquired.
- `insertRecord` false + `updateRecord` false → returns `undefined`.
- `updateRecord` throws after a fresh insert → `clearCache(name)` called (verify via another lock attempt observing `insertRecord` called again).
- `StorageLock.unlock()` → `accessor.unlock` called.
- `StorageLock.extend(newConfig)` → `accessor.extend` returns `true` → new `StorageLock`; `false` → `undefined`.
- Double `unlock()` on the same `StorageLock` → second throws `LockException`.

### Step 8: Set up Firestore emulator integration tests

**File:** `__tests__/integration.test.ts`

Use `@firebase/rules-unit-testing` to obtain an emulator-backed Firestore instance:

```typescript
import { initializeTestApp, cleanupAllTestApps } from '@firebase/rules-unit-testing';
import { createFirestoreProvider } from '../src/index.js';
import { storageBasedLockProviderIntegrationTests } from '@tslock/test-support';

let firestore: Firestore;
beforeAll(async () => {
  const app = initializeTestApp({ projectId: 'tslock-test' });
  firestore = app.firestore();
});
afterAll(async () => {
  await cleanupAllTestApps();
});

describe('FirestoreLockProvider (emulator)', () => {
  storageBasedLockProviderIntegrationTests(
    async () => createFirestoreProvider({ firestore }),
    { timeMode: 'real', getAccessor: ... },
  );
});
```

`@firebase/rules-unit-testing` auto-starts the emulator on `localhost:8080` when `FIRESTORE_EMULATOR_HOST` is not set; alternatively set `FIRESTORE_EMULATOR_HOST` and run `gcloud beta emulators firestore start` separately. The preferred CI path is `@firebase/rules-unit-testing` (no external process).

**Cleanup between tests:** delete all documents in the `shedlock` collection in `beforeEach`, or use a unique collection name per test run (simpler — pass `collectionName: 'shedlock-' + uniqueId()` per test). The contract's `uniqueLockName()` helper already unique-ifies lock names per test, so document accumulation across tests within a run is minimal; cross-run cleanup uses a collection delete.

Configure a separate `vitest.integration.config.ts` that:
- Sets `FIRESTORE_EMULATOR_HOST=localhost:8080` (or relies on `@firebase/rules-unit-testing`).
- Includes only `__tests__/integration/**`.
- Excludes integration tests from the default `pnpm test` run (they require the emulator).

Tests covered by the shared contract (no need to re-implement):
- `shouldLockOnce`, `shouldSkipIfLocked`, `shouldUnlock`, `shouldLockAtLeastFor`, `shouldNotExtendIfNotExtensible`
- `shouldExtendLock`, `shouldNotExtendIfExpired`
- `shouldCreateLockRecord`, `shouldNotCreateDuplicateRecord`, `shouldUpdateRecordIfExpired`
- `shouldHandleConcurrentLockAttempts` (fuzz)

### Step 9: Verify

```bash
cd packages/firestore
pnpm typecheck
pnpm test              # unit tests (mocked)
pnpm test:integration  # emulator-backed contract tests (requires emulator)
pnpm build
```

Document the integration test preflight in the package README:

```bash
# Option A: @firebase/rules-unit-testing auto-starts the emulator (preferred for CI)
pnpm test:integration

# Option B: manual emulator
gcloud beta emulators firestore start --host-port=localhost:8080
FIRESTORE_EMULATOR_HOST=localhost:8080 pnpm test:integration
```

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| Firestore emulator behavior differs from production (esp. transaction retry semantics) | Run fuzz tests against emulator; document that production retry semantics may differ. Provide a skipped live-integration test for manual GCP verification. |
| `@firebase/rules-unit-testing` version mismatch with `@google-cloud/firestore` | Pin compatible majors in devDeps. Test matrix in CI. |
| Emulator startup flakiness in CI | Use `@firebase/rules-unit-testing`'s built-in emulator (no external process). Add wait-for-ready logic in `beforeAll`. |
| Field encoding (ISO string vs Timestamp) mode confusion | Mode is fixed at provider construction; document that mixing modes across instances on the same collection corrupts locks. Unit-test both modes and the round-trip. |
| Document ID character restrictions (no `/`, non-empty, <= 1500 bytes UTF-8) | Document; user is responsible for lock names. TSLock does not validate per-call names (overhead). Invalid names surface as Firestore errors. |
| Transaction retry exhaustion surfaces as an error | Propagate. Document. |
| Large number of lock documents accumulate in the collection | Document that TSLock does not garbage-collect; users can set a Firestore TTL policy on the `lockedAt` field. |
| `instanceof Timestamp` check fails across SDK module duplicates (rare ESM/CJS dual-package hazard) | Document that `useTimestamps` requires a single Firestore SDK instance in the runtime. If cross-realm `instanceof` fails, fall back to duck-typing (`typeof value.toMillis === 'function'`). Add a unit test for the duck-type fallback. |

## Estimation

~4 source files, ~250-350 lines of implementation + ~500-600 lines of tests (unit + integration). Half a session to a full session.

## Order of Implementation

1. Package scaffold.
2. `FirestoreConfiguration` + resolver.
3. `FirestoreStorageAccessor` (insert, update, unlock, extend) with field encoding helpers.
4. `createFirestoreProvider` factory.
5. `index.ts` exports.
6. Unit tests (storage accessor) with mocked Firestore.
7. Unit tests (provider via `StorageBasedLockProvider`).
8. Emulator-backed integration tests (shared contract).
9. Verify (typecheck, unit, integration, build).
