# Spec: @tslock/spanner

## Overview

The `@tslock/spanner` package implements distributed locks backed by Google Cloud Spanner. It uses Spanner's read-write transactions combining the `Mutation` API for inserts and read-then-mutate updates with DML `UPDATE` statements for conditional unlock/extend operations. The package implements `StorageAccessor` from `@tslock/core` and wraps it with `StorageBasedLockProvider`.

This is a port of ShedLock's `SpannerLockProvider` (Java), adapted to TypeScript and the `@google-cloud/spanner` Node.js client.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/spanner` |
| **Driver** | `@google-cloud/spanner` (peer dependency) |
| **Core dependency** | `@tslock/core` (peer dependency) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS (tsup) |
| **Test strategy** | Unit tests only — no reliable Spanner emulator exists |

## Public API

### 1. SpannerConfiguration

```typescript
import type { DatabaseClient } from '@google-cloud/spanner';

interface SpannerConfiguration {
  /** Spanner DatabaseClient (from spanner.instance(i).database(d)). */
  readonly databaseClient: DatabaseClient;
  /** Lock table name. Defaults to "shedlock". Must exist. */
  readonly tableName?: string;
  /** Column name overrides. Defaults match ShedLock. */
  readonly columnNames?: Partial<SpannerColumnNames>;
  /** Value written to the lockedBy column. Defaults to Utils.getHostname(). */
  readonly lockedByValue?: string;
}

interface SpannerColumnNames {
  readonly name: string;       // default "name"
  readonly lockUntil: string; // default "lockUntil"
  readonly lockedAt: string;  // default "lockedAt"
  readonly lockedBy: string;  // default "lockedBy"
}
```

**Validation** (in `resolveSpannerConfiguration`, called by `createSpannerProvider`):
- `databaseClient` required.
- `tableName` non-empty if provided; must match `^[A-Za-z_][A-Za-z0-9_]*$`.
- Each provided `columnNames.*` non-empty and must match the identifier regex.
- Defaults applied when omitted.

### 2. createSpannerProvider

```typescript
function createSpannerProvider(config: SpannerConfiguration): StorageBasedLockProvider;
```

Constructs a `SpannerStorageAccessor` from the resolved configuration and wraps it:
```typescript
return new StorageBasedLockProvider(new SpannerStorageAccessor(resolved));
```

The returned `StorageBasedLockProvider` implements `ExtensibleLockProvider` (extend is supported).

### 3. SpannerStorageAccessor

Implements `StorageAccessor` from `@tslock/core`. Exported for advanced use and testing.

```typescript
class SpannerStorageAccessor extends AbstractStorageAccessor {
  constructor(config: SpannerConfiguration);

  async insertRecord(config: LockConfiguration): Promise<boolean>;
  async updateRecord(config: LockConfiguration): Promise<boolean>;
  async unlock(config: LockConfiguration): Promise<void>;
  async extend(config: LockConfiguration): Promise<boolean>;
}
```

#### insertRecord

Acquire a lock by inserting a new row. Atomic at Spanner level — `Mutation.insert` fails at commit if a row with the same primary key already exists.

**Mechanism:**
```typescript
await databaseClient.readWriteTransaction().run(async (txn) => {
  txn.add(Mutation.insert({
    table: tableName,
    columns: [nameCol, lockUntilCol, lockedAtCol, lockedByCol],
    values: [
      config.name,
      Utils.toIsoString(lockAtMostUntil(config)),
      Utils.toIsoString(ClockProvider.now()),
      lockedByValue,
    ],
  }));
});
```

**Returns:** `true` if the insert committed (row was new). `false` if the insert failed because the row already exists — the accessor catches the Spanner insert-conflict error (`FAILED_PRECONDITION` / `ALREADY_EXISTS`).

**On other errors:** propagate (network, auth, schema mismatch).

#### updateRecord

Acquire a lock by updating an existing, expired row. Read-then-mutate within a single transaction — Spanner's row locks guarantee atomicity.

**Mechanism:**
```typescript
return await databaseClient.readWriteTransaction().run(async (txn) => {
  const [row] = await txn.readRow({
    table: tableName,
    keys: [config.name],
    columns: [lockUntilCol],
  });
  if (!row) return false;                                  // row missing
  const currentLockUntil = Date.parse(row[lockUntilCol]);
  if (currentLockUntil > ClockProvider.now()) return false;  // still locked
  txn.add(Mutation.update({
    table: tableName,
    columns: [nameCol, lockUntilCol, lockedAtCol, lockedByCol],
    values: [
      config.name,
      Utils.toIsoString(lockAtMostUntil(config)),
      Utils.toIsoString(ClockProvider.now()),
      lockedByValue,
    ],
  }));
  return true;
});
```

**Returns:** `true` if the row existed and was expired (updated). `false` if the row doesn't exist or is still locked.

**Atomicity:** Spanner read-write transactions acquire locks on rows read within the transaction. Concurrent `updateRecord` calls on the same row serialize via these locks; the transaction commits atomically.

#### unlock

Release the lock by setting `lockUntil = unlockTime(config)`. Conditional on `name` AND `lockedBy` matching our identity (prevents unlocking a lock we no longer own after expiry).

