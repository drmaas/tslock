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
