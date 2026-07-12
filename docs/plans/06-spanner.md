# Implementation Plan: @tslock/spanner

## Overview

Build the `@tslock/spanner` package: a `StorageAccessor` implementation backed by Google Cloud Spanner, wrapped in `StorageBasedLockProvider`. The implementation uses Spanner's read-write transactions with `Mutation.insert` for inserts, read + `Mutation.update` for updates, and DML `UPDATE` statements for unlock/extend.

Testing is unit-only because no reliable Spanner emulator exists. We mock the `DatabaseClient` / transaction interfaces. A skipped live-integration test is provided for manual verification against a real Spanner instance.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace (`StorageBasedLockProvider`, `AbstractStorageAccessor`, `StorageAccessor`, `LockConfiguration`, `Utils`, `ClockProvider`, `lockAtMostUntil`, `unlockTime`)
- `@tslock/test-support` available (for contract tests)
- `@google-cloud/spanner` available in devDependencies (for type imports; peer dep)

## Steps

### Step 1: Initialize package

```
packages/spanner/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/index.ts
```

**`package.json`:**
```json
{
  "name": "@tslock/spanner",
  "version": "1.0.0",
  "description": "TSLock provider for Google Cloud Spanner",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": { ".": { "import": "./dist/index.js", "require": "./dist/index.cjs", "types": "./dist/index.d.ts" } },
  "files": ["dist"],
  "scripts": { "build": "tsup", "test": "vitest run", "typecheck": "tsc --noEmit" },
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "@google-cloud/spanner": "^7.0.0"
  },
  "peerDependenciesMeta": { "@tslock/core": { "optional": false } },
  "devDependencies": {
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*",
    "@google-cloud/spanner": "^7.0.0",
    "typescript": "^5.5.0",
    "vitest": "^2.0.0",
    "tsup": "^8.0.0"
  }
}
```

**`tsup.config.ts`:** standard (entry `src/index.ts`, format `['esm','cjs']`, dts, sourcemap, clean).

**`tsconfig.json`:** extends root `tsconfig.base.json`.

### Step 2: Implement SpannerConfiguration

**File:** `src/spanner-configuration.ts`

- `SpannerColumnNames` interface (defaults: name="name", lockUntil="lockUntil", lockedAt="lockedAt", lockedBy="lockedBy").
- `SpannerConfiguration` interface.
- `DEFAULT_COLUMN_NAMES` constant.
- `resolveSpannerConfiguration(input): ResolvedSpannerConfiguration`:
  - Merge `columnNames` partial over defaults.
  - `tableName = input.tableName ?? 'shedlock'`.
  - `lockedByValue = input.lockedByValue ?? Utils.getHostname()`.
  - Validate: `databaseClient` required; `tableName` and each column name match `^[A-Za-z_][A-Za-z0-9_]*$` (reject to prevent SQL identifier injection — these are trusted config values but validation is cheap).
  - Return a frozen resolved object with plain readonly fields.

### Step 3: Implement SpannerStorageAccessor

**File:** `src/spanner-storage-accessor.ts`

```typescript
class SpannerStorageAccessor extends AbstractStorageAccessor {
  constructor(config: SpannerConfiguration);
}
```

Stored fields (from resolved config): `databaseClient`, `tableName`, `columnNames` (`{ name, lockUntil, lockedAt, lockedBy }`), `lockedByValue`.

Private helpers:
- `toRowValues(config): string[]` returns `[config.name, Utils.toIsoString(lockAtMostUntil(config)), Utils.toIsoString(ClockProvider.now()), lockedByValue]`.
- `isInsertConflictError(e): boolean` checks `e.code` for `ALREADY_EXISTS` (6) or `FAILED_PRECONDITION` (9) with a message substring indicating "already exists".

#### insertRecord

```typescript
async insertRecord(config: LockConfiguration): Promise<boolean> {
  try {
    await this.databaseClient.readWriteTransaction().run(async (txn) => {
      txn.add(Mutation.insert({
        table: this.tableName,
        columns: [this.columnNames.name, this.columnNames.lockUntil,
                  this.columnNames.lockedAt, this.columnNames.lockedBy],
        values: this.toRowValues(config),
      }));
    });
    return true;
  } catch (e) {
    if (isInsertConflictError(e)) return false;
    throw e;
  }
}
```

**Discovery task:** confirm the exact error code/shape for `Mutation.insert` conflicts in the installed `@google-cloud/spanner` version. The Spanner Node SDK has changed this across majors (older: `FAILED_PRECONDITION` with message; newer: `ALREADY_EXISTS`). `isInsertConflictError` must handle both; unit tests cover both shapes.

#### updateRecord

