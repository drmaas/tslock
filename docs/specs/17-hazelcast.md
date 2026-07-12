# Spec: @tslock/hazelcast

## Overview

The `@tslock/hazelcast` package provides a DIRECT `LockProvider` implementation backed by a Hazelcast `IMap` distributed map. It uses Hazelcast's entry-level pessimistic lock (`IMap.lock(key, ttl)`) to serialize access to a single lock name, then performs a get-check-put sequence inside that critical section. The lock record is a small JSON-serializable object stored as the map value, with a per-entry TTL set to `lockAtMostFor` so orphaned locks auto-expire if the holder crashes. This matches the ShedLock `HazelcastLockProvider` algorithm, which is **not** a `StorageBasedLockProvider` — the two-tier entry-lock-then-put pattern is unique to Hazelcast.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/hazelcast` |
| **Driver** | `hazelcast-client` (Hazelcast Node.js client) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `hazelcast-client` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. HazelcastLockProvider

```typescript
import type { HazelcastClient } from 'hazelcast-client';

class HazelcastLockProvider implements LockProvider {
  constructor(client: HazelcastClient, options?: HazelcastLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-started `HazelcastClient`. The user is responsible for configuring and starting the client (cluster address, auth, TLS, network config). The provider does not manage the client lifecycle.

### 2. HazelcastLockProviderOptions

```typescript
interface HazelcastLockProviderOptions {
  lockStoreKey?: string;        // default: 'shedlock_storage'
  lockLeaseTimeMs?: number;     // default: 30000 (30s) — TTL for the entry-level lock used during unlock
}
```

Constants:
- `DEFAULT_LOCK_STORE_KEY = 'shedlock_storage'`
- `DEFAULT_LOCK_LEASE_TIME = 30_000` (millis)

`lockStoreKey` is the name of the distributed `IMap` that holds the lock records. All instances sharing the same lock namespace must use the same `lockStoreKey`.

`lockLeaseTimeMs` is the TTL Hazelcast applies to the entry-level `IMap.lock(key)` during `unlock()`. It is a safety net: if the holder crashes between `store.lock(...)` and `store.unlock(...)`, the entry-level lock auto-releases after this TTL. The default (30s) is generous enough for normal cleanup but bounded so a crashed node does not stall new lock attempts.

### 3. HazelcastLock

```typescript
class HazelcastLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `HazelcastLockProvider.lock()` when acquisition succeeds. `doExtend` throws `LockException('Extend not supported by this provider')` (inherits the default from `AbstractSimpleLock` — Hazelcast does not implement extend). The provider does NOT implement `ExtensibleLockProvider`.

### 4. HazelcastLockRecord (internal)

```typescript
interface HazelcastLockRecord {
  lockUntil: string;     // ISO-8601 (Utils.toIsoString)
  lockedAt: string;      // ISO-8601
  lockedBy: string;     // hostname (Utils.getHostname())
}
```

Stored as the value of the `IMap` entry. All fields are ISO-8601 strings (lexicographically sortable) so that the Hazelcast client can serialize the object across the wire without custom serialization.

### 5. HazelcastAccessor (internal)

```typescript
class HazelcastAccessor {
  constructor(
    client: HazelcastClient,
    lockStoreKey: string,
    lockLeaseTimeMs: number,
  );
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}
```

Encapsulates all `IMap` operations. `HazelcastLockProvider` delegates to this and wraps the result in `HazelcastLock`.

## Locking Mechanism

The algorithm is a two-tier critical section:
1. **Outer lock**: `IMap.lock(lockName, ttl)` acquires Hazelcast's distributed, per-entry pessimistic lock for this lock name. Only one member in the cluster can hold it at a time. The TTL bounds how long the entry-level lock can be held if the holder crashes mid-operation.
2. **Inner get-check-put**: with the entry-level lock held, read the current lock record, compare `lockUntil` to `now`, and either insert a new record (no existing entry), replace the expired record, or return `undefined` (lock still valid). The `put` carries a per-entry TTL of `lockAtMostFor` so the lock record self-destructs if the holder never calls `unlock`.
3. **Outer unlock**: `IMap.unlock(lockName)` releases the entry-level lock so other members can proceed.

