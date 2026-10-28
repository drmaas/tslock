# Spec: @tslock/arangodb

## Overview

The `@tslock/arangodb` package provides a DIRECT `LockProvider` implementation backed by ArangoDB. It uses the official `arangojs` driver and ArangoDB **stream transactions with an exclusive collection lock** to serialize lock acquisition. Unlike the `StorageBasedLockProvider` insert-then-update pattern, this provider wraps the read-check-write sequence in a single stream transaction so that only one transaction can access the lock collection at a time, guaranteeing at-most-one acquisition even across concurrent attempts.

Fields (`lockUntil`, `lockedAt`, `lockedBy`) are persisted as ISO-8601 strings; the document `_key` is the lock name. This matches ShedLock's `ArangoLockProvider`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/arangodb` |
| **Driver** | `arangojs` (official ArangoDB JavaScript driver) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `arangojs` (peer) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. ArangoDbLockProvider

```typescript
import type { Collection } from 'arangojs/collection';

class ArangoDbLockProvider implements ExtensibleLockProvider {
  constructor(collection: Collection<ArangoDbLockDocument>);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-configured `Collection` from the `arangojs` driver. The user is responsible for creating the `Database` / `Collection` with the correct connection URL, database name, and collection name. The collection's database is obtained via `collection.database()` and used to begin stream transactions.

### 2. createArangoDbLockProvider factory

```typescript
import type { Database } from 'arangojs';

function createArangoDbLockProvider(
  database: Database,
  options?: ArangoDbLockProviderOptions,
): ArangoDbLockProvider;
```

Convenience factory that resolves a `Collection` with the given options (collection name) and wraps it in an `ArangoDbLockProvider`. Users who want full control over the `Collection` construct `ArangoDbLockProvider` directly.

### 3. ArangoDbLockProviderOptions

```typescript
interface ArangoDbLockProviderOptions {
  collection?: string;  // default: 'shedLock'
}
```

Defaults applied by `createArangoDbLockProvider`:
- `collection`: `'shedLock'`

The user (or the factory) must ensure the collection exists before the provider is used. Stream transactions require the collection to exist at `beginTransaction` time. The factory calls `db.collection(name)` (a lightweight handle; ArangoDB creates the collection lazily on first write, but stream transactions need it pre-created — see Risks in the implementation plan).

### 4. ArangoDbLockDocument

```typescript
interface ArangoDbLockDocument {
  _key: string;        // lock name
  lockUntil: string;   // ISO-8601 — Utils.toIsoString(epochMillis)
  lockedAt: string;    // ISO-8601 — Utils.toIsoString(epochMillis)
  lockedBy: string;    // hostname (Utils.getHostname())
}
```

Stored as a regular ArangoDB document. The `_key` is the lock name and acts as the primary key (uniqueness enforced by ArangoDB). No secondary index is required — `_key` is hashed and indexed by default.

### 5. ArangoDbLock

```typescript
class ArangoDbLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `ArangoDbLockProvider.lock()` when acquisition succeeds. The caller uses the public `SimpleLock.unlock()` / `SimpleLock.extend()` methods; the `doUnlock` / `doExtend` overrides are internal.

### 6. ArangoDbAccessor (internal)

```typescript
class ArangoDbAccessor {
  constructor(collection: Collection<ArangoDbLockDocument>);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  extend(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}
```

Encapsulates the stream transaction + document operations. `ArangoDbLockProvider` delegates to this and wraps the results in `ArangoDbLock`.

## Locking Mechanism

### lock(config)

Lock acquisition is a stream transaction with an **exclusive collection lock**. The `exclusiveCollections` option ensures no other transaction (or stand-alone operation) can read or write the collection while this transaction is active, serializing concurrent lock attempts.

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();
  const collectionName = this.collection.name;
  const documentId = config.name;

  const txn = await this.collection.database().beginTransaction({
    exclusiveCollections: [collectionName],
  });

  try {
    let existing: ArangoDbLockDocument | null;
    try {
      existing = await this.collection.document(documentId);
    } catch (e) {
      if (isDocumentNotFoundError(e)) {
        existing = null;
      } else {
        await txn.abort();
        throw e;
      }
    }

    if (existing === null) {
      // First lock on this name — insert
      await this.collection.save({
        _key: documentId,
        lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
        lockedAt: Utils.toIsoString(now),
        lockedBy: hostname,
      });
      await txn.commit();
      return new ArangoDbLock(config, this);
    }

    // Document exists — check if expired
    const lockUntilMillis = Date.parse(existing.lockUntil);
    if (lockUntilMillis <= now) {
      // Lock expired — take over
      await this.collection.update(documentId, {
        lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
        lockedAt: Utils.toIsoString(now),
        lockedBy: hostname,
      });
      await txn.commit();
      return new ArangoDbLock(config, this);
    }

    // Lock still held by someone — abort
    await txn.abort();
    return undefined;
  } catch (e) {
    try { await txn.abort(); } catch { /* best-effort */ }
    throw e;
  }
}
```

Semantics:
- `beginTransaction({ exclusiveCollections: [collectionName] })` — acquires an exclusive lock on the collection. No other transaction (or stand-alone operation) can access the collection while this transaction is active. This is what makes the read-check-write sequence atomic across concurrent attempts.
- `collection.document(documentId)` — reads the existing lock document. Throws an `ArangoError` with error code `1202` (`ERROR_ARANGO_DOCUMENT_NOT_FOUND`) when the document does not exist.
- If the document does not exist → `collection.save({ _key, lockUntil, lockedAt, lockedBy })` inserts it → `commit()` → lock acquired.
- If the document exists and `lockUntil <= now` → `collection.update(documentId, { lockUntil, lockedAt, lockedBy })` overwrites the lock → `commit()` → lock acquired.
- If the document exists and `lockUntil > now` → lock is still held → `abort()` → return `undefined`.

### extend(config)

```typescript
async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();
  const documentId = config.name;

  let existing: ArangoDbLockDocument;
  try {
    existing = await this.collection.document(documentId);
  } catch (e) {
    if (isDocumentNotFoundError(e)) return undefined;
    throw e;
  }

  if (existing.lockedBy !== hostname) return undefined;
  if (Date.parse(existing.lockUntil) <= now) return undefined;

  await this.collection.update(documentId, {
    lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
  });
  return new ArangoDbLock(config, this);
}
```

- Reads the document (no transaction — extend is a single conditional update; the check-then-update is safe because only the original holder can extend, and a stale read just causes a no-op update).
- Only the original holder (`lockedBy === hostname`) can extend.
- The lock must still be valid (`lockUntil > now`).
- On success → `collection.update(documentId, { lockUntil: newLockAtMostUntil })` → new `ArangoDbLock`.
- On failure (wrong holder, expired, or missing) → `undefined`.

### unlock(config)

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  await this.collection.update(config.name, {
    lockUntil: Utils.toIsoString(unlockTime(config)),
  });
}
```

