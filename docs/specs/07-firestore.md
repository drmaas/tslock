# Spec: @tslock/firestore

## Overview

The `@tslock/firestore` package implements distributed locks backed by Google Cloud Firestore. It uses Firestore transactions (`runTransaction`) which provide optimistic concurrency control with automatic retry. The package implements `StorageAccessor` from `@tslock/core` and wraps it with `StorageBasedLockProvider`.

This is a port of ShedLock's `FirestoreLockProvider` (Java), adapted to TypeScript and the `@google-cloud/firestore` Node.js client.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/firestore` |
| **Driver** | `@google-cloud/firestore` (peer dependency) |
| **Core dependency** | `@tslock/core` (peer dependency) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS (tsup) |
| **Test strategy** | Integration tests against Firestore emulator (`@firebase/rules-unit-testing` or `gcloud emulators firestore`) |

## Public API

### 1. FirestoreConfiguration

```typescript
import type { Firestore } from '@google-cloud/firestore';

interface FirestoreConfiguration {
  /** Firestore client instance. */
  readonly firestore: Firestore;
  /** Collection name. Defaults to "shedlock". */
  readonly collectionName?: string;
  /** Field name overrides. Defaults match ShedLock. */
  readonly fieldNames?: Partial<FirestoreFieldNames>;
  /** Value written to the lockedBy field. Defaults to Utils.getHostname(). */
  readonly lockedByValue?: string;
  /** Store timestamps as Firestore Timestamp instead of ISO string. Defaults to false (ISO string). */
  readonly useTimestamps?: boolean;
}

interface FirestoreFieldNames {
  readonly lockUntil: string; // default "lockUntil"
  readonly lockedAt: string;  // default "lockedAt"
  readonly lockedBy: string;  // default "lockedBy"
}
```

The document ID is the lock `name` (no field name override — Firestore document IDs are immutable).

**Validation** (in `resolveFirestoreConfiguration`):
- `firestore` required.
- `collectionName` non-empty if provided.
- Each provided `fieldNames.*` non-empty.
- Defaults applied when omitted.

### 2. createFirestoreProvider

```typescript
function createFirestoreProvider(config: FirestoreConfiguration): StorageBasedLockProvider;
```

Constructs a `FirestoreStorageAccessor` from the resolved configuration and wraps it:
```typescript
return new StorageBasedLockProvider(new FirestoreStorageAccessor(resolved));
```

The returned provider implements `ExtensibleLockProvider` (extend is supported).

### 3. FirestoreStorageAccessor

Implements `StorageAccessor` from `@tslock/core`. Exported for advanced use and testing.

```typescript
class FirestoreStorageAccessor extends AbstractStorageAccessor {
  constructor(config: FirestoreConfiguration);

  async insertRecord(config: LockConfiguration): Promise<boolean>;
  async updateRecord(config: LockConfiguration): Promise<boolean>;
  async unlock(config: LockConfiguration): Promise<void>;
  async extend(config: LockConfiguration): Promise<boolean>;
}
```

#### Document Reference

All four operations reference the same document:
```typescript
private docRef(name: string): DocumentReference {
  return this.firestore.collection(this.collectionName).doc(name);
}
```

#### Field Value Encoding

```typescript
private toFieldValue(epochMillis: number): string | Timestamp {
  return this.useTimestamps
    ? Timestamp.fromMillis(epochMillis)
    : Utils.toIsoString(epochMillis);
}

private parseFieldValue(value: string | Timestamp): number {
  return value instanceof Timestamp ? value.toMillis() : Date.parse(value);
}
```

Default mode: ISO-8601 strings. `useTimestamps: true` mode: Firestore `Timestamp` objects. Pick one per provider instance; do not mix modes on the same collection.

#### toData (for insert / update)

```typescript
private toData(config: LockConfiguration): Record<string, string | Timestamp> {
  return {
    [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
    [this.fieldNames.lockedAt]: this.toFieldValue(ClockProvider.now()),
    [this.fieldNames.lockedBy]: this.lockedByValue,
  };
}
```

#### insertRecord

Acquire a lock by creating a document. Atomic within the transaction — `txn.create()` fails at commit if the document exists, which triggers a transaction retry; on retry `snapshot.exists` is `true` and we return `false`.

**Mechanism:**
```typescript
const ref = this.docRef(config.name);
return await this.firestore.runTransaction(async (txn) => {
  const snap = await txn.get(ref);
  if (snap.exists) return false;
  txn.create(ref, this.toData(config));
  return true;
});
```

**Returns:** `true` if the document was created. `false` if it already existed.

#### updateRecord

Acquire a lock by updating an existing, expired document. Read-then-update within the transaction; Firestore's optimistic concurrency ensures atomicity.