```typescript
async updateRecord(config: LockConfiguration): Promise<boolean> {
  return await this.databaseClient.readWriteTransaction().run(async (txn) => {
    const [row] = await txn.readRow({
      table: this.tableName,
      keys: [config.name],
      columns: [this.columnNames.lockUntil],
    });
    if (!row) return false;
    const currentLockUntil = Date.parse(row[this.columnNames.lockUntil]);
    if (currentLockUntil > ClockProvider.now()) return false;
    txn.add(Mutation.update({
      table: this.tableName,
      columns: [this.columnNames.name, this.columnNames.lockUntil,
                this.columnNames.lockedAt, this.columnNames.lockedBy],
      values: this.toRowValues(config),
    }));
    return true;
  });
}
```

**Note:** `txn.readRow` API signature varies slightly across SDK versions (positional vs options-object). Pin `@google-cloud/spanner` in devDeps and target the current stable. Use the options-object form (`{ table, keys, columns }`) which is stable across recent majors.

#### unlock

Build the DML statement with backtick-quoted identifiers (allows reserved words as column names). The statement shape:

```text
UPDATE `tableName`
SET `lockUntilCol` = @unlockTime
WHERE `nameCol` = @name
  AND `lockedByCol` = @lockedBy
```

Params: `{ unlockTime: Utils.toIsoString(unlockTime(config)), name: config.name, lockedBy: lockedByValue }`.

No return value check — 0 rows affected is fine (lock already expired/lost).

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  await this.databaseClient.readWriteTransaction().run(async (txn) => {
    await txn.runUpdate({
      sql: this.buildUnlockSql(),
      params: {
        unlockTime: Utils.toIsoString(unlockTime(config)),
        name: config.name,
        lockedBy: this.lockedByValue,
      },
    });
  });
}
```

`buildUnlockSql()` returns the statement with `tableName`/`columnNames` interpolated as backtick-quoted identifiers (validated in Step 2).

#### extend

Statement shape:

```text
UPDATE `tableName`
SET `lockUntilCol` = @lockUntil
WHERE `nameCol` = @name
  AND `lockedByCol` = @lockedBy
  AND `lockUntilCol` > @now
```

Params: `{ lockUntil: Utils.toIsoString(lockAtMostUntil(config)), name: config.name, lockedBy: lockedByValue, now: Utils.toIsoString(ClockProvider.now()) }`.

```typescript
async extend(config: LockConfiguration): Promise<boolean> {
  return await this.databaseClient.readWriteTransaction().run(async (txn) => {
    const [rowCount] = await txn.runUpdate({
      sql: this.buildExtendSql(),
      params: {
        lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
        name: config.name,
        lockedBy: this.lockedByValue,
        now: Utils.toIsoString(ClockProvider.now()),
      },
    });
    return rowCount > 0;
  });
}
```

### Step 4: Implement createSpannerProvider

**File:** `src/spanner-lock-provider.ts`

```typescript
function createSpannerProvider(config: SpannerConfiguration): StorageBasedLockProvider {
  const accessor = new SpannerStorageAccessor(config);
  return new StorageBasedLockProvider(accessor);
}
```

### Step 5: Wire index.ts

**File:** `src/index.ts`

Export:
- `createSpannerProvider`
- `SpannerConfiguration`, `SpannerColumnNames` (types)
- `SpannerStorageAccessor`
- Re-export `StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `LockProvider`, `ExtensibleLockProvider`, `SimpleLock`, `LockException` from `@tslock/core`.

### Step 6: Write unit tests — SpannerStorageAccessor

**File:** `__tests__/spanner-storage-accessor.test.ts`

Mock the `DatabaseClient` and its `readWriteTransaction().run(callback)` interface. The mock invokes `callback` with a fake `txn` exposing:
- `add(mutation)` — records the mutation (capture table, columns, values).
- `readRow({ table, keys, columns })` — returns a configurable `[row]` or `[undefined]`.
- `runUpdate({ sql, params })` — returns a configurable `[rowCount]`.

Tests:

**insertRecord:**
- Transaction commits → returns `true`. Assert `Mutation.insert` was added with correct columns and ISO-string values.
- Transaction throws insert-conflict error (`code: 6` ALREADY_EXISTS) → returns `false`.
- Transaction throws insert-conflict error (`code: 9` FAILED_PRECONDITION, message contains "already exists") → returns `false`.
- Transaction throws other error (e.g., permission denied) → throws.

**updateRecord:**
- `readRow` returns row with `lockUntil` in the past → `Mutation.update` added, returns `true`.
- `readRow` returns row with `lockUntil` in the future → returns `false`, no mutation added.
- `readRow` returns `undefined` → returns `false`, no mutation added.
- Assert the mutation uses the configured `tableName` and `columnNames`.

**unlock:**
- `runUpdate` returns `[1]` → resolves without error.
- `runUpdate` returns `[0]` → resolves without error (no-op is fine).
- Assert generated SQL contains `UPDATE ... SET lockUntil = @unlockTime WHERE name = @name AND lockedBy = @lockedBy` (with configured identifiers backtick-quoted).
- Assert params include `unlockTime` (ISO string), `name`, `lockedBy`.

