# @tslock/etcd

> TSLock provider backed by [etcd](https://etcd.io/) v3.

A [TSLock](../../README.md) provider that implements `LockProvider` directly over the official `etcd3` client. Each lock is a KV entry whose key is `shedlock:${env}:${lockName}` and whose value is `ADDED:${isoNow}@${hostname}`. Locks are acquired with a transaction that asserts `key.version == 0` (key does not exist) and, on success, puts the value with a lease whose TTL uses the shared `floor(milliseconds / 1000) + 1` safety buffer. Unlock revokes the lease.

## Installation

```bash
pnpm add @tslock/core @tslock/etcd etcd3
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { EtcdLockProvider } from '@tslock/etcd';
import { Etcd3 } from 'etcd3';

const client = new Etcd3({ hosts: 'localhost:2379' });

const provider = new EtcdLockProvider(client);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new EtcdLockProvider(client, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `env` | `'default'` | Namespace segment of the key (enables multi-tenancy). |

The full key is `shedlock:${env}:${lockName}`.

> **Lock-name safety:** Lock names must be non-empty, contain no control characters, and be at most 1024 UTF-8 bytes.
>
> Etcd ownership values intentionally contain the timestamp and hostname only. Etcd unlock revokes the lease rather than comparing an ownership token, so a crypto-random value is not used. TTLs use the shared `floor(milliseconds / 1000) + 1` safety buffer.

## Integration tests

The shared lock and fuzz contracts run against an ephemeral etcd v3.5 container:

```bash
pnpm --filter @tslock/etcd test:integration
```

Docker is required for this suite.

## Requirements

- Node.js >= 22
- Peer: `etcd3`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