**Mechanism:**
```typescript
const ref = this.docRef(config.name);
return await this.firestore.runTransaction(async (txn) => {
  const snap = await txn.get(ref);
  if (!snap.exists) return false;
  const current = this.parseFieldValue(snap.get(this.fieldNames.lockUntil));
  if (current > ClockProvider.now()) return false;
  txn.update(ref, this.toData(config));
  return true;
});
```

**Returns:** `true` if the document existed and was expired. `false` otherwise.

#### unlock

Release the lock by setting `lockUntil = unlockTime(config)`. Conditional on `lockedBy` matching our identity.

**Mechanism:**
```typescript
const ref = this.docRef(config.name);
await this.firestore.runTransaction(async (txn) => {
  const snap = await txn.get(ref);
  if (!snap.exists) return;
  if (snap.get(this.fieldNames.lockedBy) !== this.lockedByValue) return;
  txn.update(ref, {
    [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)),
  });
});
```

**Returns:** `void`. Best-effort — if the document is missing or owned by another instance, no-op.

#### extend

Extend the lock's `lockUntil` to `lockAtMostUntil(newConfig)`. Conditional on `lockedBy` matching AND `lockUntil >= now` (still valid).

**Mechanism:**
```typescript
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
```

**Returns:** `true` if the document was updated. `false` if it doesn't exist, is owned by another instance, or has already expired.

### 4. Firestore Transaction Semantics

- **Optimistic concurrency:** Firestore transactions read documents, then commit. If any read document was modified by a concurrent committed transaction, Firestore retries the transaction body (up to 5 times by default).
- **`txn.create(docRef, data)`** fails at commit if the document exists — triggers a retry, on which `snapshot.exists` will be `true`.
- **`txn.update(docRef, data)`** fails at commit if the document doesn't exist — triggers a retry.
- All four operations are performed inside `runTransaction` to guarantee atomicity. The read-then-write pattern is the conditional-update primitive in Firestore; there is no single conditional write API.

### 5. Field Value Encoding

By default, fields are stored as ISO-8601 strings (`Utils.toIsoString`), matching the rest of TSLock and ShedLock. This keeps the lock documents inspectable in the Firestore console and avoids timezone ambiguity.

If `useTimestamps: true`, fields are stored as Firestore `Timestamp` objects. The accessor converts via `Timestamp.fromMillis(epochMillis)` and `Timestamp.toMillis()`. Both modes are supported; pick one per provider instance and do not mix — mixing corrupts the `lockUntil` comparison because `parseFieldValue` dispatches on `instanceof Timestamp`.

### 6. Document ID Considerations

- The lock `name` becomes the Firestore document ID.
- Document IDs must not contain `/`, must not be empty, and must be <= 1500 bytes UTF-8.
- The user is responsible for keeping lock names valid. TSLock does not validate per-call names (validation would add overhead on every lock attempt); invalid names surface as Firestore errors.

## Error Handling

| Situation | Behavior |
|---|---|
| Insert — document already exists | Return `false` (not an error) |
| Update — document missing | Return `false` |
| Update — document still locked (`lockUntil > now`) | Return `false` |
| Unlock — document missing or owned by another | No-op, return `void` |
| Extend — document missing, owned by another, or expired | Return `false` |
| Transaction retries exhausted | Propagate the final error from `runTransaction` |
| Network / auth / permission error | Propagate |
| Invalid document ID (contains `/`, empty) | Propagate Firestore error |

## Dependencies

- **Peer**: `@tslock/core`, `@google-cloud/firestore`
- **Dev**: `typescript`, `tsup`, `vitest`, `@firebase/rules-unit-testing` (for emulator-based integration tests)

## Exports

From `src/index.ts`:
- `createFirestoreProvider`
- `FirestoreConfiguration`, `FirestoreFieldNames` (types)
- `FirestoreStorageAccessor` (advanced use / testing)

Re-exports from `@tslock/core`: `StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockConfiguration`, `LockProvider`, `ExtensibleLockProvider`, `SimpleLock`, `LockException`.

## File Structure

```
packages/firestore/
├── src/
│   ├── index.ts                       # public exports
│   ├── firestore-configuration.ts      # FirestoreConfiguration, FirestoreFieldNames, defaults + validation
│   ├── firestore-storage-accessor.ts   # FirestoreStorageAccessor (StorageAccessor impl)
│   └── firestore-lock-provider.ts     # createFirestoreProvider factory
├── __tests__/
│   ├── firestore-storage-accessor.test.ts  # unit tests with mocked Firestore
│   ├── firestore-lock-provider.test.ts    # unit tests via StorageBasedLockProvider
│   └── integration.test.ts                # contract tests against Firestore emulator
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Non-Goals

- No collection creation — Firestore creates collections implicitly.
- No composite-index management — single-document reads don't need indexes.
- No multi-collection / sharded locking.
- No security-rules integration — the user is responsible for rules on the `shedlock` collection.
- No TTL / garbage-collection of lock documents — users can set a Firestore TTL policy on the `lockedAt` field if desired.
