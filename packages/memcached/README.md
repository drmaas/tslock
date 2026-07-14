# @tslock/memcached

> TSLock provider backed by [Memcached](https://memcached.org/) via `memjs`.

A [TSLock](../../README.md) provider that implements `LockProvider` directly. Lock acquisition uses the memcached `add` command, which fails atomically if the key already exists. Unlock is a `delete` (or a `replace` with a shorter TTL when `lockAtLeastFor > 0`, so the key lingers briefly to prevent immediate re-acquisition from clock drift).

> **Caveat:** Memcached can evict keys early under memory pressure. Use a dedicated memcached instance (or a different provider) for critical locks.

## Installation

```bash
pnpm add @tslock/core @tslock/memcached memjs
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createMemcachedLockProvider } from '@tslock/memcached';

const provider = createMemcachedLockProvider({ servers: 'localhost:11211' });
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createMemcachedLockProvider(options)` accepts:

| Option | Default | Description |
|---|---|---|
| `servers` | — (required) | Comma-separated memcached server addresses (e.g. `'host:port,host:port'`). |
| `env` | `'default'` | Namespace segment of the key. |
| `clientOptions` | `undefined` | Extra `memjs.Client.create()` options. |

The full key is `shedlock:${env}:${lockName}`.

## Requirements

- Node.js >= 22
- Peer: `memjs`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
