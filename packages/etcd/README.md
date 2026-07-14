# @tslock/etcd

> TSLock provider backed by [etcd](https://etcd.io/) v3.

A [TSLock](../../README.md) provider that implements `LockProvider` directly over the official `etcd3` client. Each lock is a KV entry whose key is `shedlock:${env}:${lockName}` and whose value is `ADDED:${isoNow}@${hostname}`. Locks are acquired with a transaction that asserts `key.version == 0` (key does not exist) and, on success, puts the value with a lease whose TTL is `ceil(lockAtMostFor / 1000)` seconds. Unlock revokes the lease.

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

## Requirements

- Node.js >= 22
- Peer: `etcd3`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