### lock(config)

```typescript
import { TimeUnit } from 'hazelcast-client';

async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const lockUntil = lockAtMostUntil(config);
  const keyLockTimeMs = lockUntil - now;  // duration the entry-level lock must be held
  const store = await this.client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);

  try {
    await store.lock(config.name, keyLockTimeMs, TimeUnit.MILLISECONDS);
    const existing = await store.get(config.name);

    if (existing === null) {
      // addNewLock — no entry exists yet
      await store.put(
        config.name,
        {
          lockUntil: Utils.toIsoString(lockUntil),
          lockedAt: Utils.toIsoString(now),
          lockedBy: Utils.getHostname(),
        },
        config.lockAtMostFor,
      );
      return new HazelcastLock(config, this);
    }

    const existingLockUntil = Date.parse(existing.lockUntil);
    if (existingLockUntil <= now) {
      // replaceLock — lock expired, take it over
      await store.put(
        config.name,
        {
          lockUntil: Utils.toIsoString(lockUntil),
          lockedAt: Utils.toIsoString(now),
          lockedBy: Utils.getHostname(),
        },
        config.lockAtMostFor,
      );
      return new HazelcastLock(config, this);
    }

    // lock is still held
    return undefined;
  } finally {
    await store.unlock(config.name);
  }
}
```

Field semantics:
- `store.lock(config.name, keyLockTimeMs, TimeUnit.MILLISECONDS)` — Hazelcast distributed lock on the entry. The TTL is the duration from `now` to `lockAtMostUntil` — long enough that a normal lock-check-put sequence completes well within it, but bounded so a crashed member does not block the cluster indefinitely.
- `store.get(config.name)` returns `null` if no entry exists, or the deserialized `HazelcastLockRecord`.
- `store.put(key, value, ttlMillis)` sets the value with a per-entry TTL. Hazelcast evicts the entry automatically when the TTL expires — this is the lock's `lockAtMostFor` guarantee.
- `store.unlock(config.name)` releases the entry-level distributed lock.

