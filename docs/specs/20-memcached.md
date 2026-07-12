# Spec: @tslock/memcached

## Overview

The `@tslock/memcached` package provides a DIRECT `LockProvider` implementation backed by Memcached. It uses `memjs` (the most widely adopted pure-JavaScript memcached client for Node.js) and the memcached `add` command (which fails atomically if the key already exists) for lock acquisition, and `replace` / `delete` for release. This is a faithful port of ShedLock's `MemcachedLockProvider`.

> **⚠️ CAVEAT — Memcached can evict locks early.** Memcached is an LRU cache, not a durable store. Under memory pressure it may evict keys before their TTL expires. A prematurely evicted lock allows another instance to re-acquire it, so `lockAtMostFor` is an *upper* bound on hold time, not a guarantee. If you require strict lock validity, use a durable backend (Mongo, SQL, DynamoDB, Redis, Etcd, ZooKeeper, NATS KV with file storage). This limitation is inherent to memcached and is documented in the architecture (§6.7).

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/memcached` |
| **Driver** | `memjs` (pure-JS memcached client) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `memjs` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. MemcachedLockProvider

```typescript
import type { Client as MemjsClient } from 'memjs';

class MemcachedLockProvider implements LockProvider {
  constructor(client: MemjsClient, options?: MemcachedLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-configured `memjs.Client`. The user is responsible for creating the client with the correct servers and options. A convenience factory (`createMemcachedLockProvider`) is provided for the common case.

### 2. createMemcachedLockProvider factory

```typescript
function createMemcachedLockProvider(options: MemcachedLockProviderOptions): MemcachedLockProvider;
```

Creates a `memjs.Client` from `options.servers` and wraps it. Users who want full control over the client (custom cluster, auth, retries) construct `MemcachedLockProvider` directly.

### 3. MemcachedLockProviderOptions

```typescript
interface MemcachedLockProviderOptions {
  servers: string;                 // required, e.g. "localhost:11211" (comma-separated for clusters)
  env?: string;                    // default: 'default'
  clientOptions?: MemjsClientOptions;  // passed to memjs.Client.create()
}
```

- `servers`: memcached server addresses. Comma-separated for multiple servers (e.g. `"host1:11211,host2:11211"`). Required.
- `env`: namespace prefix for lock keys, allowing multiple environments (dev/staging/prod) to share a memcached cluster. Default `'default'`.
- `clientOptions`: any valid `memjs.ClientOptions` (retries, expires default, failover, etc.). Passed through to `memjs.Client.create()`.

### 4. MemcachedLock

```typescript
class MemcachedLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
}
```

Returned by `MemcachedLockProvider.lock()` on successful acquisition. Inherits the default `doExtend()` from `AbstractSimpleLock`, which throws `LockException('Extend not supported')`. **Memcached does not support `extend()`.**

## Locking Mechanism

### Key & Value Format

- **Key:** `shedlock:${env}:${config.name}` — e.g. `shedlock:default:my-task`
- **Value:** `ADDED:${Utils.toIsoString(now)}@${hostname}` — e.g. `ADDED:2018-12-07T12:30:37.810Z@worker-1`
- **TTL:** integer seconds via `Math.ceil(config.lockAtMostFor / 1000)`

The value is for human inspection / diagnostics; it is not parsed by the provider. Lock state is determined entirely by key existence and TTL.

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();
  const key = `shedlock:${this.env}:${config.name}`;
  const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`;
  const expireTimeSeconds = Math.ceil(config.lockAtMostFor / 1000);

  const result = await this.client.add(key, value, { expires: expireTimeSeconds });
  if (result.success) {
    return new MemcachedLock(this.client, key, value, config);
  }
  return undefined;
}
```

- `memjs.Client.add(key, value, { expires })` is atomic: it succeeds only if the key does NOT exist. On success it sets the value with the given TTL (in seconds).
- On failure (key exists), `result.success` is `false` — the lock is held by another instance, return `undefined`. This is NOT an error.
- The TTL is the upper bound on lock hold time. If the holder crashes, the key expires after `expireTimeSeconds`, releasing the lock automatically.

### unlock (MemcachedLock.doUnlock)

```typescript
protected async doUnlock(): Promise<void> {
  const keepLockFor = lockAtLeastUntil(this.config) - ClockProvider.now();
  if (keepLockFor <= 0) {
    const result = await this.client.delete(this.key);
    if (!result.success) {
      throw new LockException(`Can not unlock ${this.config.name} from memcached`);
    }
  } else {
    const keepLockForSeconds = Math.ceil(keepLockFor / 1000);
    const result = await this.client.replace(this.key, this.value, { expires: keepLockForSeconds });
    if (!result.success) {
      throw new LockException(`Can not unlock ${this.config.name} from memcached`);
    }
  }
}
```

- `keepLockFor = lockAtLeastUntil(config) - now` = `(createdAt + lockAtLeastFor) - now` = remaining time the lock must stay held to satisfy `lockAtLeastFor`. Equivalent to ShedLock's `lockAtLeastFor - (now - createdAt)`.
- **If `keepLockFor <= 0`**: the minimum hold time has elapsed; release immediately via `delete(key)`. If `delete` returns failure, the key was already evicted or expired — throw `LockException` (consistent with ShedLock; the caller logs it and the lock is gone regardless).
- **If `keepLockFor > 0`**: `replace(key, value, { expires: keepLockForSeconds })` overwrites the value with a shorter TTL equal to the remaining minimum hold time. If `replace` fails, the key was evicted before unlock — throw `LockException`.
- `replace` only succeeds if the key exists, so a successful `replace` confirms the lock is still ours.

### extend

Not supported. `AbstractSimpleLock.doExtend()` throws `LockException('Extend not supported by this provider')`. Memcached has no atomic check-and-extend primitive that verifies ownership, so we cannot safely extend a lock we may no longer hold. `KeepAliveLockProvider` must NOT wrap this provider (it requires `ExtensibleLockProvider`).

## ⚠️ Memcached Eviction Caveat

Memcached uses LRU eviction. When the cache is full, the least-recently-used keys are evicted regardless of their remaining TTL. This means:

1. **A lock can be released early.** If memcached evicts the lock key before `lockAtMostFor` elapses, another instance can acquire the lock while the original holder believes it still holds it. This breaks the at-most-once guarantee.
2. **`lockAtLeastFor` is also affected.** If the key is evicted during the minimum hold window, `replace` in `doUnlock` fails and throws `LockException`. The lock is already gone, so the throw is informational.
3. **No durable guarantee.** Memcached makes no persistence guarantees. A restart loses all locks (acceptable — they re-acquire), but memory pressure can lose specific locks mid-flight.

**Mitigations (user's responsibility):**
- Size the memcached cluster so lock keys are never evicted (locks are tiny — ~60 bytes each).
- Use a dedicated memcached instance for locks (not shared with application cache traffic).
- Prefer a durable backend (Mongo, SQL, DynamoDB, Redis, Etcd, ZooKeeper) if strict at-most-once is required.
- Treat `lockAtMostFor` as an upper bound, not a guarantee.

This is documented in the architecture (§6.7) and is the fundamental trade-off of using memcached for locking.

## File Structure

```
packages/memcached/
├── src/
│   ├── index.ts
│   ├── memcached-lock-provider.ts   # MemcachedLockProvider + createMemcachedLockProvider
│   ├── memcached-lock.ts           # MemcachedLock extends AbstractSimpleLock
│   ├── memcached-configuration.ts  # MemcachedLockProviderOptions
│   └── memjs-types.d.ts            # minimal type shim for memjs (no @types/memjs exists)
├── __tests__/
│   ├── memcached-lock-provider.test.ts          # unit tests (mocked memjs.Client)
│   └── integration/
│       └── memcached-lock-provider.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `add` returns `success: false` → return `undefined` |
| First lock on a key | `add` returns `success: true` → return `MemcachedLock` |
| `unlock()` with `keepLockFor <= 0` and key present | `delete` returns `success: true` → return void |
| `unlock()` with `keepLockFor <= 0` and key evicted/expired | `delete` returns `success: false` → throw `LockException` |
| `unlock()` with `keepLockFor > 0` and key present | `replace` returns `success: true` → return void |
| `unlock()` with `keepLockFor > 0` and key evicted | `replace` returns `success: false` → throw `LockException` |
| `extend()` | Throws `LockException('Extend not supported')` (inherited default) |
| Connection error / network failure | Propagate the memjs error to the caller |
| Key evicted mid-lock | Lock silently lost; documented caveat, not a runtime error |

## Dependencies

- **Peer**: `@tslock/core`, `memjs` (tested against `^1.5.x`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers` (memcached image)

## Exports

From `src/index.ts`:
- `MemcachedLockProvider`
- `createMemcachedLockProvider`
- `MemcachedLockProviderOptions`

`MemcachedLock` and the `memjs` type shim are not exported as public API.

## Non-Goals (for this package)

- No `extend()` support (memcached has no safe check-and-extend primitive).
- No connection management: the user creates the `memjs.Client` (or uses the factory).
- No eviction detection: the provider cannot detect that a key was evicted. The caveat is documented; users must size their cluster.
- No cluster-aware routing beyond what `memjs` provides natively.
- Not safe for `KeepAliveLockProvider` wrapping (requires `ExtensibleLockProvider`).
