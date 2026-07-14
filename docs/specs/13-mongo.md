# Spec: @tslock/mongo

## Overview

The `@tslock/mongo` package provides a DIRECT `LockProvider` implementation backed by MongoDB. It uses the official `mongodb` Node.js driver and the `findOneAndUpdate` atomic operation (single round-trip) rather than the `StorageBasedLockProvider` insert-then-update pattern. Dates are persisted as BSON `Date` type via `new Date(epochMillis)`; `_id` is the lock name (string), `lockedBy` is the hostname (string). Locks use `WriteConcern.MAJORITY` and `ReadConcern.MAJORITY` so that writes are replicated to a majority before acknowledgement, matching ShedLock's `MongoLockProvider`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/mongo` |
| **Driver** | `mongodb` (official Node.js MongoDB driver) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `mongodb` (peer) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. MongoLockProvider

```typescript
import type { Collection, Db } from 'mongodb';

class MongoLockProvider implements ExtensibleLockProvider {
  constructor(collection: Collection<MongoLockDocument>);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-configured `Collection` from the `mongodb` driver. The user is responsible for creating the `Db` / `Collection` with the correct connection string, write/read concern, and database/collection names. This keeps the package free of connection-management concerns.

### 2. createMongoLockProvider factory

```typescript
function createMongoLockProvider(
  db: Db,
  options?: MongoLockProviderOptions,
): MongoLockProvider;
```

Convenience factory that builds a `Collection` with the given options (collection name, write/read concern) and wraps it in a `MongoLockProvider`. Users who want full control over the `Collection` construct `MongoLockProvider` directly.

### 3. MongoLockProviderOptions

```typescript
interface MongoLockProviderOptions {
  collection?: string;             // default: 'shedLock'
  collectionOptions?: {
    writeConcern?: { w: 'majority' | number; j?: boolean; wtimeoutMS?: number };
    readConcern?: { level: 'local' | 'majority' | 'linearizable' | 'available' | 'snapshot' };
  };
}
```

Defaults applied by `createMongoLockProvider`:
- `collection`: `'shedLock'`
- `collectionOptions.writeConcern`: `{ w: 'majority' }`
- `collectionOptions.readConcern`: `{ level: 'majority' }`

### 4. MongoLockDocument

```typescript
interface MongoLockDocument {
  _id: string;          // lock name
  lockUntil: Date;      // BSON Date — `new Date(epochMillis)`
  lockedAt: Date;       // BSON Date — `new Date(epochMillis)`
  lockedBy: string;     // hostname (Utils.getHostname())
}
```

Stored as a regular MongoDB document. No special index is required because `_id` is the lock name and acts as the primary key (uniqueness enforced by the default `_id` index). The first `findOneAndUpdate` with `upsert: true` lazily creates the collection if it does not exist.

### 5. MongoLock

```typescript
class MongoLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `MongoLockProvider.lock()` when acquisition succeeds. The caller uses the public `SimpleLock.unlock()` / `SimpleLock.extend()` methods; the `doUnlock` / `doExtend` overrides are internal.

### 6. MongoAccessor (internal)

```typescript
class MongoAccessor {
  constructor(collection: Collection<MongoLockDocument>);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  extend(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}
```

Encapsulates the `findOneAndUpdate` calls. `MongoLockProvider` delegates to this and wraps the results in `MongoLock`.

## Locking Mechanism

### lock(config)

