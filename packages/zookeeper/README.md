# @tslock/zookeeper

> TSLock provider backed by Apache [ZooKeeper](https://zookeeper.apache.org/).

A [TSLock](../../README.md) provider that uses PERSISTENT znodes (not ephemeral — locks are time-based, not session-based). Each lock is a znode whose data is the ISO-8601 string of `lockAtMostUntil`. Acquisition uses optimistic concurrency: `setData` with the znode's current `version` (CAS) on an existing znode, or `create` on a missing znode. A `BadVersionException` or `NodeExistsException` means another instance won concurrently.

This is a faithful port of ShedLock's `ZooKeeperLockProvider`.

## Installation

```bash
pnpm add @tslock/core @tslock/zookeeper zookeeper
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createZooKeeperLockProvider } from '@tslock/zookeeper';
import * as zookeeper from 'zookeeper';

// Connect per your `zookeeper` client's API, then pass the connected client in.
const client = zookeeper.createClient('localhost:2181', { retries: 2 });
client.connect();
await new Promise<void>((resolve) => client.on('connect', () => resolve()));

const provider = createZooKeeperLockProvider(client);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createZooKeeperLockProvider(client, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `basePath` | `'/shedlock'` | The parent znode under which one znode per lock name is created. Created on first use if it doesn't exist. |

The znode for a lock is `${basePath}/${lockName}`.

## Requirements

- Node.js >= 22
- Peer: `zookeeper` (node-zookeeper / `zk`)

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
