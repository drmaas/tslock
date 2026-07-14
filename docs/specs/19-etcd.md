# Spec: @tslock/etcd

## Overview

The `@tslock/etcd` package provides a DIRECT `LockProvider` implementation backed by etcd v3 via the official `etcd3` Node.js client. Each lock is a KV entry whose key is `shedlock:${env}:${lockName}` and whose value is `ADDED:${isoNow}@${hostname}`. Locks are acquired with a transaction that asserts `key.version == 0` (key does not exist) and on success puts the value with a lease whose TTL is `ceil(lockAtMostFor / 1000)` seconds. If the transaction fails (key exists), the lease is revoked and the lock is not acquired.

Unlock revokes the lease (deleting the key) when `lockAtLeastFor <= 0`, or re-puts the key with a new short-lived lease (TTL = `ceil(lockAtLeastFor / 1000)`) and revokes the old lease — keeping the lock alive until `lockAtLeastUntil`. This matches the ShedLock `EtcdLockProvider` algorithm.

## Package

| Field | Value |
|---|---|
| **Name** | `@tslock/etcd` |
| **Driver** | `etcd3` (official etcd v3 Node.js client) — peer dependency |
| **Dependencies** | `@tslock/core` (peer), `etcd3` (peer) |
| **Node.js** | >= 22 |
| **Module format** | Dual ESM + CJS |
| **Build** | tsup |

## Public API

### 1. EtcdLockProvider