- Sets `lockUntil` to `unlockTime(config)` = `max(ClockProvider.now(), lockAtLeastUntil(config))`. This implements `lockAtLeastFor` (preserves the minimum hold time) and releases the lock when no minimum applies.
- No filter on `lockUntil` or `lockedBy`: unlock is unconditional. A no-op update (zero matched docs) is silent and benign — the `update` call on a non-existent `_key` throws `ERROR_ARANGO_DOCUMENT_NOT_FOUND`; the provider swallows it (the lock is already gone).

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  try {
    await this.collection.update(config.name, {
      lockUntil: Utils.toIsoString(unlockTime(config)),
    });
  } catch (e) {
    if (isDocumentNotFoundError(e)) return;  // benign — lock already gone
    throw e;
  }
}
```

## File Structure

```
packages/arangodb/
├── src/
│   ├── index.ts
│   ├── arangodb-lock-provider.ts          # ArangoDbLockProvider + createArangoDbLockProvider
│   ├── arangodb-lock.ts                   # ArangoDbLock extends AbstractSimpleLock
│   ├── arangodb-accessor.ts               # ArangoDbAccessor (stream transaction + document ops)
│   └── arangodb-lock-document.ts          # ArangoDbLockDocument interface
├── __tests__/
│   ├── arangodb-lock-provider.test.ts                 # unit tests (mocked Collection)
│   └── integration/
│       ├── arangodb-lock-provider.integration.test.ts # extends lockProviderIntegrationTests
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `lockUntil > now` → `txn.abort()` → return `undefined` |
| First lock on a new name | `document()` throws DocumentNotFound (`1202`) → `save()` → `commit()` → `ArangoDbLock` |
| Lock expired, second acquirer wins | `lockUntil <= now` → `update()` → `commit()` → `ArangoDbLock` |
| Concurrent lock attempts | `exclusiveCollections` serializes transactions — only one commits; others see the new/expired doc and abort |
| Connection error / network failure | Propagate the driver error (transaction aborted in `catch`) |
| `txn.commit()` fails | Propagate; transaction auto-aborts server-side |
| `txn.abort()` fails in error path | Swallowed (best-effort cleanup) |
| `extend()` on a lock held by another | `lockedBy !== hostname` → `undefined` |
| `extend()` on an expired lock | `lockUntil <= now` → `undefined` |
| `extend()` on a non-existent doc | `document()` throws DocumentNotFound → `undefined` |
| `unlock()` on a non-existent doc | `update()` throws DocumentNotFound → swallowed, no error |

## Dependencies

- **Peer**: `@tslock/core`, `arangojs` (tested against `^8.0.0`; v7 compatible where the stream-transaction API matches)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`

## Exports

From `src/index.ts`:
- `ArangoDbLockProvider`
- `createArangoDbLockProvider`
- `ArangoDbLockProviderOptions`
- `ArangoDbLockDocument`

`ArangoDbAccessor` and `ArangoDbLock` are not exported as public API.

## Non-Goals (for this package)

- No connection management: the user creates the `Database` / `Collection`. The package does not parse URLs or manage connection pools.
- No collection creation: the user pre-creates the collection (or calls `db.createCollection` in their setup). Stream transactions require the collection to exist at `beginTransaction` time.
- No index management: `_key` is the primary key and is indexed by default. No secondary index needed.
- No AQL queries: the provider uses the document API (`document`, `save`, `update`) rather than AQL.
- No multi-collection transactions: only the single lock collection is involved in each transaction.
- No graph traversal: locks are plain documents, not graph edges.
- No `waitForSync` tuning: the provider relies on the collection/database default. Users who need synchronous writes configure the collection's `waitForSync` flag themselves.