**Mechanism:**
```typescript
await databaseClient.readWriteTransaction().run(async (txn) => {
  await txn.runUpdate({
    sql: `UPDATE \`${tableName}\`
          SET \`${lockUntilCol}\` = @unlockTime
          WHERE \`${nameCol}\` = @name
            AND \`${lockedByCol}\` = @lockedBy`,
    params: {
      unlockTime: Utils.toIsoString(unlockTime(config)),
      name: config.name,
      lockedBy: lockedByValue,
    },
  });
});
```

**Returns:** `void`. Best-effort — if 0 rows are affected (lock already expired and taken by another instance), the unlock is a no-op. The accessor does not throw; the lock is no longer ours.

#### extend

Extend the lock's `lockUntil` to `lockAtMostUntil(newConfig)`. Conditional on `name` AND `lockedBy` matching AND `lockUntil > now` (lock still valid — not expired).

**Mechanism:**
```typescript
return await databaseClient.readWriteTransaction().run(async (txn) => {
  const [rowCount] = await txn.runUpdate({
    sql: `UPDATE \`${tableName}\`
          SET \`${lockUntilCol}\` = @lockUntil
          WHERE \`${nameCol}\` = @name
            AND \`${lockedByCol}\` = @lockedBy
            AND \`${lockUntilCol}\` > @now`,
    params: {
      lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
      name: config.name,
      lockedBy: lockedByValue,
      now: Utils.toIsoString(ClockProvider.now()),
    },
  });
  return rowCount > 0;
});
```

**Returns:** `true` if the row was updated (lock still ours and valid). `false` if the lock expired, was taken by another instance, or no longer belongs to us.

### 4. Locking Mechanism (end-to-end)

`StorageBasedLockProvider.lock(config)` algorithm (from core, included here for clarity):

1. If the lock name is not in the `LockRecordRegistry`:
   - Call `insertRecord(config)`.
   - Add the name to the registry regardless of result (record now exists or was just created).
   - If `insertRecord` returns `true` → return `new StorageLock` (lock acquired).
2. Call `updateRecord(config)`:
   - If it throws AND we just attempted insert → `clearCache(name)` (record may have been deleted externally), then rethrow.
   - If returns `true` → return `new StorageLock`.
   - If returns `false` → return `undefined` (lock held by another instance).

`StorageLock.unlock()` → `accessor.unlock(config)`.
`StorageLock.extend(newConfig)` → `accessor.extend(newConfig)` returns `true` ? `new StorageLock(newConfig, accessor)` : `undefined`.

### 5. Spanner Transaction Semantics

- **Read-write transactions** use pessimistic row locking. Reads within the transaction acquire locks; concurrent transactions on the same row block until the first commits.
- **Optimistic concurrency** for DML: if a row read in the transaction was modified by a concurrent committed transaction, Spanner aborts and the client library retries the transaction body automatically (up to a configurable limit).
- **`Mutation.insert` conflict** (duplicate primary key) is detected at commit and surfaces as an error — the client does NOT retry this (retrying won't help). The accessor catches it and returns `false`.
- **DML `runUpdate`** returns the count of affected rows; conditional predicates in `WHERE` produce 0 when the condition fails — no error thrown.

### 6. Schema

Spanner requires the lock table to exist before use. TSLock does NOT create it. Recommended schema:

```sql
CREATE TABLE shedlock (
  name      STRING(MAX) NOT NULL,
  lockUntil STRING(MAX) NOT NULL,
  lockedAt  STRING(MAX) NOT NULL,
  lockedBy  STRING(MAX) NOT NULL,
) PRIMARY KEY (name);
```

Fields are stored as ISO-8601 strings via `Utils.toIsoString()` (e.g., `"2018-12-07T12:30:37.810Z"`) for natural sort ordering and portability. `TIMESTAMP` columns are not used by default — if desired, the user may subclass `SpannerStorageAccessor` and override the read/write conversions.

## Error Handling

| Situation | Behavior |
|---|---|
| Insert fails — row already exists | Return `false` from `insertRecord` (not an error) |
| Update — row missing | Return `false` (record was deleted externally) |
| Update — row still locked (`lockUntil > now`) | Return `false` (lock held) |
| Unlock — 0 rows affected (lock expired/lost) | No-op, return `void` (not an error) |
| Extend — 0 rows affected (lock expired/lost) | Return `false` (not an error) |
| Transaction aborted (concurrent modification) | Spanner client auto-retries; if exhausted, propagate `AbortedError` |
| Network / auth / permission error | Propagate the driver error |
| Schema mismatch (column not found) | Propagate (indicates misconfiguration) |

## Dependencies

- **Peer**: `@tslock/core`, `@google-cloud/spanner`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`

## Exports

From `src/index.ts`:
- `createSpannerProvider`
- `SpannerConfiguration`, `SpannerColumnNames` (types)
- `SpannerStorageAccessor` (advanced use / testing)

Re-exports from `@tslock/core`: `StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `LockProvider`, `ExtensibleLockProvider`, `SimpleLock`, `LockException`.

## File Structure

```
packages/spanner/
├── src/
│   ├── index.ts                       # public exports
│   ├── spanner-configuration.ts        # SpannerConfiguration, SpannerColumnNames, defaults + validation
│   ├── spanner-storage-accessor.ts     # SpannerStorageAccessor (StorageAccessor impl)
│   └── spanner-lock-provider.ts       # createSpannerProvider factory
├── __tests__/
│   ├── spanner-storage-accessor.test.ts   # unit tests with mocked DatabaseClient
│   ├── spanner-lock-provider.test.ts      # unit tests via StorageBasedLockProvider contract
│   └── integration.test.ts               # contract tests (mock-backed, no emulator)
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Non-Goals

- No schema migration — the user creates the table.
- No `TIMESTAMP` column support out of the box (`STRING` ISO-8601 only; subclass to override).
- No Spanner emulator integration tests — no reliable emulator exists; rely on unit tests with mocked `DatabaseClient` and optional manual live-integration tests.
- No multi-table / sharded locking — one table per provider instance.
- No `useDbTime` equivalent in v1 (Spanner `CURRENT_TIMESTAMP()` could be used in DML, but not implemented — clock drift is handled by the NTP-synchronized-clocks assumption documented in the vision).
