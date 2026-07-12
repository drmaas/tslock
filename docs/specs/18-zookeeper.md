# Spec: @tslock/zookeeper

## Overview

The `@tslock/zookeeper` package provides a DIRECT `LockProvider` implementation backed by Apache ZooKeeper via the `zookeeper` npm package (a.k.a. `node-zookeeper` / `zk` — the most widely adopted ZooKeeper client for Node.js). Each lock is a PERSISTENT znode whose data is the ISO-8601 string of `lockAtMostUntil`. Acquisition uses optimistic concurrency: `setData` with the znode's current `version` (CAS) on an existing znode, or `create` on a missing znode. If the CAS fails (`BadVersionException`) or the create fails (`NodeExistsException`), another instance acquired concurrently and this attempt returns `undefined`.

This is the ShedLock `ZooKeeperLockProvider` algorithm. It deliberately uses PERSISTENT znodes (not EPHEMERAL — locks are time-based, not session-based). A crashed holder's lock remains valid until `lockAtMostUntil` (as written in the znode data), then becomes eligible for takeover by the next acquirer. There is no session-liveness coupling.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/zookeeper` |
| **Driver** | `zookeeper` (node-zookeeper, a.k.a. the `zk` npm package) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `zookeeper` (peer) |
| **Node.js** | >= 20 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. ZooKeeperLockProvider

```typescript
import type { ZooKeeper } from 'zookeeper';

class ZooKeeperLockProvider implements LockProvider {
  constructor(client: ZooKeeper, options?: ZooKeeperLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-connected `ZooKeeper` client (from the `zookeeper` npm package). The user is responsible for establishing the connection (connection string, session timeout, auth). The provider does not manage the client lifecycle or wait for connection — the user must ensure the client is connected before calling `lock()`.

### 2. ZooKeeperLockProviderOptions

```typescript
interface ZooKeeperLockProviderOptions {
  basePath?: string;   // default: '/shedlock'
}
```

Constant:
- `DEFAULT_PATH = '/shedlock'`

`basePath` is the parent znode under which one znode per lock name is created. The path `${basePath}/${lockName}` is the znode for a given lock. The base path znode is created on first use (with `creatingParentsIfNeeded`) if it does not exist.

Trailing slashes are stripped in the option resolver to avoid `//lockName` paths.

### 3. ZooKeeperLock

```typescript
class ZooKeeperLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `ZooKeeperLockProvider.lock()` when acquisition succeeds. `doExtend` throws `LockException('Extend not supported by this provider')` (inherits the default from `AbstractSimpleLock`). The provider does NOT implement `ExtensibleLockProvider`.

### 4. ZooKeeperAccessor (internal)

```typescript
class ZooKeeperAccessor {
  constructor(client: ZooKeeper, basePath: string);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration): Promise<void>;
}
```

Encapsulates all `getData` / `setData` / `create` calls and the error mapping for `NoNodeException` / `BadVersionException` / `NodeExistsException`.

## Locking Mechanism

The algorithm is optimistic concurrency on a PERSISTENT znode:

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const lockAtMostUntilValue = lockAtMostUntil(config);
  const isoLockAtMostUntil = Utils.toIsoString(lockAtMostUntilValue);
  const nodePath = `${this.basePath}/${config.name}`;

  try {
    // Attempt 1: setData with version check (existing znode)
    const stat = await this.client.getData(nodePath);
    const existingLockUntil = Date.parse(stat.data.toString('utf8'));

    if (existingLockUntil > now) {
      return undefined;  // lock still held
    }
    // expired — try CAS
    await this.client.setData(nodePath, Buffer.from(isoLockAtMostUntil), stat.version);
    return new ZooKeeperLock(config, this);
  } catch (e) {
    if (isNoNodeException(e)) {
      // Attempt 2: create a new znode
      try {
        await this.client.create(
          nodePath,
          Buffer.from(isoLockAtMostUntil),
          CreateMode.PERSISTENT,
          /* creatingParentsIfNeeded */ true,
        );
        return new ZooKeeperLock(config, this);
      } catch (e2) {
        if (isNodeExistsException(e2)) return undefined;  // someone created it concurrently
        throw e2;
      }
    }
    if (isBadVersionException(e)) return undefined;  // someone else acquired via CAS
    throw e;
  }
}
```

Semantics:
- `getData(nodePath)` returns `{ data: Buffer, stat: { version: number, ... } }`. The `stat.version` is the CAS token used by the subsequent `setData`.
- `setData(nodePath, data, version)` succeeds only if the znode's current version matches `version`. On a concurrent `setData` or `create`, the version mismatches and `BadVersionException` is thrown.
- `existingLockUntil > now` is the "lock still held" check — the previous holder wrote `lockAtMostUntil` into the znode. If we are still inside that window, we skip.
- `existingLockUntil <= now` is the "lock expired" path — we attempt to take over via CAS. If the CAS succeeds, we now hold the lock. If it fails (`BadVersionException`), someone else took it over between our `getData` and `setData`.
- `NoNodeException` from `getData` means no znode exists for this lock name — this is the first-ever acquisition. We `create` a PERSISTENT znode (not EPHEMERAL — locks are time-based, not session-based) with `creatingParentsIfNeeded: true` so the base path is created if missing.
- `NodeExistsException` from `create` means a concurrent acquirer created the znode between our `getData` (which returned `NoNodeException`) and `create`. We return `undefined` (we lost the race).

### unlock(config)

