# @tslock/arangodb

> TSLock provider backed by [ArangoDB](https://www.arangodb.com/).

A [TSLock](../../README.md) provider that implements `LockProvider` directly over the `arangojs` client. Locks are stored as documents in a collection and updated with optimistic concurrency via `_rev`.

## Installation

```bash
pnpm add @tslock/core @tslock/arangodb arangojs
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createArangoDbLockProvider } from '@tslock/arangodb';
import { Database } from 'arangojs';

const db = new Database({ url: 'http://localhost:8529', auth: { username: 'root', password: '' } });

const provider = createArangoDbLockProvider(db);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createArangoDbLockProvider(database, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `collection` | `'shedLock'` | The ArangoDB collection used for lock documents. |

## Requirements

- Node.js >= 22
- Peer: `arangojs`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
