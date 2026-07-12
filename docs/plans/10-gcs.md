# Implementation Plan: @tslock/gcs

## Overview

Build the `@tslock/gcs` package — a distributed lock provider backed by Google Cloud Storage. It implements `StorageAccessor` over `@google-cloud/storage` and wraps it with `StorageBasedLockProvider` from `@tslock/core`. The locking primitive is GCS preconditions: `precondition: { doesNotExist: true }` for create-if-not-exists and `precondition: { generationMatch: <generation> }` for compare-and-swap, both preceded by `file.get()` to fetch the current generation and metadata.

This is a greenfield implementation. No code exists yet.

**Important:** Unlike S3, there is no first-class GCS emulator. This package ships **unit tests only** (mocked `@google-cloud/storage`). Real-bucket verification is a manual pre-release checklist item.

## Prerequisites

- `@tslock/core` built and available in the pnpm workspace (provides `StorageBasedLockProvider`, `StorageAccessor`, `AbstractStorageAccessor`, `LockException`, `Utils`, `ClockProvider`, `LockConfiguration`, `lockAtMostUntil`, `unlockTime`).
- `@tslock/test-support` built and available (provides `config`, `sleep`).
- `pnpm-workspace.yaml` includes `packages/*`.

## Steps

### Step 1: Initialize package

```
packages/gcs/
├── package.json
├── tsconfig.json
├── tsup.config.ts
└── src/
    └── index.ts  (empty placeholder)
```

**`package.json`:**
```json
{
  "name": "@tslock/gcs",
  "version": "1.0.0",
  "description": "Google Cloud Storage-backed distributed lock provider for TSLock",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "test:watch": "vitest",
    "typecheck": "tsc --noEmit"
  },
  "engines": { "node": ">=20" },
  "peerDependencies": {
    "@tslock/core": "workspace:*",
    "@google-cloud/storage": "^7.7.0"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false },
    "@google-cloud/storage": { "optional": false }
  },
  "devDependencies": {
    "@tslock/core": "workspace:*",
    "@tslock/test-support": "workspace:*",
    "@google-cloud/storage": "^7.7.0",
    "vitest": "^2.0.0",
    "typescript": "^5.5.0",
    "tsup": "^8.0.0",
    "@types/node": "^20.0.0"
  }
}
```

**`tsup.config.ts`:**
```typescript
import { defineConfig } from 'tsup';
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  external: ['@google-cloud/storage', '@tslock/core'],
});
```

### Step 2: Implement GcsProviderConfig

**File:** `src/gcs-provider-config.ts`

```typescript
interface GcsProviderConfig {
  bucket: string;
  objectPrefix: string;
}

function createGcsProviderConfig(input: {
  bucket: string;
  objectPrefix?: string;
}): GcsProviderConfig {
  // validate bucket non-empty → LockException
  // default objectPrefix to 'shedlock/'
}
```

- Validate `input.bucket` is a non-empty string → `LockException` otherwise.
- Default `objectPrefix` to `'shedlock/'`.

### Step 3: Implement GCS error helpers

**File:** `src/gcs-errors.ts`

```typescript
import { ApiError } from '@google-cloud/storage'; // or duck-typed

function isNotFound(e: unknown): boolean;
function isPreconditionFailed(e: unknown): boolean;
```

- `@google-cloud/storage` throws `ApiError` instances with a `code` (HTTP status as number) field. Also some paths throw `StorageError` or wrap `GaxiosError`.
- `isNotFound`: duck-typed — `(e as any)?.code === 404` (also accept `status === 404`).
- `isPreconditionFailed`: `(e as any)?.code === 412` (also accept `status === 412`).
- **Do not** `instanceof ApiError` — across SDK versions the error class identity can shift. Duck-typing on `code` / `status` is more robust.

### Step 4: Implement GcsStorageAccessor

**File:** `src/gcs-storage-accessor.ts`

