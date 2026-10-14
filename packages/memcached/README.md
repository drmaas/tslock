# @tslock/memcached

> TSLock provider backed by [Memcached](https://memcached.org/) via `memjs`.

A [TSLock](../../README.md) provider that implements `LockProvider` directly. Lock acquisition uses the memcached `add` command, which fails atomically if the key already exists. Unlock reads the key and, only when the stored bytes equal the value written at acquisition, deletes it or replaces it with a shorter TTL when `lockAtLeastFor > 0`.

> **Caveat:** Memcached can evict keys early under memory pressure. Use a dedicated memcached instance (or a different provider) for critical locks. See [failure modes](../../docs/failure-modes.md#3-memcached-early-eviction).

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
> Unlock compares the stored bytes with the acquisition value (`ADDED:<iso>@<host>`) before `delete` or `replace`. memjs 1.3 has no compare-and-swap on `get`, `delete`, or `replace`, so another client can still change the key between that read and the following write. TTLs use the shared `floor(milliseconds / 1000) + 1` safety buffer.

## Integration tests

The shared lock and fuzz contracts run against an ephemeral `memcached:alpine` container:

```bash
pnpm --filter @tslock/memcached test:integration
```

Docker is required for this suite.

## Requirements

- Node.js >= 22
- Peer: `memjs`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
