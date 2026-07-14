# Spec: @tslock/datastore

## Overview

The `@tslock/datastore` package implements distributed locks backed by Google Cloud Datastore. It uses Datastore transactions (`runTransaction`) which provide optimistic concurrency control with automatic retry. The package implements `StorageAccessor` from `@tslock/core` and wraps it with `StorageBasedLockProvider`.

This is a port of ShedLock's `DatastoreLockProvider` (Java), adapted to TypeScript and the `@google-cloud/datastore` Node.js client.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/datastore` |
| **Driver** | `@google-cloud/datastore` (peer dependency) |
| **Core dependency** | `@tslock/core` (peer dependency) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS (tsup) |
| **Test strategy** | Integration tests against Datastore emulator (`gcloud beta emulators datastore`) |

## Public API

### 1. DatastoreConfiguration

```typescript
import type { Datastore } from '@google-cloud/datastore';

interface DatastoreConfiguration {
  /** Datastore client instance. */
  readonly datastore: Datastore;
  /** Entity kind name. Defaults to "shedlock". */
  readonly entityName?: string;
  /** Field name overrides. Defaults match ShedLock. */
  readonly fieldNames?: Partial<DatastoreFieldNames>;
  /** Value written to the lockedBy field. Defaults to Utils.getHostname(). */
  readonly lockedByValue?: string;
  /** Store timestamps as Datastore datetime instead of ISO string. Defaults to false (ISO string). */
  readonly useDate?: boolean;
}

interface DatastoreFieldNames {
  readonly lockUntil: string; // default "lockUntil"
  readonly lockedAt: string;  // default "lockedAt"
  readonly lockedBy: string;  // default "lockedBy"
}
```

The Datastore key is a kind/name path: `[entityName, lockName]`. The lock `name` becomes the entity's string name identifier (not a numeric ID).

**Validation** (in `resolveDatastoreConfiguration`):
- `datastore` required.
- `entityName` non-empty if provided.
- Each provided `fieldNames.*` non-empty.
- Defaults applied when omitted.

### 2. createDatastoreProvider

```typescript
function createDatastoreProvider(config: DatastoreConfiguration): StorageBasedLockProvider;
```

Constructs a `DatastoreStorageAccessor` from the resolved configuration and wraps it:
```typescript
return new StorageBasedLockProvider(new DatastoreStorageAccessor(resolved));
```

The returned provider implements `ExtensibleLockProvider` (extend is supported).

### 3. DatastoreStorageAccessor

Implements `StorageAccessor` from `@tslock/core`. Exported for advanced use and testing.

```typescript
class DatastoreStorageAccessor extends AbstractStorageAccessor {
  constructor(config: DatastoreConfiguration);

  async insertRecord(config: LockConfiguration): Promise<boolean>;
  async updateRecord(config: LockConfiguration): Promise<boolean>;
  async unlock(config: LockConfiguration): Promise<void>;
  async extend(config: LockConfiguration): Promise<boolean>;
}
```

#### Key Construction

```typescript
private key(lockName: string): DatastoreKey {
  return this.datastore.key([this.entityName, lockName]);
}
```

The key is a kind/name path: `[entityName, lockName]`. Datastore uses the lock name as the entity's string name identifier.

#### Field Value Encoding

```typescript
private toFieldValue(epochMillis: number): string | Date {
  return this.useDate ? new Date(epochMillis) : Utils.toIsoString(epochMillis);
}

private parseFieldValue(value: string | Date): number {
  return value instanceof Date ? value.getTime() : Date.parse(value);
}
```

Default mode: ISO-8601 strings. `useDate: true` mode: JS `Date` objects (Datastore persists these as datetime values). Pick one per provider instance; do not mix modes on the same kind.

#### toData (for insert / update)

```typescript
private toData(config: LockConfiguration): Record<string, string | Date> {
  return {
    [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
    [this.fieldNames.lockedAt]: this.toFieldValue(ClockProvider.now()),
    [this.fieldNames.lockedBy]: this.lockedByValue,
  };
}
```

#### safeGet helper

`txn.get(key)` in the `@google-cloud/datastore` client throws an error with gRPC code `NOT_FOUND` (5) when the entity doesn't exist. The accessor wraps the read to treat `NOT_FOUND` as "no entity":

```typescript
private async safeGet(txn: Transaction, key: DatastoreKey): Promise<entity | undefined> {
  try {
    const [entity] = await txn.get(key);
    return entity;
  } catch (e) {
    if (isNotFound(e)) return undefined;
    throw e;
  }
}
```

`isNotFound(e)` checks `e.code === 5` (gRPC NOT_FOUND) or the error message contains "not found".

#### insertRecord

Acquire a lock by creating an entity. `txn.upsert` creates or overwrites, so the existence check within the transaction provides the conditional-insert semantics (concurrent modification aborts the transaction).

**Mechanism:**
```typescript
const key = this.key(config.name);
return await this.datastore.runTransaction(async (txn) => {
  const existing = await this.safeGet(txn, key);
  if (existing) return false;
  txn.upsert({ key, data: this.toData(config) });
  return true;
});
```

**Returns:** `true` if the entity was created. `false` if it already existed.

#### updateRecord

Acquire a lock by updating an existing, expired entity. Read-then-upsert within the transaction; Datastore's optimistic concurrency ensures atomicity.