```typescript
class GcsStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly storage: Storage,
    private readonly config: GcsProviderConfig,
  ) {}

  private file(name: string): File {
    return this.storage.bucket(this.config.bucket).file(this.objectKey(name));
  }

  private objectKey(name: string): string {
    return this.config.objectPrefix + name;
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> { /* ... */ }
  async updateRecord(config: LockConfiguration): Promise<boolean> { /* ... */ }
  async unlock(config: LockConfiguration): Promise<void> { /* ... */ }
  async extend(config: LockConfiguration): Promise<boolean> { /* ... */ }
}
```

Implement each method per spec §Locking Mechanism.

#### Helper: getWithMetadata

```typescript
private async getWithMetadata(name: string): Promise<{ generation: number; metadata: Record<string,string> } | null> {
  try {
    const file = this.file(name);
    const [fileObj, response] = await file.get();
    const generation = Number(response.generation ?? fileObj.generation ?? 0);
    const metadata = (response.metadata ?? {}) as Record<string,string>;
    return { generation, metadata };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}
```

- Returns `null` when the object does not exist.
- `response.generation` is sometimes a string, sometimes a number — coerce to `Number`.
- `response.metadata` is the custom-metadata map (a `Record<string,string>`).

#### Helper: buildMetadata

```typescript
private buildMetadata(config: LockConfiguration): Record<string, string> {
  return {
    lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
    lockedAt:  Utils.toIsoString(config.createdAt),
    lockedBy:  this.getHostname(),
    lockName:  config.name,
  };
}
```

#### Helper: parseLockUntil

```typescript
private parseLockUntil(metadata: Record<string,string> | undefined): number {
  const raw = metadata?.lockUntil;
  if (!raw) throw new LockException('Corrupted lock record: missing lockUntil');
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) throw new LockException(`Corrupted lock record: unparseable lockUntil '${raw}'`);
  return ms;
}
```

#### insertRecord

```typescript
async insertRecord(config: LockConfiguration): Promise<boolean> {
  const file = this.file(config.name);
  const [exists] = await file.exists();
  if (exists) return false;
  try {
    await file.save('', {
      metadata: this.buildMetadata(config),
      gzip: false,
      precondition: { doesNotExist: true },
    });
    return true;
  } catch (e) {
    if (isPreconditionFailed(e)) return false;
    throw e;
  }
}
```

#### updateRecord

```typescript
async updateRecord(config: LockConfiguration): Promise<boolean> {
  const current = await this.getWithMetadata(config.name);
  if (current === null) return false;
  const lockUntil = this.parseLockUntil(current.metadata);
  if (lockUntil > ClockProvider.now()) return false;
  const file = this.file(config.name);
  try {
    await file.save('', {
      metadata: this.buildMetadata(config),
      gzip: false,
      precondition: { generationMatch: current.generation },
    });
    return true;
  } catch (e) {
    if (isPreconditionFailed(e)) return false;
    throw e;
  }
}
```

