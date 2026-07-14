# @tslock/redis-ioredis

> TSLock Redis provider using the [`ioredis`](https://github.com/luin/ioredis) client.

A [TSLock](../../README.md) provider that acquires locks with `SET key NX PX <ttl>` and releases/extends them with Lua scripts that check the lock value before mutating. This is the ioredis counterpart to [`@tslock/redis`](../redis/README.md); both share the locking logic in [`@tslock/redis-core`](../redis-core/README.md) and differ only in the client adapter.

## Installation

```bash
pnpm add @tslock/core @tslock/redis-ioredis ioredis
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createIoRedisLockProvider } from '@tslock/redis-ioredis';
import { Redis } from 'ioredis';

const redisClient = new Redis('redis://localhost:6379');

const provider = createIoRedisLockProvider(redisClient);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createIoRedisLockProvider(client, config?)` accepts an optional config:

| Option | Default | Description |
|---|---|---|
| `keyPrefix` | `'job-lock'` | Redis key namespace. |
| `env` | `'default'` | Environment segment of the key (enables multi-tenancy). |
| `safeUpdate` | `true` | When `true`, unlock/extend use a Lua script that verifies the lock value first. Set `false` for plain `DEL`/`SET XX`. |

The full key is `${keyPrefix}:${env}:${lockName}`.

## Exports

| Export | Description |
|---|---|
| `createIoRedisLockProvider`, `IoRedisLockProvider` | Factory + class. |
| `IoRedisTemplate` | The `RedisTemplate` adapter for ioredis. |

## Requirements

- Node.js >= 22
- Peer: `ioredis`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
