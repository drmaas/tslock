# @tslock/hazelcast

> TSLock provider backed by [Hazelcast](https://hazelcast.com/).

A [TSLock](../../README.md) provider that uses a Hazelcast `IMap` to store lock records. It takes Hazelcast's entry-level lock on the map key, does a get-check-put under that lock, and releases the entry lock — so the lock record update is mutually exclusive across the cluster. A TTL on the entry-level lock is a safety net in case a holder crashes mid-update.

## Installation

```bash
pnpm add @tslock/core @tslock/hazelcast hazelcast-client
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { HazelcastLockProvider } from '@tslock/hazelcast';
import { Client } from 'hazelcast-client';

const client = await Client.newHazelcastClient();

const provider = new HazelcastLockProvider(client);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new HazelcastLockProvider(client, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `lockStoreKey` | `'shedlock_storage'` | The name of the Hazelcast `IMap` holding lock records. |
| `lockLeaseTimeMs` | `30000` | TTL (ms) Hazelcast applies to the entry-level lock during `unlock()`. |

## Requirements

- Node.js >= 22
- Peer: `hazelcast-client`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