#### unlock

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const current = await this.getWithMetadata(config.name);
  if (current === null) return; // best-effort no-op
  const file = this.file(config.name);
  try {
    await file.setMetadata(
      {
        lockUntil: Utils.toIsoString(unlockTime(config)),
        lockedAt:  current.metadata.lockedAt ?? Utils.toIsoString(config.createdAt),
        lockedBy:  current.metadata.lockedBy ?? this.getHostname(),
        lockName:  current.metadata.lockName ?? config.name,
      },
      { precondition: { generationMatch: current.generation } },
    );
  } catch (e) {
    if (isPreconditionFailed(e)) return; // best-effort no-op, log warning
    throw e;
  }
}
```

#### extend

```typescript
async extend(config: LockConfiguration): Promise<boolean> {
  const current = await this.getWithMetadata(config.name);
  if (current === null) return false;
  const lockUntil = this.parseLockUntil(current.metadata);
  const lockedBy = current.metadata.lockedBy;
  if (lockedBy !== this.getHostname()) return false;
  if (lockUntil <= ClockProvider.now()) return false;
  const file = this.file(config.name);
  try {
    await file.setMetadata(
      {
        lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
        lockedAt:  current.metadata.lockedAt,
        lockedBy:  current.metadata.lockedBy,
        lockName:  current.metadata.lockName,
      },
      { precondition: { generationMatch: current.generation } },
    );
    return true;
  } catch (e) {
    if (isPreconditionFailed(e)) return false;
    throw e;
  }
}
```

### Step 5: Implement GcsLockProvider

**File:** `src/gcs-lock-provider.ts`

```typescript
class GcsLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(storage: Storage, config: GcsProviderConfig) {
    const accessor = new GcsStorageAccessor(storage, config);
    this.delegate = new StorageBasedLockProvider(accessor);
  }

  lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.delegate.lock(config);
  }

  clearCache(name: string): void {
    this.delegate.clearCache(name);
  }
}
```

### Step 6: Wire up index.ts

**File:** `src/index.ts`

Export:
- `GcsLockProvider`
- `GcsProviderConfig` (interface)
- `createGcsProviderConfig`

Do not re-export `Storage` from `@google-cloud/storage` — the user imports it directly.

### Step 7: Unit tests (mocked `@google-cloud/storage`)

**File:** `__tests__/unit/gcs-storage-accessor.test.ts`

Construct mock `Bucket` / `File` objects that implement the subset of the GCS surface the accessor uses:
- `storage.bucket(name)` → returns mock `Bucket`.
- `bucket.file(name)` → returns mock `File`.
- `file.exists()` → returns `[boolean]`.
- `file.get()` → returns `[File, Metadata]` or throws.
- `file.save(content, options)` → resolves or throws `{ code: 412 }` / `{ code: 404 }`.
- `file.setMetadata(metadata, options)` → resolves or throws.

Use a small hand-rolled mock builder rather than `vi.mock('@google-cloud/storage')` — the SDK's internal coupling makes full module mocking brittle. A builder returning plain objects with the right method signatures is more stable.

Tests:

- `insertRecord`:
  - Happy path: `exists()` → `[false]`, `save()` resolves → returns `true`.
  - Object exists: `exists()` → `[true]` → returns `false` (no `save`).
  - Concurrent create: `save()` throws `{ code: 412 }` → returns `false`.
  - `save()` throws `{ code: 500 }` → propagates.
  - Verify `save` called with `precondition: { doesNotExist: true }` and metadata has `lockUntil`, `lockedAt`, `lockedBy`, `lockName`.
- `updateRecord`:
  - Happy path: `get()` returns generation + expired lockUntil → `save()` with `generationMatch` resolves → `true`.
  - Still locked: lockUntil in future → returns `false` (no `save`).
  - Missing record: `get()` throws `{ code: 404 }` → returns `false`.
  - Concurrent modify: `save()` throws 412 → returns `false`.
  - Corrupt metadata: `lockUntil` missing → throws `LockException`.
- `unlock`:
  - Happy path: `get()` → `setMetadata()` resolves.
  - Missing record: `get()` 404 → no-op resolves.
  - Concurrent modify: `setMetadata()` 412 → no-op resolves.
  - Verify `setMetadata` called with `precondition: { generationMatch }` and `lockUntil` set to `unlockTime`.
- `extend`:
  - Happy path: matching `lockedBy`, future `lockUntil` → `setMetadata()` resolves → `true`.
  - Wrong owner: `lockedBy` mismatch → returns `false` (no `setMetadata`).
  - Expired: lockUntil in past → returns `false` (no `setMetadata`).
  - Missing record: 404 → returns `false`.
  - Concurrent modify: 412 → returns `false`.
  - Verify `setMetadata` preserves `lockedAt` and `lockedBy` from existing metadata.

**File:** `__tests__/unit/gcs-lock-provider.test.ts`

- Construct `GcsLockProvider` with a fake `Storage` (mock builder).
- Verify delegation to `StorageBasedLockProvider`: first lock triggers `insertRecord`, second triggers `updateRecord`.
- Verify `clearCache(name)` resets the registry so the next call is `insertRecord`.

### Step 8: Document manual verification procedure

**File:** `packages/gcs/MANUAL_VERIFICATION.md` (or README section).

Since there is no GCS emulator, document the manual pre-release verification checklist:

1. Create a dedicated GCS bucket (e.g. `tslock-verify-<random>`).
2. Authenticate via `gcloud auth application-default login` or `GOOGLE_APPLICATION_CREDENTIALS`.
3. Run a small script that exercises:
   - First lock acquires (`insertRecord` path).
   - Second concurrent lock on same name fails (`updateRecord` returns false).
   - Unlock succeeds.
   - Re-lock after unlock succeeds.
   - Extend succeeds when called by the holder.
   - Extend fails when called by a non-holder (different hostname simulated by overriding `Utils.getHostname` via a subclass).
4. Verify the lock objects in the GCS console have the expected metadata fields.
5. Verify the lock objects' generations increment on each write.

This is run before each release. CI does not run this (no GCP credentials in CI).

### Step 9: Verify

```bash
cd packages/gcs
pnpm typecheck
pnpm test          # unit only
pnpm build
```

All must pass. Integration tests against a real bucket are a manual release-time check (Step 8).

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| No GCS emulator → integration contract not run in CI | Unit tests cover the accessor logic with comprehensive mocks. Manual verification procedure (Step 8) is the release gate. Document this clearly so users know. |
| `@google-cloud/storage` error shape varies (ApiError, StorageError, GaxiosError) | Duck-type on `code` / `status` numeric fields in `gcs-errors.ts`. Do not `instanceof` check. |
| `file.get()` response shape differs across SDK versions (generation as string vs number, metadata path) | `getWithMetadata` helper centralizes the response-shape handling. Coerce `generation` via `Number()`. Test against the pinned peer-dep version (`^7.7.0`). |
| `setMetadata` on some GCS configurations does not increment generation | Tested manually — if a real bucket shows this, document as a known incompatibility and recommend `save` with `generationMatch` instead. (Default: `setMetadata` is correct for standard GCS.) |
| `precondition: { doesNotExist: true }` semantics differ subtly between real GCS and `fake-gcs-server` | Do not run the canonical integration suite against `fake-gcs-server`. Unit tests + manual GCS verification only. |
| Lock objects accumulate forever | Documented non-goal. User configures bucket Lifecycle rule on `objectPrefix`. |
| Race between `file.exists()` and `file.save()` (TOCTOU) | Expected — the `precondition: { doesNotExist: true }` is the atomic check. `exists()` is only an optimization to skip `save` when we know it will fail. |
| `Date.parse()` of ISO string returns `NaN` for non-ISO formats | `parseLockUntil` throws `LockException('Corrupted lock record')` on `NaN`. |
| `Utils.getHostname()` returns `'unknown'` in some environments (containers without hostname) | Acceptable — `lockedBy` is an opaque identifier. Document that callers wanting strict ownership can override via a subclass of `GcsStorageAccessor` if needed (not in v1 public API). |

## Estimation

~6 files, ~400-500 lines of implementation + ~400-600 lines of unit tests. Faster than S3 because no integration test setup (no Docker, no LocalStack). One focused session after `@tslock/core` is built.

## Order of Implementation

1. `package.json` + `tsup.config.ts` + empty `index.ts` (Step 1)
2. `gcs-provider-config.ts` (Step 2) — no deps
3. `gcs-errors.ts` (Step 3) — depends on `@google-cloud/storage` types only
4. `gcs-storage-accessor.ts` (Step 4) — depends on core + gcs-errors + gcs-provider-config
5. `gcs-lock-provider.ts` (Step 5) — depends on core + gcs-storage-accessor
6. `index.ts` (Step 6) — wire exports
7. Unit tests (Step 7) — validate accessor logic in isolation
8. Manual verification doc (Step 8) — release gate
9. Verify (Step 9) — `pnpm typecheck && pnpm test && pnpm build`
