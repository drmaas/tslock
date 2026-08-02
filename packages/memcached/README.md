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

> **Lock-name safety:** Lock names must be non-empty, contain no control characters, and be at most 1024 UTF-8 bytes.
>
> Memcached ownership values intentionally contain the timestamp and hostname only. Memcached unlock operations do not compare an ownership token; the value is retained only when `lockAtLeastFor` requires a delayed release. TTLs use the shared `floor(milliseconds / 1000) + 1` safety buffer.

## Requirements

- Node.js >= 22
- Peer: `memjs`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
