# Spec: @tslock/nats

## Overview

The `@tslock/nats` package provides a DIRECT `LockProvider` implementation backed by NATS JetStream's Key-Value store. It uses the official `nats` Node.js client and the JetStream KV `create` (fails if key exists) and `update` (fails on revision mismatch) operations for optimistic-concurrency-based locking. The lock value is an 8-byte big-endian long encoding the `lockUntil` epoch millis. This is a faithful port of ShedLock's `NatsLockProvider`.

The KV bucket is auto-created (default `shedlock-locks`, `StorageType.Memory`) on first use. Memory storage is the default because locks are ephemeral — there is no need to survive a NATS server restart. File storage can be configured for durability.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/nats` |
| **Driver** | `nats` (official NATS Node.js client) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `nats` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. NatsLockProvider

```typescript
import type { KV } from 'nats';

class NatsLockProvider implements LockProvider {
  constructor(kv: KV);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-obtained NATS JetStream `KV` store. The user is responsible for creating the `NatsConnection` and the KV bucket. A convenience factory (`createNatsLockProvider`) is provided for the common case.

### 2. createNatsLockProvider factory

```typescript
function createNatsLockProvider(options: NatsLockProviderOptions): Promise<NatsLockProvider>;
```

Connects to NATS, obtains the JetStream manager, gets-or-creates the KV bucket, and returns a `NatsLockProvider`. The connection is held internally via the `KV` handle; the user should close the underlying `NatsConnection` on shutdown.

### 3. NatsLockProviderOptions

```typescript
import type { StorageType, ConnectionOptions } from 'nats';

interface NatsLockProviderOptions {
  servers: string;                       // required, e.g. "nats://localhost:4222"
  bucketName?: string;                   // default: 'shedlock-locks'
  storage?: StorageType;                 // default: StorageType.Memory
  connectionOptions?: ConnectionOptions; // passed to nats.connect()
}
```

- `servers`: NATS server URLs. Comma-separated for clusters (e.g. `"nats://host1:4222,nats://host2:4222"`). Required.
- `bucketName`: KV bucket name. Default `'shedlock-locks'`.
- `storage`: JetStream storage type. Default `StorageType.Memory` (ephemeral — locks do not survive a server restart, which is fine for locks). Use `StorageType.File` for durability.
- `connectionOptions`: any valid `nats.ConnectionOptions` (auth, TLS, timeout). Passed to `nats.connect()`.

### 4. NatsLock

```typescript
class NatsLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
}
```

Returned by `NatsLockProvider.lock()` on successful acquisition. Inherits the default `doExtend()` from `AbstractSimpleLock`, which throws `LockException('Extend not supported')`. **NATS KV does not support `extend()`** — see Locking Mechanism for the rationale.

## Locking Mechanism

### Value Format

- **Key:** `config.name` (the lock name, used directly as the KV key)
- **Value:** 8-byte big-endian `Buffer` encoding `lockAtMostUntil(config)` as an epoch-millis signed 64-bit integer.

```typescript
function longToBytes(epochMillis: number): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(epochMillis), 0);
  return buf;
}

function bytesToLong(buf: Uint8Array): number {
  return Number(Buffer.from(buf).readBigInt64BE(0));
}
```

**Range note:** `writeBigInt64BE` covers ±2^63 millis ≈ ±292 million years — ample for any realistic lock duration. `Number()` is safe for all practical epoch-millis values (current epoch ≈ 1.7e12, well below 2^53 ≈ 9e15).

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const newLockUntil = lockAtMostUntil(config);
  const value = longToBytes(newLockUntil);

  const entry = await this.kv.get(config.name);
  if (entry === null) {
    // Key does not exist — try to create it.
    try {
      await this.kv.create(config.name, value);
      return new NatsLock(this.kv, config);
    } catch (e) {
      if (isNatsConflictError(e)) {
        return undefined;  // someone else created it concurrently
      }
      throw e;
    }
  }

  // Key exists — check if expired.
  const existingLockUntil = bytesToLong(entry.value);
  if (existingLockUntil > now) {
    return undefined;  // lock still held
  }

