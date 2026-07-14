# Spec: @tslock/redis-core + @tslock/redis + @tslock/redis-ioredis

## Overview

The `@tslock/redis-core`, `@tslock/redis`, and `@tslock/redis-ioredis` packages together provide a DIRECT `ExtensibleLockProvider` backed by Redis. They share the same locking algorithm — `SET key value NX PX` for acquisition, Lua-scripted `GET`-then-`DEL`/`PEXPIRE` for release and extension — and differ only in the Redis client driver.

- **`@tslock/redis-core`** holds the provider logic, the `RedisTemplate` interface, the `RedisLock` class, and the Lua scripts. It has **zero Redis client dependencies** (depends only on `@tslock/core`).
- **`@tslock/redis`** implements `RedisTemplate` for the official `redis` (node-redis) client.
- **`@tslock/redis-ioredis`** implements `RedisTemplate` for the `ioredis` client (the most widely adopted Redis client in the Node.js ecosystem).

Both adapter packages depend on `@tslock/redis-core` and their respective driver. This mirrors ShedLock's Jedis and Lettuce providers, which share the same `InternalRedisLockProvider` and differ only in the connection abstraction.

## Package

| Field | @tslock/redis-core | @tslock/redis | @tslock/redis-ioredis |
|---|---|---|---|
| **Name** | `@tslock/redis-core` | `@tslock/redis` | `@tslock/redis-ioredis` |
| **Driver** | none (zero Redis client deps) | `redis` (node-redis, official) — peer | `ioredis` — peer |
| **Dependencies** | `@tslock/core` (peer) | `@tslock/core` (peer), `@tslock/redis-core` (peer), `redis` (peer) | `@tslock/core` (peer), `@tslock/redis-core` (peer), `ioredis` (peer) |
| **Node.js** | >= 22 | >= 22 | >= 22 |
| **Module format** | Dual ESM + CJS | Dual ESM + CJS | Dual ESM + CJS |
| **Build** | tsup | tsup | tsup |

## Public API

### @tslock/redis-core

#### 1. RedisTemplate interface

Implemented by the adapter packages; consumed by `InternalRedisLockProvider`.

```typescript
interface RedisTemplate {
  setIfAbsent(key: string, value: string, expireMillis: number): Promise<boolean>;
  setIfPresent(key: string, value: string, expireMillis: number): Promise<boolean>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
}
```

- `setIfAbsent` — `SET key value NX PX expireMillis`. Returns `true` if the key was set (lock acquired), `false` if the key already existed.
- `setIfPresent` — `SET key value XX PX expireMillis`. Returns `true` if the key was set (key existed), `false` if the key did not exist.
- `eval` — runs a Lua script with `keys` and `args`. Returns the script's result (for the del/upd scripts: `1` on success, `0` on mismatch).
- `delete` — `DEL key`. Best-effort; the caller does not inspect the return.
- `get` — `GET key`. Returns the stored value or `null`.

#### 2. InternalRedisLockProvider

