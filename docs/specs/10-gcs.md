# Spec: @tslock/gcs

## Overview

The `@tslock/gcs` package provides a distributed lock provider backed by Google Cloud Storage (and GCS-compatible object stores). It implements the `StorageAccessor` interface and wraps it with the shared `StorageBasedLockProvider` from `@tslock/core`.

Each lock is a single GCS object whose **custom metadata** carries the lock fields (`lockUntil`, `lockedAt`, `lockedBy`, `lockName`). Mutual exclusion is achieved through GCS **preconditions**: `save({ precondition: { doesNotExist: true } })` for inserts (create-if-not-exists) and `save({ precondition: { generationMatch } })` / `setMetadata(..., { precondition: { generationMatch } })` for updates and unlocks. A `file.get()` precedes each conditional write to fetch the current generation number and metadata.

This is a direct port of ShedLock's `GcsStorageAccessor` / `GcsLockProvider` to TypeScript using `@google-cloud/storage`.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/gcs` |
| **Dependencies** | `@tslock/core` (peer), `@google-cloud/storage` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. GcsLockProvider

```typescript
class GcsLockProvider implements ExtensibleLockProvider {
  constructor(storage: Storage, config: GcsProviderConfig);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  clearCache(name: string): void;
}
```

Constructs a `GcsStorageAccessor` with the given `Storage` client and config, then wraps it in a `StorageBasedLockProvider`. All insert-then-update / `LockRecordRegistry` / `StorageLock` behavior comes from `StorageBasedLockProvider` (see `@tslock/core` spec §13). The GCS provider supplies only the four `StorageAccessor` operations.

### 2. GcsProviderConfig

```typescript
interface GcsProviderConfig {
  /** GCS bucket name. Required. */
  bucket: string;
  /** Object name prefix applied to every lock object. Default: "shedlock/". */
  objectPrefix?: string;
}
```

**Defaults & validation:**
- `objectPrefix` defaults to `"shedlock/"`.
- `bucket` must be a non-empty string. Throws `LockException` if missing.

The `Storage` client is constructed by the user (so they control `projectId`, `keyFilename`, `apiEndpoint`, emulator endpoint, etc.). The provider reads only `bucket` and `objectPrefix` from `GcsProviderConfig`.

**Object name layout:**

```
<objectPrefix><lockName>
e.g. "shedlock/my-task-name"
```

### 3. createGcsProviderConfig (factory helper)

```typescript
function createGcsProviderConfig(input: {
  bucket: string;
  objectPrefix?: string;
}): GcsProviderConfig;
```

Validates and applies defaults.

## Locking Mechanism

The lock record for a given `name` is a single GCS object. GCS assigns each object version a monotonically increasing integer **generation** number. Conditional writes use this generation as the optimistic-concurrency token: a `save({ precondition: { generationMatch: g } })` only succeeds when the object's current generation equals `g`.

| Field | GCS custom metadata key | Value |
|---|---|---|
| `lockUntil` | `lockUntil` | ISO-8601 instant string (3-digit millis), e.g. `2018-12-07T12:30:37.810Z` |
| `lockedAt` | `lockedAt` | ISO-8601 instant string |
| `lockedBy` | `lockedBy` | Hostname string (`Utils.getHostname()`) |
| `lockName` | `lockName` | The lock name (useful for debugging when objects are inspected out-of-band) |

The object body is empty. All state lives in custom metadata. The GCS **generation** serves the same role as S3's ETag — it changes on every write, enabling compare-and-swap.

### insertRecord(config)

Invoked by `StorageBasedLockProvider.lock()` when the `LockRecordRegistry` has no record for `name`.

1. `const file = storage.bucket(bucket).file(objectName);`
2. `const [exists] = await file.exists()` (or `file.get({ generation: 0 })` and catch the not-found branch).
   - **Implementation choice:** use `file.exists()` — it's the canonical GCS existence check and avoids throwing on 404. (Some ShedLock ports use `get({ generation: 0 })` + try/catch — both are valid; `exists()` is cleaner.)
3. If `exists === true` → return `false`. Record already present; `lock()` falls through to `updateRecord`.
4. If `exists === false`:
   ```typescript
   await file.save('', {
     metadata: {
       lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
       lockedAt:  Utils.toIsoString(config.createdAt),
       lockedBy:  this.getHostname(),
       lockName:  config.name,
     },
     gzip: false,
     precondition: { doesNotExist: true },
   });
   ```