```typescript
import type { Etcd3 } from 'etcd3';

class EtcdLockProvider implements LockProvider {
  constructor(client: Etcd3, options?: EtcdLockProviderOptions);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

The constructor accepts an already-configured `Etcd3` client. The user is responsible for configuring the client (endpoints, credentials, TLS). The provider does not manage the client lifecycle.

### 2. EtcdLockProviderOptions

```typescript
interface EtcdLockProviderOptions {
  env?: string;   // default: 'default'
}
```

Constants:
- `DEFAULT_ENV = 'default'`
- `MILLIS_IN_SECOND = 1000`

`env` is a namespace segment in the key: `shedlock:${env}:${lockName}`. Use it to partition lock namespaces across environments (e.g. `prod`, `staging`) within the same etcd cluster.

### 3. EtcdLock

```typescript
class EtcdLock extends AbstractSimpleLock {
  protected doUnlock(): Promise<void>;
  protected doExtend(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `EtcdLockProvider.lock()` when acquisition succeeds. Carries the `leaseId` granted at acquisition; `doUnlock` revokes it (or swaps it for a shorter lease if `lockAtLeastFor > 0`). `doExtend` throws `LockException('Extend not supported by this provider')` (inherits the default from `AbstractSimpleLock`). The provider does NOT implement `ExtensibleLockProvider`.

### 4. EtcdLockAccessor (internal)

```typescript
class EtcdLockAccessor {
  constructor(
    client: Etcd3,
    env: string,
  );
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  unlock(config: LockConfiguration, leaseId: number | bigint): Promise<void>;
}
```

Encapsulates all `client.txn`, `client.lease`, `client.put`, and `lease.revoke` calls. `EtcdLockProvider` delegates to this and wraps the result in `EtcdLock`.

### 5. Key & Value formats (internal)

```
key   = `shedlock:${env}:${lockName}`
value = `ADDED:${Utils.toIsoString(now)}@${hostname}`
```

The value carries the acquisition timestamp and hostname for diagnostics — it is not parsed by the algorithm (which uses the key's version and lease, not the value).

## Locking Mechanism

The algorithm uses an etcd v3 transaction with a single compare (`key.version == 0`) and two branches:
- `then` (key absent): `Op.put(key, value, { lease: leaseId })` — write the key with the lease attached.
- `else` (key exists): `Op.get(key)` — read the existing value (used only to consume the branch; the transaction is `!succeeded`).

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();
  const key = `shedlock:${this.env}:${config.name}`;
  const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`;
  const ttlSeconds = Math.ceil(config.lockAtMostFor / MILLIS_IN_SECOND);

  const lease = this.client.lease(ttlSeconds);
  const leaseId = lease.id;  // ID is available immediately after .lease() — lease is granted on the next await

  try {
    const txn = this.client
      .txn()
      .if(Cmp.key(key).version === 0)
      .then(Op.put(key, value, { lease: leaseId }))
      .else(Op.get(key));

    const result = await txn.commit();

    if (result.succeeded) {
      return new EtcdLock(config, this, leaseId);
    }
    // !succeeded — key exists, lock held. Revoke the lease we just created.
    await lease.revoke();
    return undefined;
  } catch (e) {
    // Best-effort cleanup on any error path.
    try { await lease.revoke(); } catch { /* swallow */ }
    throw e;
  }
}
```

Semantics:
- `this.client.lease(ttlSeconds)` creates a lease with TTL = `ceil(lockAtMostFor / 1000)` seconds. etcd's lease TTL is in whole seconds; `Math.ceil` ensures a sub-second `lockAtMostFor` (e.g. 500ms) becomes at least 1 second.
- `lease.id` is the numeric `LeaseId`. The lease is granted on the next `await` (the txn commit) — `etcd3` lazily grants the lease on first use.
- `Cmp.key(key).version === 0` — the key's `version` is 0 if it does not exist (or has never been created in the current revision). A key with a current lease has version > 0. This is the canonical etcd "create if absent" pattern.
- `Op.put(key, value, { lease: leaseId })` — put the value with the lease attached. When the lease is revoked or expires, etcd automatically deletes the key.
- `Op.get(key)` — the `else` branch. We do not use the result; it exists to consume the branch (etcd v3 transactions require at least one op per branch).
- On `!succeeded` (key exists), the lease we created is not attached to any key — we must revoke it explicitly to avoid orphaned leases accumulating in etcd.
- The `catch` block ensures the lease is revoked on any error path (e.g. network failure during `commit`). The `try { await lease.revoke(); } catch {}` swallows revoke errors (a failed revoke is not worth failing the original error).

### unlock(config, leaseId)

```typescript
async unlock(config: LockConfiguration, leaseId: number | bigint): Promise<void> {
  const key = `shedlock:${this.env}:${config.name}`;

  if (config.lockAtLeastFor <= 0) {
    // Revoke the lease — etcd automatically deletes the key.
    await this.client.lease(0, { id: leaseId }).revoke();
    return;
  }

  // Keep the lock alive until lockAtLeastUntil: re-put the key with a new short-lived lease.
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();
  const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`;
  const newTtlSeconds = Math.ceil(config.lockAtLeastFor / MILLIS_IN_SECOND);

  const newLease = this.client.lease(newTtlSeconds);
  const newLeaseId = newLease.id;

  await this.client.put(key).value(value).lease(newLeaseId).exec();
  // Revoke the old lease — the key now has the new lease, so revoking the old one does not delete it.
  await this.client.lease(0, { id: leaseId }).revoke();
}
```

Semantics:
- `config.lockAtLeastFor <= 0` → revoke the lease. etcd automatically deletes the key when the lease is revoked. This is the simple unlock path.
- `config.lockAtLeastFor > 0` → re-put the key with a new lease whose TTL is `ceil(lockAtLeastFor / 1000)`. The new lease is granted, the key is overwritten with the new value and the new lease, then the OLD lease is revoked. Because the key now has the new lease, revoking the old lease does not delete the key. The key persists with the new lease until it expires (`lockAtLeastFor` seconds), at which point etcd deletes it.
- `this.client.lease(0, { id: leaseId })` — the `etcd3` API allows "wrapping" an existing lease ID by passing it in options. `lease(0, { id })` returns a `Lease` wrapper around the existing lease, whose `.revoke()` revokes that specific lease. Alternative: `client.leaseClient.revoke(leaseId)` — confirm against the installed `etcd3` version.
- The `value` is overwritten with a fresh `ADDED:${now}@${hostname}` — matching ShedLock's behavior of refreshing the value on unlock-with-`lockAtLeastFor`.

### extend(config)

Not supported. `EtcdLock` inherits the default `AbstractSimpleLock.doExtend()` which throws `LockException('Extend not supported by this provider')`. The provider does NOT implement `ExtensibleLockProvider`.

## File Structure

```
packages/etcd/
├── src/
│   ├── index.ts
│   ├── etcd-lock-provider.ts          # EtcdLockProvider
│   ├── etcd-lock.ts                   # EtcdLock extends AbstractSimpleLock (carries leaseId)
│   ├── etcd-accessor.ts               # EtcdAccessor (txn + lease + put ops)
│   └── etcd-lock-provider-options.ts  # options type + constants
├── __tests__/
│   ├── etcd-lock-provider.test.ts      # unit tests (mocked Etcd3 client)
│   └── integration/
│       ├── etcd-lock-provider.integration.test.ts
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `txn.commit()` returns `{ succeeded: false, ... }` → revoke lease → return `undefined` |
| First lock on a new key | `txn.commit()` returns `{ succeeded: true, ... }` → `EtcdLock` returned with the new lease |
| Lock expired (lease expired in etcd) | The key was auto-deleted by etcd when the lease expired → `version === 0` → txn succeeds → new lease + put → `EtcdLock` returned |
| `lock()` fails mid-txn (network error) | `catch` block revokes the lease (best-effort) and rethrows the original error |
| `unlock()` with `lockAtLeastFor <= 0` | Revoke the lease → etcd deletes the key → done |
| `unlock()` with `lockAtLeastFor > 0` | Re-put with new lease, revoke old lease → key persists until `lockAtLeastFor` seconds elapse, then auto-deleted |
| `unlock()` on a key whose lease already expired | The `put` overwrites the (deleted) key — `version === 0` for the new put. The "old" lease revoke is a no-op (already expired). |
| Holder crashed before `unlock` | The lease auto-expires after `lockAtMostFor` (in seconds), etcd auto-deletes the key. Next acquirer sees `version === 0` and acquires. |
| `lease.revoke()` on an already-expired lease | etcd returns success (idempotent). No error. |
| Connection error / etcd unavailable | `etcd3` client throws → propagate to caller |
| `extend()` called | Throws `LockException('Extend not supported by this provider')` |
| Orphaned lease from a failed `lock()` | The `catch` block revokes the lease. If the `catch` itself fails (e.g. network down), the lease will expire after `lockAtMostFor` seconds — no permanent orphan. |
| `lockAtMostFor` < 1000ms (sub-second) | `Math.ceil(0.5) = 1` → lease TTL is 1 second. Document that sub-second `lockAtMostFor` is rounded up to 1 second. |

## Dependencies

- **Peer**: `@tslock/core`, `etcd3` (tested against `^1.x`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`, `@testcontainers/etcd` (or the `quay.io/coreos/etcd` Docker image via `testcontainers`)

## Exports

From `src/index.ts`:
- `EtcdLockProvider`
- `EtcdLockProviderOptions`

`EtcdLockAccessor` and `EtcdLock` are not exported as public API.

## Non-Goals (for this package)

- No client lifecycle management: the user creates and closes the `Etcd3` client. The provider does not parse endpoints or configure credentials.
- No etcd election / queue recipes: etcd has built-in recipes for distributed locks (via ephemeral leases + elections). TSLock uses the simpler KV + lease + txn pattern that matches ShedLock (time-based, not fencing-token-based).
- No fencing tokens: the ShedLock algorithm does not use fencing tokens. The lock is a hint to skip work, not a guarantee of exclusive access to a downstream resource. Document this clearly — users with strong fencing requirements should use etcd's election recipe directly.
- No extend: the lease TTL is fixed at acquisition. Extending would be a new lease + re-put — possible but not implemented (matches ShedLock).
- No lease keepalive customization: the `etcd3` client's `lease(ttl)` automatically keeps the lease alive while the process is running (via periodic `LeaseKeepAliveRequest`). This is the correct behavior — the lease should not expire while the holder is alive. On process crash, the keepalive stops and the lease expires after `lockAtMostFor`. Document this.
- No multi-key transactions across lock names: each lock is a single-key transaction. Multi-key transactions would be a different feature (e.g. acquire-locks-A-and-B-atomically) — not in scope.
- No key prefix configuration: the `shedlock:` prefix is hard-coded. The `env` segment is configurable. Users who need a different prefix can fork or wrap the provider. Document this.