```typescript
class InternalRedisLockProvider implements ExtensibleLockProvider {
  constructor(
    template: RedisTemplate,
    config?: RedisLockProviderConfig,
  );
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Implements the shared locking algorithm. The adapter packages construct an `InternalRedisLockProvider` with their `RedisTemplate` implementation and expose it (directly or via a thin subclass) as their public `LockProvider`.

#### 3. RedisLockProviderConfig

```typescript
interface RedisLockProviderConfig {
  keyPrefix?: string;    // default: 'job-lock'
  env?: string;          // default: 'default'
  safeUpdate?: boolean;  // default: true
}
```

- `keyPrefix` — prefix for all lock keys. Default `DEFAULT_KEY_PREFIX = 'job-lock'`.
- `env` — environment discriminator appended to the key. Default `ENV_DEFAULT = 'default'`. Lets multiple environments (e.g. `staging`, `prod`) share a Redis instance without colliding.
- `safeUpdate` — when `true` (default), `unlock` and `extend` use Lua scripts to atomically verify the stored value matches before deleting/expiring. When `false`, they fall back to non-atomic `DEL` / `SET ... XX PX` (faster but a concurrent holder swap could release the wrong lock — only disable when you know the lock name is unique per holder).

#### 4. Constants

```typescript
declare const DEFAULT_KEY_PREFIX: 'job-lock';
declare const ENV_DEFAULT: 'default';
```

#### 5. Key & Value Format

**Key:** `${prefix}:${env}:${lockName}` (e.g. `job-lock:default:my-task`).

**Value:** `ADDED:${isoNow}@${hostname}:${uuid}`
- `isoNow` — `Utils.toIsoString(ClockProvider.now())` (e.g. `2018-12-07T12:30:37.810Z`).
- `hostname` — `Utils.getHostname()`.
- `uuid` — a random UUID (`crypto.randomUUID()`).

The value embeds the holder's identity and a unique nonce so the Lua scripts can verify ownership before deleting or expiring. The `ADDED:` prefix is a stable marker borrowed from ShedLock for readability when inspecting keys via `redis-cli`.

#### 6. RedisLock

```typescript
class RedisLock extends AbstractSimpleLock {
  constructor(
    template: RedisTemplate,
    key: string,
    value: string,
    config: LockConfiguration,
    safeUpdate: boolean,
  );
  protected doUnlock(): Promise<void>;
  protected doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Returned by `InternalRedisLockProvider.lock()` when acquisition succeeds. `doUnlock` and `doExtend` run the release/extend logic below.

### @tslock/redis (node-redis adapter)

#### 1. NodeRedisLockProvider

```typescript
import type { RedisClientType } from 'redis';

class NodeRedisLockProvider implements ExtensibleLockProvider {
  constructor(
    client: RedisClientType,
    config?: RedisLockProviderConfig,
  );
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Constructs a `NodeRedisTemplate` wrapping the `redis` client and delegates to an internal `InternalRedisLockProvider`.

#### 2. NodeRedisTemplate (internal)

```typescript
class NodeRedisTemplate implements RedisTemplate {
  constructor(client: RedisClientType);
  setIfAbsent(key, value, expireMillis): Promise<boolean>;
  setIfPresent(key, value, expireMillis): Promise<boolean>;
  eval(script, keys, args): Promise<unknown>;
  delete(key): Promise<void>;
  get(key): Promise<string | null>;
}
```

### @tslock/redis-ioredis (ioredis adapter)

#### 1. IoRedisLockProvider

```typescript
import type Redis from 'ioredis';
import type { Cluster } from 'ioredis';

class IoRedisLockProvider implements ExtensibleLockProvider {
  constructor(
    client: Redis | Cluster,
    config?: RedisLockProviderConfig,
  );
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}
```

Accepts a single `ioredis` client or a `Cluster` client. Constructs an `IoRedisTemplate` and delegates to an internal `InternalRedisLockProvider`.

#### 2. IoRedisTemplate (internal)

```typescript
class IoRedisTemplate implements RedisTemplate {
  constructor(client: Redis | Cluster);
  setIfAbsent(key, value, expireMillis): Promise<boolean>;
  setIfPresent(key, value, expireMillis): Promise<boolean>;
  eval(script, keys, args): Promise<unknown>;
  delete(key): Promise<void>;
  get(key): Promise<string | null>;
}
```

## Locking Mechanism

All three packages use the same algorithm; only the driver call shape differs (see Driver Differences).

### lock(config)

```typescript
async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
  const now = ClockProvider.now();
  const hostname = Utils.getHostname();
  const key = `${this.keyPrefix}:${this.env}:${config.name}`;
  const value = `ADDED:${Utils.toIsoString(now)}@${hostname}:${crypto.randomUUID()}`;