**extend:**
- `runUpdate` returns `[1]` → returns `true`.
- `runUpdate` returns `[0]` → returns `false`.
- Assert generated SQL contains the expected `UPDATE ... WHERE name = @name AND lockedBy = @lockedBy AND lockUntil > @now` shape.
- Assert params include `lockUntil` (ISO string), `name`, `lockedBy`, `now` (ISO string).

**Configuration / hostname:**
- `lockedByValue` defaults to `Utils.getHostname()` when not provided.
- Custom `lockedByValue` appears in mutation values and DML params.
- Custom `tableName` and `columnNames` appear in generated SQL and mutations.
- Invalid `tableName` (e.g., contains spaces or semicolons) is rejected by `resolveSpannerConfiguration`.

### Step 7: Write unit tests — provider via StorageBasedLockProvider

**File:** `__tests__/spanner-lock-provider.test.ts`

Reuse the mock from Step 6 and exercise `createSpannerProvider(...).lock(config)`:
- First lock on a name → `insertRecord` returns `true` → lock acquired.
- Second lock on same name → `insertRecord` returns `false` → `updateRecord` returns `true` → lock acquired.
- `insertRecord` false + `updateRecord` false → returns `undefined`.
- `updateRecord` throws after a fresh insert → `clearCache(name)` called (verify by attempting another lock and observing `insertRecord` is called again).
- `StorageLock.unlock()` → `accessor.unlock` called.
- `StorageLock.extend(newConfig)` → `accessor.extend` returns `true` → new `StorageLock`; `false` → `undefined`.
- Double `unlock()` on the same `StorageLock` → second throws `LockException` (core behavior).

### Step 8: Write contract tests

**File:** `__tests__/integration.test.ts`

Import `storageBasedLockProviderIntegrationTests` from `@tslock/test-support` and run against the mock-backed provider. Since there is no Spanner emulator, the contract tests run against the mocked `DatabaseClient` with `timeMode: 'mock'`. These exercise the `StorageBasedLockProvider` algorithm against a Spanner-shaped accessor — not a true integration test, but the closest available without a real Spanner instance.

Mark these tests with a comment: "Mock-backed — no Spanner emulator exists. For real integration, run `__tests__/live-integration.test.ts` against a live Spanner instance (manual)."

**File:** `__tests__/live-integration.test.ts` (skipped unless env vars set)

```typescript
const INSTANCE = process.env.TSLOCK_SPANNER_INSTANCE;
const DATABASE = process.env.TSLOCK_SPANNER_DATABASE;
const describeLive = INSTANCE && DATABASE ? describe : describe.skip;

describeLive('SpannerLockProvider (live)', () => {
  // connect to real Spanner, run shared contract with timeMode: 'real'
});
```

This keeps live tests out of CI by default but available for manual verification.

### Step 9: Verify

```bash
cd packages/spanner
pnpm typecheck   # tsc --noEmit
pnpm test        # vitest run (mock-backed)
pnpm build       # tsup
```

All must pass. The live-integration test is skipped by default.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| No Spanner emulator — cannot run real integration tests in CI | Unit tests with mocked `DatabaseClient` cover all code paths. Provide a skipped live-integration test for manual verification. Document clearly in README. |
| Spanner SDK API drift across versions (`readRow` signature, error codes) | Pin `@google-cloud/spanner` to a specific major in devDeps. Parameterize the mock to test both error shapes. |
| `Mutation.insert` conflict error code varies (`FAILED_PRECONDITION` vs `ALREADY_EXISTS`) | `isInsertConflictError` checks both `code` and message substring. Unit tests cover both shapes. |
| SQL identifier injection via `tableName` / `columnNames` | Validate against `^[A-Za-z_][A-Za-z0-9_]*$` in `resolveSpannerConfiguration`. Backtick-quote identifiers in generated SQL. |
| Transaction retry exhaustion surfaces as `AbortedError` | Propagate — caller (`StorageBasedLockProvider`) treats it as a storage error. Document. |
| `readRow` returns `null` vs `undefined` across SDK versions | Treat both as "not found" via a `!row` check. Add a test for both. |

## Estimation

~4 source files, ~250-350 lines of implementation + ~400-500 lines of tests. Half a session once core is ready.

## Order of Implementation

1. Package scaffold (`package.json`, `tsup.config.ts`, `tsconfig.json`).
2. `SpannerConfiguration` + resolver + validation.
3. `SpannerStorageAccessor` (insertRecord, updateRecord, unlock, extend) with SQL builder helpers.
4. `createSpannerProvider` factory.
5. `index.ts` exports.
6. Unit tests (storage accessor).
7. Unit tests (provider via `StorageBasedLockProvider`).
8. Contract tests (mock-backed) + skipped live-integration test.
9. Verify (typecheck, test, build).
