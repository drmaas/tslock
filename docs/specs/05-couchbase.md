# Spec: @tslock/couchbase

## Overview

The `@tslock/couchbase` package provides a distributed lock provider backed by [Couchbase](https://www.couchbase.com/) Server. It uses the `StorageBasedLockProvider` pattern from `@tslock/core` with a `StorageAccessor` implementation that operates on a single Couchbase collection.

Locking is implemented via two Couchbase primitives:
- `Collection.insert()` — fails with `DocumentExistsException` if the document already exists. Used by `insertRecord` (first-time lock).
- `Collection.replace()` with CAS (Compare-And-Swap) — atomic update of an existing document, failing with `CasMismatchException` on concurrent modification. Used by `updateRecord`, `unlock`, and `extend`.

This is a direct port of ShedLock's `CouchbaseLockProvider`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/couchbase` |
| **Dependencies** | `@tslock/core` (peer), `couchbase` (peer) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. CouchbaseLockProvider

```typescript
import type { Cluster, Collection } from 'couchbase';
import { StorageBasedLockProvider, ExtensibleLockProvider } from '@tslock/core';

class CouchbaseLockProvider implements ExtensibleLockProvider {
  constructor(collection: Collection, options?: CouchbaseLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  clearCache(name: string): void;
}
```

**Constructor:**
- `collection` — a `couchbase` `Collection` instance obtained via `cluster.bucket(bucket).scope(scope).collection(collection)`. The caller is responsible for `Cluster` lifecycle.
- `options` — optional configuration (see below). Defaults applied for omitted fields.

**Behavior:** Delegates to `new StorageBasedLockProvider(new CouchbaseStorageAccessor(collection, options))`. Implements `ExtensibleLockProvider` because `extend()` is supported.

### 2. CouchbaseLockProviderOptions

```typescript
interface CouchbaseLockProviderOptions {
  readonly documentIdPrefix?: string;        // default: 'shedlock:'
  readonly columnNames?: CouchbaseColumnNames; // default: see below
  readonly lockedByValue?: string;            // default: Utils.getHostname()
}

interface CouchbaseColumnNames {
  readonly name: string;        // default: 'name'
  readonly lockUntil: string;  // default: 'lockUntil'
  readonly lockedAt: string;    // default: 'lockedAt'
  readonly lockedBy: string;    // default: 'lockedBy'
}
```

- **`documentIdPrefix`** — prefix prepended to the lock name to form the Couchbase document ID. Default `'shedlock:'` produces document IDs like `shedlock:my-task`.
- **`columnNames`** — field names within the JSON document body. Allows collision avoidance if the host schema already uses the default names.
- **`lockedByValue`** — value written to the `lockedBy` field. Defaults to the current hostname. Used by `extend()` to verify ownership.

### 3. Exported Helpers

```typescript
export function buildDocumentId(
  name: string,
  options?: { documentIdPrefix?: string },
): string;
```

Returns `prefix + name`. Useful for tests and for users who want to inspect/delete lock documents directly.

## Locking Mechanism

Each lock maps to exactly one Couchbase document. The document ID is `documentIdPrefix + config.name`. The document body is a JSON object:

```json
{
  "name": "my-task",
  "lockUntil": 1700000000000,
  "lockedAt": 1699999990000,
  "lockedBy": "host-1"
}
```

All times are epoch milliseconds (JavaScript `number`).

### insertRecord(config)

Executed when the lock name has not been seen before by the in-memory `LockRecordRegistry`. Creates a new Couchbase document; `Collection.insert()` fails atomically if the document already exists.

```typescript
const documentId = this.documentIdPrefix + config.name;
const document = {
  [this.columnNames.name]: config.name,
  [this.columnNames.lockUntil]: lockAtMostUntil(config),
  [this.columnNames.lockedAt]: ClockProvider.now(),
  [this.columnNames.lockedBy]: this.lockedByValue,
};
await collection.insert(documentId, document);
```

**Result handling:**
- Success → return `true`.
- `DocumentExistsException` → return `false` (lock already held).
- Other errors → propagate.

### updateRecord(config)

Executed when `insertRecord` failed or when the lock name is already in the registry. Reads the existing document (with its CAS), checks whether the lock has expired, and replaces the document atomically using CAS to prevent concurrent overwrites.

```typescript
const documentId = this.documentIdPrefix + config.name;
const getResult = await collection.get(documentId);
const existing = getResult.content;
if (existing[lockUntilColumn] > ClockProvider.now()) {
  return false;  // lock still held
}
const document = {
  [nameColumn]: config.name,
  [lockUntilColumn]: lockAtMostUntil(config),
  [lockedAtColumn]: ClockProvider.now(),
  [lockedByColumn]: this.lockedByValue,
};
await collection.replace(documentId, document, { cas: getResult.cas });
```

**Result handling:**
- `lockUntil > now` → return `false` (lock still held).
- `Collection.get` throws `DocumentNotFoundError` → propagate (indicates a record-registry cache miss where the record does not exist; `StorageBasedLockProvider` will clear the cache and retry on the next call).
- `Collection.replace` throws `CasMismatchException` → return `false` (someone else acquired the lock concurrently).
- `Collection.replace` success → return `true`.
- Other errors → propagate.

**Note:** A `DocumentNotFoundError` from `get` after a cache miss is not fatal — it propagates to `StorageBasedLockProvider.lock()`, which clears the registry cache so the next attempt will try `insertRecord` again.

### unlock(config)

Sets `lockUntil` to `unlockTime(config)` — the later of "now" and `lockAtLeastUntil(config)`. This implements `lockAtLeastFor`.

```typescript
const documentId = this.documentIdPrefix + config.name;
const getResult = await collection.get(documentId);
const existing = getResult.content;
const document = {
  ...existing,
  [lockUntilColumn]: unlockTime(config),
};
await collection.replace(documentId, document, { cas: getResult.cas });
```

**Result handling:**
- Success → return `void`.
- `DocumentNotFoundError` on `get` → no-op (lock document was deleted externally; acceptable — the lock would have expired via `lockAtMostFor` anyway).
- `CasMismatchException` on `replace` → swallow and log (best-effort unlock; a stuck lock expires via `lockAtMostFor`).
- Other errors → propagate.

**Design choice:** Unlike `updateRecord`, `unlock` swallows `CasMismatchException` rather than returning `false`. Unlock is best-effort: if a concurrent modification happened during the task's execution, the lock record is in an unknown state and forcing an unlock could corrupt another instance's lock. ShedLock's Java provider does the same.

### extend(config)

Extends the lock only if the current instance still owns it and the lock is still valid. Ownership is verified by comparing `lockedBy` to the current hostname.

```typescript
const documentId = this.documentIdPrefix + config.name;
const getResult = await collection.get(documentId);
const existing = getResult.content;
const now = ClockProvider.now();
if (existing[lockedByColumn] !== this.lockedByValue) return false;
if (existing[lockUntilColumn] <= now) return false;
const document = {
  ...existing,
  [lockUntilColumn]: lockAtMostUntil(config),
};
await collection.replace(documentId, document, { cas: getResult.cas });
```

**Result handling:**
- `lockedBy !== this.lockedByValue` → return `false` (not our lock).
- `lockUntil <= now` → return `false` (lock already expired).
- `Collection.replace` throws `CasMismatchException` → return `false` (someone modified concurrently).
- `Collection.replace` success → return `true`.
- `DocumentNotFoundError` on `get` → return `false` (lock document gone).
- Other errors → propagate.

## Configuration

### Default values

| Option | Default |
|---|---|
| `documentIdPrefix` | `'shedlock:'` |
| `columnNames.name` | `'name'` |
| `columnNames.lockUntil` | `'lockUntil'` |
| `columnNames.lockedAt` | `'lockedAt'` |
| `columnNames.lockedBy` | `'lockedBy'` |
| `lockedByValue` | `Utils.getHostname()` |

### Validation

- `documentIdPrefix` must be a string (empty allowed — locks would be keyed by bare name, which is valid but discouraged for key-spacing reasons).
- All column names must be non-empty strings.
- `documentIdPrefix + name` must not exceed Couchbase's 250-byte document ID limit. The accessor throws `LockException` if the computed ID exceeds this limit.

### Bucket / Scope / Collection selection

The provider takes a pre-built `Collection` instance. The user is responsible for ensuring the bucket, scope, and collection exist. For the default scope/collection, use:

```typescript
const cluster = await couchbase.connect('couchbase://localhost', { username, password });
const collection = cluster.bucket('my-bucket').defaultCollection();
const provider = new CouchbaseLockProvider(collection);
```

For a custom scope/collection (Couchbase 7+):

```typescript
const collection = cluster.bucket('my-bucket').scope('locks').collection('shedlock');
```

## Setup Requirements

Couchbase requires no schema or index for this provider — locks are stored as standalone JSON documents keyed by document ID. The atomicity guarantees come from:
- `Collection.insert()` failing on existing document (built-in).
- `Collection.replace()` CAS check (built-in).

**Required:**
- Couchbase Server 6.0+ (insert + CAS replace on collections available since 6.0).
- A bucket with sufficient quota for the (small) lock documents.
- A user with `Data Writer` + `Data Reader` privileges on the target collection.

**Optional but recommended:**
- A dedicated scope/collection for locks (Couchbase 7+) to isolate lock documents from application data.
- A TTL on the collection is **not** required — locks expire by their own `lockUntil` field, not by Couchbase's document-level TTL. Setting a collection TTL would cause premature eviction of lock documents and break locking.

## File Structure

```
packages/couchbase/
├── src/
│   ├── index.ts                       # public exports
│   ├── couchbase-lock-provider.ts      # CouchbaseLockProvider, CouchbaseLockProviderOptions
│   ├── couchbase-storage-accessor.ts   # CouchbaseStorageAccessor extends AbstractStorageAccessor
│   └── document-id.ts                  # buildDocumentId helper + length validation
├── __tests__/
│   ├── unit/
│   │   ├── couchbase-storage-accessor.test.ts  # mocked Collection
│   │   └── document-id.test.ts
│   └── integration/
│       ├── couchbase-integration.test.ts       # extends storageBasedLockProviderIntegrationTests
│       └── docker-compose.yml                  # Couchbase testcontainer config
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling

| Situation | Detection | Behavior |
|---|---|---|
| Lock held on insert (`insertRecord`) | `DocumentExistsException` | Return `false` |
| Lock held on update (`updateRecord`) — `lockUntil > now` | Content check on `get` result | Return `false` |
| Lock held on update — concurrent modification | `CasMismatchException` on `replace` | Return `false` |
| Lock document not found on `get` (`updateRecord`) | `DocumentNotFoundError` | Propagate (triggers `StorageBasedLockProvider` cache clear) |
| Lock not owned on `extend` (`lockedBy` mismatch) | Content check on `get` result | Return `false` |
| Lock expired on `extend` (`lockUntil <= now`) | Content check on `get` result | Return `false` |
| Concurrent modification on `extend` | `CasMismatchException` on `replace` | Return `false` |
| Lock document not found on `extend` (`get`) | `DocumentNotFoundError` | Return `false` |
| Unlock — document not found | `DocumentNotFoundError` on `get` | No-op (swallowed) |
| Unlock — concurrent modification | `CasMismatchException` on `replace` | Swallowed and logged (best-effort) |
| Connection / network error | Any other `CouchbaseError` subclass | Propagate |
| Auth error | `AuthenticationFailureError` | Propagate |
| Timeout error | `TimeoutError` | Propagate |
| Document ID too long | Length > 250 bytes (checked before any SDK call) | Throw `LockException` |

### Error inspection

The `couchbase` SDK throws typed errors. Import them from the package for `instanceof` checks:

```typescript
import {
  DocumentExistsException,
  CasMismatchException,
  DocumentNotFoundError,
  CouchbaseError,
} from 'couchbase';

function isDocumentExists(error: unknown): boolean {
  return error instanceof DocumentExistsException;
}
function isCasMismatch(error: unknown): boolean {
  return error instanceof CasMismatchException;
}
function isDocumentNotFound(error: unknown): boolean {
  return error instanceof DocumentNotFoundError;
}
```

Using `instanceof` is preferred over error-code string matching — the SDK exposes stable class hierarchies for these cases.

## Dependencies

- **Peer**: `@tslock/core` `^1.0.0`, `couchbase` `^4.0.0` (SDK 3.x for Node.js is published as `couchbase@4.x`; the SDK is referred to as "Couchbase SDK 3.x" in Couchbase documentation despite the npm version being 4.x).
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers` (for integration tests).

### Why peer dependencies

- `couchbase` is the canonical SDK. Users pin the version; TSLock does not bundle a specific version.
- `@tslock/core` is peer so the user has a single copy across providers.

## Exports

From `src/index.ts`:
- `CouchbaseLockProvider`
- `CouchbaseLockProviderOptions`
- `CouchbaseColumnNames`
- `buildDocumentId`

## Integration Tests

Integration tests use `testcontainers` to spin up a Couchbase container. The test suite extends `storageBasedLockProviderIntegrationTests` from `@tslock/test-support`.

### Container

- Image: `couchbase/server:7.6` (latest 7.x — supports scopes/collections).
- Ports: 8091 (Admin UI), 11210 (data), 11207 (SSL data).
- Setup: requires initial cluster provisioning via the Couchbase REST API (set up services, create bucket, optionally create scope/collection). The `testcontainers` `CouchbaseContainer` class (or a custom `GenericContainer` + REST setup) handles this.
- Startup wait: container ready when the bucket is queryable (typically 20-40s).

### Setup

```typescript
beforeAll(async () => {
  container = await new CouchbaseContainer('couchbase/server:7.6')
    .withBucketName('shedlock-test')
    .withCredentials('Administrator', 'password')
    .start();
  const cluster = await couchbase.connect(container.getConnectionString(), {
    username: 'Administrator',
    password: 'password',
  });
  const collection = cluster.bucket('shedlock-test').defaultCollection();
  provider = new CouchbaseLockProvider(collection);
});

afterAll(async () => {
  if (cluster) await cluster.close();
  if (container) await container.stop();
});
```

### Test cases

In addition to the shared `storageBasedLockProviderIntegrationTests`, the integration test verifies:
- A second `collection.insert()` with the same document ID throws `DocumentExistsException` (the atomicity guarantee).
- `extend()` from a provider constructed with a different `lockedByValue` returns `false`.
- The lock document can be read directly from the collection after `insertRecord` (sanity check on the document body).

## Non-Goals (for this package)

- No N1QL query support — all operations use key-value APIs (`insert`, `get`, `replace`), which are faster and do not require indexes.
- No bucket/scope/collection auto-creation. The user is responsible for provisioning.
- No automatic document TTL — locks expire via `lockUntil`; adding a Couchbase TTL would cause premature eviction.
- No multi-collection locking. The provider is bound to a single collection.
- No support for Couchbase SDK 2.x (lacks the modern collection API).