  const ok = await this.template.setIfAbsent(key, value, config.lockAtMostFor);
  if (!ok) return undefined;
  return new RedisLock(this.template, key, value, config, this.safeUpdate);
}
```

- `SET key value NX PX lockAtMostFor` — a single atomic round-trip. `NX` means "set only if not exists"; `PX` sets the TTL in millis. Redis guarantees the `NX` + `PX` are applied atomically (no race between `SETNX` and `PEXPIRE`).
- If `SET NX PX` returns `"OK"` → lock acquired → return `RedisLock`.
- If `SET NX PX` returns `null` (key existed) → lock held by another instance → return `undefined`.
- The TTL (`lockAtMostFor`) is the safety net: if the holder crashes, the lock auto-expires. No orphaned locks.

### unlock (RedisLock.doUnlock)

```typescript
protected async doUnlock(): Promise<void> {
  if (this.config.lockAtLeastFor <= 0) {
    if (this.safeUpdate) {
      await this.template.eval(DEL_LUA_SCRIPT, [this.key], [this.value]);
    } else {
      await this.template.delete(this.key);
    }
  } else {
    // Keep the lock for the remaining minimum hold time.
    await this.template.setIfPresent(this.key, this.value, this.config.lockAtLeastFor);
  }
}
```

- **No `lockAtLeastFor`** (`lockAtLeastFor <= 0`):
  - `safeUpdate = true` → run the `DEL_LUA_SCRIPT`: `GET key`; if it equals `value`, `DEL key`. This verifies we still own the lock before deleting — prevents releasing a lock we no longer hold (e.g. after expiry + re-acquisition by another instance).
  - `safeUpdate = false` → plain `DEL key`. Faster but unsafe if the lock could have been taken over by another instance.
- **With `lockAtLeastFor`** (`lockAtLeastFor > 0`):
  - `SET key value XX PX lockAtLeastFor` — keep the key but shorten its TTL to `lockAtLeastFor`. The `XX` flag means "set only if exists"; combined with the same `value`, this effectively refreshes the TTL. (We do NOT verify ownership here because `lockAtLeastFor` is a minimum-hold guarantee — if the lock expired and someone else took it, the `XX` with a different value would still overwrite; in practice the holder calls `unlock` well within `lockAtMostFor`, so the lock is still valid. The `safeUpdate` Lua path is not used for the `lockAtLeastFor` branch in ShedLock; TSLock matches this for behavioral parity. See Risks in the implementation plan.)

### extend (RedisLock.doExtend)

```typescript
protected async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
  const expireMillis = newConfig.lockAtMostFor;
  let ok: boolean;
  if (this.safeUpdate) {
    const result = await this.template.eval(UPD_LUA_SCRIPT, [this.key], [this.value, String(expireMillis)]);
    ok = Number(result) === 1;
  } else {
    ok = await this.template.setIfPresent(this.key, this.value, expireMillis);
  }
  if (!ok) return undefined;
  return new RedisLock(this.template, this.key, this.value, newConfig, this.safeUpdate);
}
```

- `safeUpdate = true` → run the `UPD_LUA_SCRIPT`: `GET key`; if it equals `value`, `PEXPIRE key expireMillis`. Atomic ownership check + TTL refresh. Returns `1` on success, `0` on mismatch (lock lost or held by another).
- `safeUpdate = false` → `SET key value XX PX expireMillis`. `XX` means "set only if exists"; refreshes the TTL. Does NOT verify ownership — a concurrent holder swap would be silently overwritten.
- On success → return a new `RedisLock` (the original is invalidated by `AbstractSimpleLock.extend()`).
- On failure → return `undefined` (lock lost).

### Lua Scripts

Defined as module-level string constants in `@tslock/redis-core`.

```typescript
const DEL_LUA_SCRIPT = `if redis.call("get",KEYS[1])==ARGV[1] then return redis.call("del",KEYS[1]) else return 0 end`;