**Mechanism:**
```typescript
const key = this.key(config.name);
return await this.datastore.runTransaction(async (txn) => {
  const existing = await this.safeGet(txn, key);
  if (!existing) return false;
  const current = this.parseFieldValue(existing[this.fieldNames.lockUntil]);
  if (current > ClockProvider.now()) return false;
  txn.upsert({ key, data: this.toData(config) });
  return true;
});
```

**Returns:** `true` if the entity existed and was expired. `false` otherwise.

#### unlock

Release the lock by setting `lockUntil = unlockTime(config)`. Conditional on `lockedBy` matching our identity.

**Mechanism:**
```typescript
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
```

**Returns:** `void`. Best-effort — if the entity is missing or owned by another instance, no-op.

**Note on `upsert` with spread:** Datastore entities returned by `txn.get` are plain objects keyed by field name. Spreading `existing` preserves any fields the user may have added to the lock entity (defensive — TSLock only writes `lockUntil`, `lockedAt`, `lockedBy`, but preserving unknown fields avoids data loss). `txn.update` would merge instead of overwrite, but `update` fails if the entity doesn't exist; `upsert` with spread is safer since we already checked existence.

#### extend

Extend the lock's `lockUntil` to `lockAtMostUntil(newConfig)`. Conditional on `lockedBy` matching AND `lockUntil >= now` (still valid).

**Mechanism:**
```typescript
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
```

**Returns:** `true` if the entity was updated. `false` if it doesn't exist, is owned by another instance, or has already expired.

### 4. Datastore Transaction Semantics

- **Optimistic concurrency:** Datastore transactions read entities, then commit. If any read entity was modified by a concurrent committed transaction, Datastore aborts and the client library retries the transaction body (up to a configurable limit, default 5).
- **`txn.upsert`** creates or overwrites — no conflict detection by itself. The read-before-upsert pattern within the transaction is what provides conditional semantics (concurrent modification aborts the transaction).
- **`txn.get(key)`** throws `NOT_FOUND` when the entity doesn't exist — the accessor's `safeGet` catches this and returns `undefined`.
- **`runTransaction(callback)`** is the high-level API that handles `begin`/`commit`/`rollback` and retries. `newTransaction()` is the lower-level API requiring manual lifecycle management — we use `runTransaction` for cleaner code and automatic retry.

### 5. Field Value Encoding

By default, fields are stored as ISO-8601 strings (`Utils.toIsoString`), matching the rest of TSLock and ShedLock.

If `useDate: true`, fields are stored as JS `Date` objects, which Datastore persists as datetime values. The accessor converts via `new Date(epochMillis)` and `Date.getTime()`. Both modes are supported; pick one per provider instance and do not mix — mixing corrupts the `lockUntil` comparison because `parseFieldValue` dispatches on `instanceof Date`.

### 6. Key / Kind Considerations

- The lock entity's kind is `entityName` (default `"shedlock"`).
- The entity's name identifier is the lock `name` string (not a numeric ID).
- Lock names must be valid Datastore name identifiers: UTF-8, must not start with `!`, max 1500 bytes. The user is responsible for keeping lock names sane; TSLock does not validate per-call names.
- **Namespace:** Datastore supports namespaces, configured via the `Datastore` client constructor (`new Datastore({ namespace })`). TSLock uses whatever namespace the client is configured with; no per-call namespace override.

## Error Handling

| Situation | Behavior |
|---|---|
| Insert — entity already exists | Return `false` |
| Update — entity missing | Return `false` |
| Update — entity still locked (`lockUntil > now`) | Return `false` |
| Unlock — entity missing or owned by another | No-op, return `void` |
| Extend — entity missing, owned by another, or expired | Return `false` |
| `txn.get` throws `NOT_FOUND` | `safeGet` returns `undefined` (not an error) |
| `txn.get` throws non-NOT_FOUND error | Propagate |
| Transaction retries exhausted | Propagate the final error |
| Network / auth / permission error | Propagate |

## Dependencies

- **Peer**: `@tslock/core`, `@google-cloud/datastore`
- **Dev**: `typescript`, `tsup`, `vitest`

## Exports

From `src/index.ts`:
- `createDatastoreProvider`
- `DatastoreConfiguration`, `DatastoreFieldNames` (types)
- `DatastoreStorageAccessor` (advanced use / testing)

Re-exports from `@tslock/core`: `StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `LockProvider`, `ExtensibleLockProvider`, `SimpleLock`, `LockException`.

## File Structure

```
packages/datastore/
├── src/
│   ├── index.ts                       # public exports
│   ├── datastore-configuration.ts     # DatastoreConfiguration, DatastoreFieldNames, defaults + validation
│   ├── datastore-storage-accessor.ts  # DatastoreStorageAccessor (StorageAccessor impl)
│   └── datastore-lock-provider.ts    # createDatastoreProvider factory
├── __tests__/
│   ├── datastore-storage-accessor.test.ts  # unit tests with mocked Datastore
│   ├── datastore-lock-provider.test.ts     # unit tests via StorageBasedLockProvider
│   └── integration.test.ts                 # contract tests against Datastore emulator
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Non-Goals

- No kind/index creation — Datastore creates kinds implicitly on first entity.
- No composite-index management — single-key lookups don't need indexes.
- No namespace support in v1 (uses the `Datastore` client's default namespace; user configures via the client constructor).
- No multi-kind / sharded locking.
- No TTL / garbage-collection of lock entities — Datastore has no native TTL; users are responsible for cleanup if needed.