5. If `save` succeeds → return `true`.
6. If `save` throws with code `412` (Precondition Failed) → return `false` (someone created it concurrently).
   - (Any other error propagates.)

**`precondition: { doesNotExist: true }`** is GCS's create-if-not-exists. The GCS API rejects the write if the object already exists at any generation.

### updateRecord(config)

Invoked when the `LockRecordRegistry` knows a record exists for `name`.

1. `const [metadata] = await file.get();` → fetches the current `generation` and `metadata`.
   - `file.get()` returns `[File, Metadata]`. The `Metadata` object has `metadata` (custom metadata map), `generation` (string or number).
2. If `file.get()` throws with code `404` → return `false` (object was deleted externally; the registry is stale).
3. Parse `lockUntil` from `metadata.metadata.lockUntil`.
   - If missing or unparseable → propagate `LockException('Corrupted lock record: ...')`.
4. If `lockUntil > ClockProvider.now()` → return `false` (still locked).
5. ```typescript
   await file.save('', {
     metadata: {
       lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
       lockedAt:  Utils.toIsoString(config.createdAt),
       lockedBy:  this.getHostname(),
       lockName:  config.name,
     },
     gzip: false,
     precondition: { generationMatch: Number(metadata.generation) },
   });
   ```
6. If `save` succeeds → return `true`.
7. If `save` throws with code `412` → return `false` (generation mismatch — concurrent modification).

**Note on `generation` type:** The GCS API returns `generation` as a string in some SDK versions and a number in others. Coerce via `Number(...)` before passing to `generationMatch`. Generation numbers fit comfortably within `Number.MAX_SAFE_INTEGER`.

### unlock(config)

Invoked by `StorageLock.doUnlock()`. Sets `lockUntil` to `unlockTime(config)` so a subsequent `updateRecord` succeeds.

1. `const [file, metadata] = await file.get();` → fetch `generation` and current custom metadata.
2. If `file.get()` throws with code `404` → no-op return (log warning, do not throw).
3. ```typescript
   await file.setMetadata(
     {
       lockUntil: Utils.toIsoString(unlockTime(config)),
       lockedAt:  metadata.metadata.lockedAt ?? Utils.toIsoString(config.createdAt),
       lockedBy:  metadata.metadata.lockedBy ?? this.getHostname(),
       lockName:  metadata.metadata.lockName ?? config.name,
     },
     { precondition: { generationMatch: Number(metadata.generation) } },
   );
   ```
4. If `setMetadata` throws with code `412` → log warning, do not throw (concurrent modification — original `lockAtMostFor` will still expire the lock).

**`unlockTime(config)`** is `Math.max(ClockProvider.now(), lockAtLeastUntil(config))` — honors `lockAtLeastFor`.

**`setMetadata` vs `save`:** `setMetadata` issues a PATCH on the object's metadata without rewriting the object body. It still increments the generation and respects `precondition`. This is preferable to `save` for unlock/extend because it's a smaller operation (no body upload).

### extend(config)

Invoked by `StorageLock.doExtend()`. Re-extends `lockUntil` to `lockAtMostUntil(config)` only if the caller is still the current holder.

1. `const [file, metadata] = await file.get();` → fetch `generation` and custom metadata.
2. If `file.get()` throws with code `404` → return `false` (record gone).
3. Parse `lockUntil`, `lockedBy` from `metadata.metadata`.
4. If `lockedBy !== this.getHostname()` → return `false` (lock held by someone else).
5. If `lockUntil <= ClockProvider.now()` → return `false` (lock expired).
6. ```typescript
   await file.setMetadata(
     {
       lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
       lockedAt:  metadata.metadata.lockedAt,   // preserve original
       lockedBy:  metadata.metadata.lockedBy,   // preserve original
       lockName:  metadata.metadata.lockName,
     },
     { precondition: { generationMatch: Number(metadata.generation) } },
   );
   ```
7. If `setMetadata` succeeds → return `true`.
8. If `setMetadata` throws with code `412` → return `false` (concurrent modification).

`lockedAt` and `lockedBy` are preserved from the existing record (extension does not change who holds the lock or when it was originally acquired).

## Error Handling