Single atomic operation: `findOneAndUpdate` with `upsert: true`. The filter matches a document whose `lockUntil` has expired; with `upsert: true`, when no doc matches, MongoDB attempts an insert with the `_id` and the `$set` values. On a duplicate-key error (concurrent upsert of the same `_id`), the lock is not acquired.

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();

  try {
    const result = await this.collection.findOneAndUpdate(
      { _id: config.name, lockUntil: { $lte: new Date(now) } },
      {
        $set: {
          lockUntil: new Date(lockAtMostUntil(config)),
          lockedAt: new Date(now),
          lockedBy: hostname,
        },
      },
      { upsert: true, returnDocument: 'after' },
    );

    if (!result) return undefined;
    return new MongoLock(config, this);
  } catch (e) {
    if (e instanceof MongoServerError && e.code === 11000) {
      return undefined; // duplicate key — concurrent upsert, lock not acquired
    }
    throw e;
  }
}
```

Field semantics:
- `{ lockUntil: { $lte: new Date(now) } }` — matches docs whose lock has expired. With `upsert: true`, when no doc matches, MongoDB attempts an insert with the filter's `_id` plus the `$set` fields.
- Two concurrent attempts on a non-existent `_id`: the first wins; the second sees a duplicate-key error (code `11000`) from the unique `_id` index and returns `undefined`.
- `returnDocument: 'after'` is set for symmetry; the returned document is not inspected (success is implied by the absence of a duplicate-key error).

### extend(config)

```typescript
async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();

  const result = await this.collection.findOneAndUpdate(
    {
      _id: config.name,
      lockUntil: { $gt: new Date(now) },
      lockedBy: hostname,
    },
    { $set: { lockUntil: new Date(lockAtMostUntil(config)) } },
    { returnDocument: 'after' },
  );

  if (!result) return undefined;
  return new MongoLock(config, this);
}
```

- Filters by `lockedBy = hostname` (only the original holder can extend) AND `lockUntil > now` (lock must still be valid).
- No `upsert`: if the doc does not match, returns `undefined` (lock lost or held by another instance).
- No duplicate-key path: extend never inserts, so code `11000` is impossible.

### unlock(config)

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  await this.collection.findOneAndUpdate(
    { _id: config.name },
    { $set: { lockUntil: new Date(unlockTime(config)) } },
  );
}
```

- Sets `lockUntil` to `unlockTime(config)` = `max(ClockProvider.now(), lockAtLeastUntil(config))`. This implements `lockAtLeastFor` (preserves the minimum hold time) and releases the lock when no minimum applies.
- No filter on `lockUntil` or `lockedBy`: unlock is unconditional. A no-op update (zero matched docs) is silent and benign.

## File Structure

```
packages/mongo/
├── src/
│   ├── index.ts
│   ├── mongo-lock-provider.ts          # MongoLockProvider + createMongoLockProvider
│   ├── mongo-lock.ts                   # MongoLock extends AbstractSimpleLock
│   ├── mongo-accessor.ts               # MongoAccessor (findOneAndUpdate calls)
│   └── mongo-lock-document.ts          # MongoLockDocument interface
├── __tests__/
│   ├── mongo-lock-provider.test.ts                 # unit tests (mocked Collection)
│   └── integration/
│       ├── mongo-lock-provider.integration.test.ts # extends lockProviderIntegrationTests
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `findOneAndUpdate` matches zero docs (lockUntil > now) and upsert is pre-empted → `null` result or duplicate-key → `undefined` |
| Concurrent upsert of same `_id` | `MongoServerError` with `code === 11000` → caught → return `undefined` |
| First lock on a new `_id` | upsert insert succeeds → doc returned → `MongoLock` |
| Lock expired, second acquirer wins | filter matches (lockUntil <= now) → doc updated → `MongoLock` |
| Connection error / network failure | Propagate the driver error to the caller |
| `extend()` on a lock held by another | filter matches zero docs → `null` result → `undefined` |
| `extend()` on an expired lock | filter matches zero docs (`lockUntil > now` fails) → `undefined` |
| `unlock()` on a non-existent doc | No-op (update matches zero docs, no error) |
| Invalid `Collection` (wrong db/collection name) | Propagate driver error on first operation |

## Dependencies

- **Peer**: `@tslock/core`, `mongodb` (tested against `^6.0.0`; v5 compatible)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`

## Exports

From `src/index.ts`:
- `MongoLockProvider`
- `MongoLockProviderOptions`
- `MongoLockDocument`
- `createMongoLockProvider`

`MongoAccessor` and `MongoLock` are not exported as public API.

## Non-Goals (for this package)

- No connection management: the user creates the `Db` / `Collection`. The package does not parse connection strings or manage connection pools.
- No schema migration: the `shedLock` collection is created lazily on the first `findOneAndUpdate`. No index beyond `_id` is required.
- No TTL collection support (locks are released via `unlock` / `lockUntil` overwrite, not via MongoDB TTL indexes). The `lockUntil` field is used for comparison only, not for TTL expiry.
- No multi-document transactions: the provider uses single-document atomic operations. `WriteConcern.MAJORITY` + `ReadConcern.MAJORITY` is sufficient for correctness.
- No sharding-aware logic: the user shards the collection if they want; the `_id`-based access pattern is shard-friendly.