const UPD_LUA_SCRIPT = `if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('pexpire',KEYS[1],ARGV[2]) else return 0 end`;
```

- `DEL_LUA_SCRIPT` — atomic `GET`-then-`DEL`. Returns `1` if the value matched and the key was deleted, `0` otherwise. Prevents deleting a lock we no longer own.
- `UPD_LUA_SCRIPT` — atomic `GET`-then-`PEXPIRE`. Returns `1` if the value matched and the TTL was refreshed, `0` otherwise. Prevents extending a lock we no longer own.

Both scripts use `KEYS[1]` for the lock key and `ARGV[1]` (and `ARGV[2]` for the extend script) for the value and expiry. Redis executes Lua scripts atomically (single-threaded), so the `GET` and `DEL`/`PEXPIRE` are not interleavable.

## Driver Differences

| Aspect | `@tslock/redis` (node-redis) | `@tslock/redis-ioredis` (ioredis) |
|---|---|---|
| **Client type** | `RedisClientType` from `redis` | `Redis \| Cluster` from `ioredis` |
| **`setIfAbsent`** | `client.set(key, value, { PX: expireMillis, NX })` → returns `"OK"` or `null` | `client.set(key, value, 'PX', expireMillis, 'NX')` → returns `"OK"` or `null` |
| **`setIfPresent`** | `client.set(key, value, { PX: expireMillis, XX })` → returns `"OK"` or `null` | `client.set(key, value, 'PX', expireMillis, 'XX')` → returns `"OK"` or `null` |
| **`eval`** | `client.eval(script, { keys, args })` → returns script result | `client.evalsha(sha1, 1, ...keys, ...args)` with fallback to `client.eval(script, 1, ...keys, ...args)` on `NOSCRIPT` → returns script result |
| **`delete`** | `client.del(key)` → returns count (ignored) | `client.del(key)` → returns count (ignored) |
| **`get`** | `client.get(key)` → returns `string \| null` | `client.get(key)` → returns `string \| null` |
| **Auth / TLS** | Configured on the `createClient()` factory by the user | Configured on the `new Redis()` / `new Cluster()` constructor by the user |
| **Cluster support** | Not directly; user passes a client created with the cluster setup | First-class — `Redis \| Cluster` accepted |
| **`SET` result mapping** | `"OK"` → `true`, `null` → `false` | `"OK"` → `true`, `null` → `false` |

The `eval` mapping for `ioredis` uses `EVALSHA` first (with the script's SHA1 hash) for efficiency — Redis caches compiled scripts and `EVALSHA` avoids resending the source. On a `NOSCRIPT` error (script not cached, e.g. after a Redis flush or failover), fall back to `EVAL`. The `node-redis` driver handles `EVALSHA`/`EVAL` internally when calling `client.eval(...)`, so the adapter just calls `client.eval(script, { keys, args })`.

## File Structure

```
packages/redis-core/
├── src/
│   ├── index.ts
│   ├── redis-template.ts              # RedisTemplate interface
│   ├── internal-redis-lock-provider.ts # InternalRedisLockProvider + RedisLockProviderConfig
│   ├── redis-lock.ts                  # RedisLock extends AbstractSimpleLock
│   ├── redis-lua-scripts.ts           # DEL_LUA_SCRIPT, UPD_LUA_SCRIPT
│   └── constants.ts                   # DEFAULT_KEY_PREFIX, ENV_DEFAULT
├── __tests__/
│   ├── internal-redis-lock-provider.test.ts  # unit tests (mocked RedisTemplate)
│   └── redis-lock.test.ts                     # unit tests for doUnlock / doExtend
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/redis/
├── src/
│   ├── index.ts
│   ├── node-redis-lock-provider.ts     # NodeRedisLockProvider
│   └── node-redis-template.ts         # NodeRedisTemplate implements RedisTemplate
├── __tests__/
│   ├── node-redis-template.test.ts             # unit tests (mocked redis client)
│   └── integration/
│       ├── node-redis.integration.test.ts      # extends lockProviderIntegrationTests
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/redis-ioredis/
├── src/
│   ├── index.ts
│   ├── io-redis-lock-provider.ts       # IoRedisLockProvider
│   └── io-redis-template.ts            # IoRedisTemplate implements RedisTemplate
├── __tests__/
│   ├── io-redis-template.test.ts               # unit tests (mocked ioredis client)
│   └── integration/
│       ├── io-redis.integration.test.ts        # extends lockProviderIntegrationTests
│       └── testcontainer setup
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Error Handling Summary