### unlock(config)

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const now = ClockProvider.now();
  const lockAtLeastUntilValue = lockAtLeastUntil(config);
  const store = await this.client.getMap<string, HazelcastLockRecord>(this.lockStoreKey);

  await store.lock(config.name, this.lockLeaseTimeMs, TimeUnit.MILLISECONDS);
  try {
    if (now >= lockAtLeastUntilValue) {
      // minimum hold time already elapsed — fully remove the lock
      await store.remove(config.name);
    } else {
      // keep the lock alive until lockAtLeastUntil
      await store.put(
        config.name,
        {
          lockUntil: Utils.toIsoString(lockAtLeastUntilValue),
          lockedAt: Utils.toIsoString(now),
          lockedBy: Utils.getHostname(),
        },
        config.lockAtLeastFor,
      );
    }
  } finally {
    await store.unlock(config.name);
  }
}
```

Semantics:
- Uses the configured `lockLeaseTimeMs` (default 30s) as the TTL for the entry-level lock during unlock. Unlock is a fast operation (single `remove` or `put`), so 30s is a generous safety net.
- If `now >= lockAtLeastUntil` (the minimum hold time has already elapsed), the lock is fully removed from the map — the next acquirer sees no entry and inserts fresh.
- If `now < lockAtLeastUntil`, the lock is re-put with `lockUntil = lockAtLeastUntil` and TTL = `lockAtLeastFor`. This preserves the minimum hold time even if the task completed quickly, preventing re-execution from clock drift on short tasks.
- The `lockedAt` and `lockedBy` are refreshed to reflect the unlock-time record (matching ShedLock).

### extend(config)

Not supported. `HazelcastLock` inherits the default `AbstractSimpleLock.doExtend()` which throws `LockException('Extend not supported by this provider')`. The provider does NOT implement `ExtensibleLockProvider`.

## File Structure

```
packages/hazelcast/
├── src/
│   ├── index.ts
│   ├── hazelcast-lock-provider.ts          # HazelcastLockProvider
│   ├── hazelcast-lock.ts                   # HazelcastLock extends AbstractSimpleLock
│   ├── hazelcast-accessor.ts               # HazelcastAccessor (IMap operations)
│   └── hazelcast-lock-provider-options.ts  # options type + constants
├── __tests__/
│   ├── hazelcast-lock-provider.test.ts      # unit tests (mocked HazelcastClient / IMap)
│   └── integration/
│       ├── hazelcast-lock-provider.integration.test.ts
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `existing.lockUntil > now` inside the entry-level critical section → return `undefined` |
| First lock on a new entry | `store.get` returns `null` → `addNewLock` put with TTL → `HazelcastLock` returned |
| Lock expired, second acquirer wins | `existing.lockUntil <= now` → `replaceLock` put with TTL → `HazelcastLock` returned |
| Holder crashed before `unlock` | Entry-level lock auto-released after `keyLockTimeMs`; lock record auto-evicted after `lockAtMostFor` TTL. Next acquirer finds `null` (or expired record) and acquires. |
| Holder crashed between `store.lock` and `store.unlock` | Entry-level lock auto-released after the TTL passed to `store.lock`. The next acquirer's `store.lock` blocks until then. |
| Two members race to acquire | `store.lock(config.name)` serializes — only one holds the entry lock at a time; the other blocks until the first releases. No `BadVersion`-style conflict. |
| `store.unlock` called without a matching `store.lock` | Hazelcast throws (`IllegalMonitorStateException`). Wrap in try/catch and log a warning — do not propagate (the lock acquisition/unlock decision has already been made). |
| Connection to cluster lost | Hazelcast client throws (`HazelcastError`, `ClientNotActiveError`, `ClientOfflineError`, etc.) → propagate to caller |
| `extend()` called | Throws `LockException('Extend not supported by this provider')` |
| Cluster topology change mid-operation | Hazelcast re-establishes the entry-level lock via its split-brain / partition-recovery semantics. The entry-level lock is safe across member loss as long as the partition quorum is maintained. |
| `store.put` TTL exceeds Hazelcast max TTL | Hazelcast clamps the TTL. Document the Hazelcast max-ttl config in the README. |

## Dependencies

- **Peer**: `@tslock/core`, `hazelcast-client` (tested against `^5.x`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`, `@testcontainers/hazelcast` (or the `hazelcast/hazelcast` Docker image via `testcontainers`)

## Exports

From `src/index.ts`:
- `HazelcastLockProvider`
- `HazelcastLockProviderOptions`

`HazelcastAccessor`, `HazelcastLock`, and `HazelcastLockRecord` are not exported as public API.

## Non-Goals (for this package)

- No client lifecycle management: the user starts (and stops) the `HazelcastClient`. The provider does not configure cluster addresses, auth, TLS, or network timeouts.
- No `EntryProcessor`-based acquisition: the entry-level lock + get-check-put pattern is simpler and matches ShedLock. An `EntryProcessor` would run on the partition owner and avoid a round-trip, but adds complexity and is not needed for the lock-check-put sequence.
- No extend support: the lock record has a fixed TTL set at acquisition. Extending would require a second `put` with a new TTL — possible but not implemented (matches ShedLock).
- No `lockAtMostFor` validation against Hazelcast's maximum lock lease time: the entry-level lock TTL during `lock()` is `keyLockTimeMs = lockUntil - now = lockAtMostFor` (effectively). If `lockAtMostFor` exceeds Hazelcast's maximum lock lease time, the client clamps it — but this is a Hazelcast config concern, not a TSLock concern. Document the Hazelcast lock-lease limit in the README.
- No custom serialization: the lock record is a plain object with string fields. Hazelcast's default serialization handles it. Users with custom serialization configs should ensure the lock record type is registered.
- No split-brain protection config: the user configures Hazelcast split-brain protection on the cluster side. The provider relies on Hazelcast's `IMap.lock` semantics under partitions.