```typescript
async unlock(config: LockConfiguration): Promise<void> {
  const isoUnlock = Utils.toIsoString(unlockTime(config));
  const nodePath = `${this.basePath}/${config.name}`;
  await this.client.setData(nodePath, Buffer.from(isoUnlock));
}
```

Semantics:
- Unlock writes `unlockTime(config) = max(now, lockAtLeastUntil)` into the znode data. This is the new "lockUntil" — any acquirer that reads this value sees it as expired (since `unlockTime <= now` from the next acquirer's perspective, assuming clock sync within drift).
- The znode is NOT deleted. It persists as a PERSISTENT znode. The next acquirer's `getData` reads the unlock-time value, sees it as expired, and CASes in.
- `setData` without a version argument is unconditional (matches any version) — unlock is safe to call even if the znode was externally modified, because we are overwriting with an unlocked timestamp.
- If the znode does not exist (e.g. it was manually deleted), `NoNodeException` propagates. This is a configuration error, not a normal path.

### extend(config)

Not supported. `ZooKeeperLock` inherits the default `AbstractSimpleLock.doExtend()` which throws `LockException('Extend not supported by this provider')`. The provider does NOT implement `ExtensibleLockProvider`.

## File Structure

```
packages/zookeeper/
├── src/
│   ├── index.ts
│   ├── zookeeper-lock-provider.ts          # ZooKeeperLockProvider
│   ├── zookeeper-lock.ts                   # ZooKeeperLock extends AbstractSimpleLock
│   ├── zookeeper-accessor.ts               # ZooKeeperAccessor (getData/setData/create)
│   ├── zookeeper-errors.ts                 # error code helpers (isNoNodeException, etc.)
│   └── zookeeper-lock-provider-options.ts  # options type + DEFAULT_PATH
├── __tests__/
│   ├── zookeeper-lock-provider.test.ts      # unit tests (mocked ZooKeeper client)
│   └── integration/
│       ├── zookeeper-lock-provider.integration.test.ts
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `getData` returns valid znode, `existingLockUntil > now` → return `undefined` |
| First lock on a new name | `getData` throws `NoNodeException` → `create` PERSISTENT znode → `ZooKeeperLock` returned |
| Lock expired, CAS wins | `existingLockUntil <= now` → `setData(path, data, stat.version)` succeeds → `ZooKeeperLock` returned |
| Lock expired, CAS loses | `setData` throws `BadVersionException` (concurrent `setData`/`create` bumped the version) → return `undefined` |
| Lost the create race | `create` throws `NodeExistsException` (concurrent acquirer created the znode) → return `undefined` |
| Connection lost / session expired | `ZooKeeper` client throws (`CONNECTION_LOSS`, `SESSION_EXPIRED`, etc.) → propagate to caller |
| Holder crashed before `unlock` | The znode persists with the old `lockAtMostUntil` value. The next acquirer reads it, sees it as expired (after `lockAtMostUntil`), and CASes in. No session-liveness coupling. |
| `unlock` on a manually-deleted znode | `setData` throws `NoNodeException` → propagate (configuration error — the znode should not be manually deleted) |
| `extend()` called | Throws `LockException('Extend not supported by this provider')` |
| Invalid `basePath` (e.g. contains illegal characters) | ZooKeeper throws `BAD_ARGUMENTS` or `INVALID_PATH` → propagate |
| Base path does not exist | `create` with `creatingParentsIfNeeded: true` creates the base path automatically. `getData` for the lock znode returns `NoNodeException` (the lock znode itself does not exist). |
| `basePath` with trailing slash | Option resolver strips trailing `/` to avoid `//lockName` paths. |

## Dependencies

- **Peer**: `@tslock/core`, `zookeeper` (tested against `^6.x` — the `zk` / `node-zookeeper` package)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`, `@testcontainers/zookeeper` (or the `zookeeper` Docker image via `testcontainers`)

## Exports

From `src/index.ts`:
- `ZooKeeperLockProvider`
- `ZooKeeperLockProviderOptions`

`ZooKeeperAccessor` and `ZooKeeperLock` are not exported as public API.

## Non-Goals (for this package)

- No client lifecycle: the user creates, connects, and closes the `ZooKeeper` client. The provider does not parse connection strings, manage sessions, or wait for connection establishment.
- No EPHEMERAL znodes: locks are time-based (PERSISTENT znode whose data is `lockAtMostUntil`), not session-based. EPHEMERAL would couple lock validity to the holder's session, which is the wrong semantic for ShedLock (a crashed holder's lock should remain valid until `lockAtMostUntil`, not be released immediately on session expiry).
- No EPHEMERAL_SEQUENTIAL znodes: the classic ZooKeeper lock recipe (sequential ephemeral + watch) is a *blocking* lock — it queues waiters. TSLock is *skip-if-held*, so the simpler PERSISTENT + CAS pattern is correct.
- No extend: the znode data is the `lockAtMostUntil` timestamp. Extending would be a `setData` with the new `lockAtMostUntil`, but ShedLock's ZooKeeper provider does not implement it — neither does TSLock.
- No watches: the skip-if-held semantic does not need to wait for the lock to be released. A waiter would use a watch, but TSLock does not wait.
- No ACL / auth management: the user configures the `ZooKeeper` client with the appropriate ACL / auth. The provider creates znodes with the client's default ACL (`OPEN_ACL_UNSAFE` by default in the `zookeeper` npm package).
- No znode cleanup: lock znodes accumulate (one per lock name) but never get deleted. This is intentional — re-using the same znode across acquisitions is the algorithm. For high-cardinality lock names, document that the user may want a separate ZooKeeper namespace or periodic cleanup.
