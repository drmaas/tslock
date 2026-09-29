# @tslock/redis

> TSLock Redis provider using the official [`redis`](https://github.com/redis/node-redis) (node-redis) client.

A [TSLock](../../README.md) provider that acquires locks with `SET key NX PX <ttl>` and releases/extends them with Lua scripts that check the lock value before mutating. This matches the ShedLock Jedis algorithm. The shared locking logic lives in [`@tslock/redis-core`](../redis-core/README.md); this package supplies the thin `node-redis` adapter.

## Installation

```bash
pnpm add @tslock/core @tslock/redis redis
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createNodeRedisLockProvider } from '@tslock/redis';
import { createClient } from 'redis';

const redisClient = createClient({ url: 'redis://localhost:6379' });
await redisClient.connect();

const provider = createNodeRedisLockProvider(redisClient);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createNodeRedisLockProvider(client, config?)` accepts an optional config:

| Option | Default | Description |
|---|---|---|
| `keyPrefix` | `'job-lock'` | Redis key namespace. |
| `env` | `'default'` | Environment segment of the key (enables multi-tenancy). |
| `safeUpdate` | `true` | When `true`, unlock/extend use a Lua script that verifies the lock value first — safe across instances. Set `false` to use plain `DEL`/`SET XX` (faster, but less safe). |

The full key is `${keyPrefix}:${env}:${lockName}`.

> **Lock-name safety:** Lock names must be non-empty, contain no control characters, and be at most 1024 UTF-8 bytes. Redis ownership values include a hostname and random UUID because safe updates verify the stored value.

## Valkey and Redis-compatible managed services

This package speaks the Redis protocol (`SET NX PX` + Lua). It works against:

- **Valkey** (Redis-compatible OSS)
- **Amazon ElastiCache** (Redis or Valkey engine)
- **Amazon MemoryDB** (Redis OSS or Valkey)

Use TLS and AUTH as required by the managed endpoint (`rediss://…`, username/password). Cluster mode and admin-command differences (for example restricted `CONFIG` / `FLUSHALL`) do not affect the lock scripts as long as `SET`, `GET`, `DEL`, `PEXPIRE`, and `EVAL`/`EVALSHA` are available.

**Not Redis-compatible:** Amazon **CloudFront KeyValueStore** is a separate CloudFront edge KV API. Use [`@tslock/cloudfront-kvs`](../cloudfront-kvs/README.md) for that backend — do not point this provider at CloudFront KVS.

## Integration tests

Redis integration tests are opt-in and require a running Redis service:

```bash
TSLOCK_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6379 pnpm --filter @tslock/redis test:integration
```

## Exports

| Export | Description |
|---|---|
| `createNodeRedisLockProvider`, `NodeRedisLockProvider` | Factory + class. |
| `NodeRedisTemplate` | The `RedisTemplate` adapter (useful if you're building your own `InternalRedisLockProvider`). |

## Requirements

- Node.js >= 22
- Peer: `redis` (node-redis)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