  // Expired — try to update with the existing revision (optimistic concurrency).
  try {
    await this.kv.update(config.name, value, entry.revision);
    return new NatsLock(this.kv, config);
  } catch (e) {
    if (isNatsConflictError(e)) {
      return undefined;  // revision mismatch — someone else acquired it
    }
    throw e;
  }
}
```

- `kv.get(name)` returns `null` if the key does not exist, or a `KeyValueEntry` with `.value` (Uint8Array) and `.revision` (number).
- **Path 1 — key absent:** `kv.create(name, value)` atomically creates the key only if it does not exist. On success, we hold the lock. On conflict (concurrent create), return `undefined`.
- **Path 2 — key present, not expired:** `existingLockUntil > now` → return `undefined` (lock held).
- **Path 3 — key present, expired:** `kv.update(name, value, entry.revision)` atomically updates the key only if the current revision matches `entry.revision`. On success, we hold the lock. On revision mismatch (someone else updated it first), return `undefined`.

### isNatsConflictError helper

```typescript
function isNatsConflictError(e: unknown): boolean {
  if (e && typeof e === 'object') {
    const err = e as { code?: number; message?: string };
    if (err.code === 10071) return true;                    // KV update/create conflict
    if (err.message && err.message.includes('stream name already in use')) return true;
  }
  return false;
}
```

Checks both the JetStream error code (`10071` for KV revision mismatch / create conflict) and the message string (for bucket-creation conflicts). Best-effort: unknown error shapes propagate.

### unlock (NatsLock.doUnlock)

```typescript
protected async doUnlock(): Promise<void> {
  const entry = await this.kv.get(this.config.name);
  if (entry === null) {
    return;  // nothing to unlock
  }
  const lockUntil = bytesToLong(entry.value);
  if (lockUntil > lockAtMostUntil(this.config)) {
    // The stored lockUntil is greater than what we set — lock was extended or taken over. Skip.
    return;
  }
  const now = ClockProvider.now();
  if (lockAtLeastUntil(this.config) > now) {
    // Keep the lock until lockAtLeastUntil.
    await this.kv.update(
      this.config.name,
      longToBytes(lockAtLeastUntil(this.config)),
      entry.revision,
    );
  } else {
    // Minimum hold time elapsed — delete the key.
    await this.kv.delete(this.config.name);
  }
}
```

- `entry === null`: the key was already deleted or never existed — nothing to do.
- `lockUntil > lockAtMostUntil(config)`: the stored value is higher than what we wrote, so someone else has extended or replaced the lock. Skip unlock to avoid clobbering.
- `lockAtLeastUntil > now`: the minimum hold time has not elapsed. `update` the key to hold until `lockAtLeastUntil`, preserving the current revision (we own it; no revision mismatch expected, but errors propagate).
- Otherwise: `delete` the key to release immediately.

### extend

Not supported. `AbstractSimpleLock.doExtend()` throws `LockException('Extend not supported by this provider')`.

**Why no extend?** ShedLock's `NatsLockProvider` also does not support extend. To extend safely we would need to verify the stored value still matches our `lockAtMostUntil` before overwriting — but `kv.update` with a revision only checks the revision number, not the value. A race between two holders of the same revision could clobber. Without a value-aware conditional update, extend is unsafe. `KeepAliveLockProvider` must NOT wrap this provider.

### Helper: longToBytes / bytesToLong

```typescript
function longToBytes(epochMillis: number): Buffer;
function bytesToLong(buf: Uint8Array): number;
```

8-byte big-endian `Buffer` <-> epoch millis. Uses `Buffer.writeBigInt64BE` / `readBigInt64BE` (Node 12+). Package-internal (not exported from `index.ts`); tested directly.

## File Structure

```
packages/nats/
├── src/
│   ├── index.ts
│   ├── nats-lock-provider.ts        # NatsLockProvider + createNatsLockProvider + isNatsConflictError
│   ├── nats-lock.ts                 # NatsLock extends AbstractSimpleLock
│   ├── nats-configuration.ts        # NatsLockProviderOptions
│   └── long-utils.ts                # longToBytes, bytesToLong
├── __tests__/
│   ├── nats-lock-provider.test.ts                # unit tests (mocked KV)
│   ├── long-utils.test.ts
│   └── integration/
│       └── nats-lock-provider.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance (key exists, not expired) | `kv.get` returns entry with `lockUntil > now` → `undefined` |
| First lock on a key (key absent) | `kv.create` succeeds → `NatsLock` |
| Concurrent create on same key | `kv.create` throws conflict error → `undefined` |
| Expired lock, no contention | `kv.get` returns entry, `kv.update` with revision succeeds → `NatsLock` |
| Expired lock, contention (revision mismatch) | `kv.update` throws conflict error → `undefined` |
| `unlock()` with `lockAtLeastFor=0` | `kv.delete` → void |
| `unlock()` with `lockAtLeastFor>0` and still in window | `kv.update` with `lockAtLeastUntil` → void |
| `unlock()` on already-deleted key | `kv.get` returns `null` → return (no-op) |
| `unlock()` on a lock whose stored `lockUntil` > our `lockAtMostUntil` | Skip (lock was taken/extended) → return |
| `extend()` | Throws `LockException('Extend not supported')` |
| Connection error / network failure | Propagate the nats error to the caller |
| Bucket auto-create fails (e.g. JetStream not enabled) | Propagate the error from `createNatsLockProvider` |

## Dependencies

- **Peer**: `@tslock/core`, `nats` (tested against `^2.x`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers` (NATS image)

## Exports

From `src/index.ts`:
- `NatsLockProvider`
- `createNatsLockProvider`
- `NatsLockProviderOptions`

`NatsLock`, `longToBytes`, `bytesToLong`, and `isNatsConflictError` are not exported as public API.

## Non-Goals (for this package)

- No `extend()` support (unsafe without value-aware conditional update).
- No connection management beyond the convenience factory: users who want full control construct `NatsLockProvider` directly with their own `KV`.
- No per-key TTL: JetStream KV TTL is bucket-wide, not per-key; we manage expiry via the stored `lockUntil` value. Users who want NATS-side TTL configure it on the bucket externally.
- Not safe for `KeepAliveLockProvider` wrapping (requires `ExtensibleLockProvider`).
- No support for non-JetStream NATS (core NATS has no KV store).