| Situation | Behavior |
|---|---|
| `file.exists()` returns `true` in `insertRecord` | Return `false` (record exists — fall through to update) |
| `file.exists()` returns `false` in `insertRecord` | Proceed to `file.save` with `doesNotExist` precondition |
| `file.save` throws `412` in `insertRecord` | Return `false` (concurrent create) |
| `file.get()` throws `404` in `updateRecord` | Return `false` |
| `file.get()` throws `404` in `unlock` | Log warning, no-op return |
| `file.get()` throws `404` in `extend` | Return `false` |
| `file.save` / `file.setMetadata` throws `412` | Return `false` (generation mismatch) |
| `file.save` / `file.setMetadata` throws any other `ApiError` | Propagate as storage error |
| Corrupt metadata (`lockUntil` unparseable) | Propagate `LockException('Corrupted lock record: ...')` |
| Missing `bucket` in config | Throw `LockException` at provider construction |
| Auth error (`600`, `403`) | Propagate |

**Error detection strategy:** `@google-cloud/storage` throws `ApiError` objects with a `code` field (HTTP status as number). The accessor maps:
- `code === 404` → not-found branch.
- `code === 412` → precondition-failed branch.
- All others propagate.

The `@google-cloud/storage` SDK does not always set `.code` reliably across all code paths; some errors come through as `StorageError` or wrapped `GaxiosError`. The error helper accepts any object with a numeric `code` or `status` field and treats them equivalently. If neither field yields a number, propagate (do not treat as not-found / precondition-failed).

## File Structure

```
packages/gcs/
├── src/
│   ├── index.ts                    # public exports
│   ├── gcs-lock-provider.ts        # GcsLockProvider (wraps StorageBasedLockProvider)
│   ├── gcs-storage-accessor.ts     # GcsStorageAccessor implements StorageAccessor
│   ├── gcs-provider-config.ts      # GcsProviderConfig, createGcsProviderConfig
│   └── gcs-errors.ts                # isNotFound, isPreconditionFailed helpers
├── __tests__/
│   └── unit/
│       ├── gcs-storage-accessor.test.ts   # mocked @google-cloud/storage
│       └── gcs-lock-provider.test.ts      # mocked accessor via StorageBasedLockProvider
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

No `__tests__/integration/` directory — there is no first-class GCS emulator. The fake-gcs-server project can be used for local development but its precondition semantics differ enough from real GCS that we do not run the canonical integration suite against it. See Implementation Plan for the manual verification procedure.

## Dependencies

- **Peer**: `@tslock/core` (`workspace:*`), `@google-cloud/storage` (`^7.x`)
- **Dev**: `vitest`, `typescript`, `tsup`, `@types/node`

## Exports

From `src/index.ts`:

- `GcsLockProvider`
- `GcsProviderConfig` (interface)
- `createGcsProviderConfig`

The `Storage` client from `@google-cloud/storage` is **not** re-exported — users construct it themselves so they control `projectId`, `keyFilename`, `apiEndpoint` (emulator), etc. The `@google-cloud/storage` peer dep is required.

## Test Approach

There is **no first-class GCS emulator** maintained by Google. Options considered:

| Option | Verdict |
|---|---|
| `fsouza/fake-gcs-server` (Docker) | Precondition semantics differ subtly from real GCS (esp. around `generationMatch` after metadata-only PATCH). Acceptable for smoke testing, but **not** trusted for the canonical integration contract. |
| GCP project with a dedicated test bucket | Real semantics, but cannot run in CI without credentials + billing. Used for manual pre-release verification only. |
| `vi.mock('@google-cloud/storage')` | Unit-test only — verifies accessor logic against mocked `File` / `Bucket` objects. Fast, runs in CI. |

**Decision:** ship unit tests only (`__tests__/unit/`). The unit tests mock `@google-cloud/storage` at the `Bucket`/`File` level and assert the accessor issues the correct calls with the correct preconditions. Manual verification against a real GCS bucket is documented as a pre-release checklist item.

This mirrors the vision document's stated position: "Skip Spanner/GCS (no emulator) — unit tests only" (`docs/00-vision.md` §6 and §8, `docs/01-architecture.md` §7.4).

## Non-Goals (for this package)

- No bucket creation / lifecycle / retention configuration — the bucket must pre-exist.
- No Object Versioning dependency. The provider works on buckets with or without versioning enabled — `generationMatch` operates on the live object's current generation regardless.
- No CMEK / CSEK encryption configuration — the user's `Storage` client config governs encryption.
- No multi-region / dual-region bucket handling.
- No automatic cleanup of stale lock objects. As with S3, lock objects persist indefinitely; expired records are simply re-writable. Users wanting cleanup should configure a bucket Lifecycle rule to delete objects under `objectPrefix` after N days.
- No integration test against a real GCS bucket in CI. Manual verification only.
