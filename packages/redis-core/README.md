# @tslock/redis-core

> Shared Redis locking logic for the TSLock Redis providers.

This package contains `InternalRedisLockProvider` — the dialect-agnostic implementation of the ShedLock Redis algorithm (`SET NX PX` + Lua scripts) — plus the `RedisTemplate` interface and the Lua scripts themselves. It has **no Redis client dependency**.

You normally don't depend on this directly. Use [`@tslock/redis`](../redis/README.md) (node-redis) or [`@tslock/redis-ioredis`](../redis-ioredis/README.md) (ioredis) instead. Reach for this package only if you're writing a `RedisTemplate` adapter for a Redis client TSLock doesn't ship one for.

## Installation

```bash
pnpm add @tslock/redis-core
```

## Usage (custom client adapter)

Implement `RedisTemplate`, then wrap it with `InternalRedisLockProvider`:

```typescript
import { InternalRedisLockProvider, type RedisTemplate } from '@tslock/redis-core';

class MyRedisTemplate implements RedisTemplate {
  // implement setIfAbsent, setIfPresent, eval, deleteKey, get
}

const provider = new InternalRedisLockProvider(new MyRedisTemplate(), {
  keyPrefix: 'job-lock',
  env: 'prod',
  safeUpdate: true,
});
```

## Exports

| Export | Description |
|---|---|
| `InternalRedisLockProvider` | The shared lock provider (takes a `RedisTemplate`). |
| `RedisTemplate` (type) | The interface a client adapter implements. |
| `RedisLockProviderConfig` (type) | `{ keyPrefix?, env?, safeUpdate? }`. |
| `DEL_SCRIPT`, `DEL_IF_EQUALS_SCRIPT`, `EXTEND_SCRIPT`, `EXTEND_IF_EQUALS_SCRIPT` | The Lua scripts. |
| `DEFAULT_KEY_PREFIX`, `ENV_DEFAULT` | Defaults (`'job-lock'`, `'default'`). |

## Requirements

- Node.js >= 22

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