| Situation | Behavior |
|---|---|
| Lock held by another instance | `SET NX PX` returns `null` → `undefined` |
| First lock on a key | `SET NX PX` returns `"OK"` → `RedisLock` |
| Lock expired (TTL lapsed) | Redis auto-deleted the key → next `SET NX PX` succeeds → lock acquired |
| `unlock` with `safeUpdate` (no `lockAtLeastFor`) | Lua `GET`-then-`DEL` — deletes only if value matches |
| `unlock` without `safeUpdate` (no `lockAtLeastFor`) | Plain `DEL key` — best-effort |
| `unlock` with `lockAtLeastFor > 0` | `SET key value XX PX lockAtLeastFor` — shorten TTL to the minimum hold time |
| `unlock` on a key we no longer own (`safeUpdate`) | Lua `GET` returns a different value → `DEL` skipped → no-op (benign) |
| `extend` with `safeUpdate` | Lua `GET`-then-`PEXPIRE` — refreshes TTL only if value matches → new `RedisLock` |
| `extend` without `safeUpdate` | `SET key value XX PX expireMillis` — refreshes TTL if key exists |
| `extend` on a lost lock (value mismatch) | Lua returns `0` → `undefined` |
| `extend` on an expired/missing key | Lua `GET` returns `null` ≠ value → `0` → `undefined` (or `XX` fails → `undefined`) |
| Connection error | Propagate the driver error to the caller |
| `EVALSHA` returns `NOSCRIPT` (ioredis) | Fall back to `EVAL` with the script source |
| Redis failover / cluster redirect | Propagate / handled by the driver; not the provider's concern |

## Dependencies

### @tslock/redis-core
- **Peer**: `@tslock/core`
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`

### @tslock/redis
- **Peer**: `@tslock/core`, `@tslock/redis-core`, `redis` (tested against `^4.0.0`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`

### @tslock/redis-ioredis
- **Peer**: `@tslock/core`, `@tslock/redis-core`, `ioredis` (tested against `^5.0.0`)
- **Dev**: `typescript`, `tsup`, `vitest`, `@types/node`, `testcontainers`

## Exports

### @tslock/redis-core
- `InternalRedisLockProvider`
- `RedisLockProviderConfig`
- `RedisTemplate`
- `RedisLock`
- `DEFAULT_KEY_PREFIX`
- `ENV_DEFAULT`

The Lua scripts (`DEL_LUA_SCRIPT`, `UPD_LUA_SCRIPT`) are exported for testing/inspection but not part of the stable public API.

### @tslock/redis
- `NodeRedisLockProvider`
- `NodeRedisTemplate` (exported so users can subclass or inspect, but not typically constructed directly)
- Re-exports `RedisLockProviderConfig`, `RedisTemplate` from `@tslock/redis-core` for convenience.

### @tslock/redis-ioredis
- `IoRedisLockProvider`
- `IoRedisTemplate` (exported for the same reason)
- Re-exports `RedisLockProviderConfig`, `RedisTemplate` from `@tslock/redis-core` for convenience.

## Non-Goals (for these packages)

- No Redlock: TSLock's Redis provider uses single-instance `SET NX PX` + Lua, matching ShedLock. Redlock (quorum-based) is a different algorithm and is out of scope.
- No connection management: the user creates the Redis client (`createClient()` / `new Redis()`) and passes it in. The packages do not parse `redis://` URLs, manage connection pools, or handle reconnection strategies.
- No Redis Sentinel / Cluster failover logic: the driver handles failover; the provider is agnostic.
- No pub/sub: locks are plain keys, not channels.
- No pipelining / batching: each lock operation is a single round-trip. The Lua scripts are single commands.
- No `lockAtLeastFor` Lua path: the `lockAtLeastFor` branch of `unlock` uses `SET ... XX PX` without an ownership check (matches ShedLock). A stricter version (Lua `GET`-then-`PEXPIRE` for the minimum-hold case) is possible but diverges from ShedLock's behavior.
- No multi-key locks: one lock = one key. There is no "lock a set of keys atomically" feature.
- No script-cache warming: the `ioredis` adapter relies on `EVALSHA`-with-`EVAL`-fallback at runtime. Pre-loading scripts on startup is the user's concern.
