# @tslock/elasticsearch

> TSLock provider backed by [Elasticsearch](https://www.elastic.co/elasticsearch/).

A [TSLock](../../README.md) provider that implements `LockProvider` directly using a Painless script + upsert with `refresh` for immediate visibility. This is a faithful port of ShedLock's `ElasticsearchLockProvider`.

## Installation

```bash
pnpm add @tslock/core @tslock/elasticsearch @elastic/elasticsearch
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { ElasticsearchLockProvider } from '@tslock/elasticsearch';
import { Client } from '@elastic/elasticsearch';

const client = new Client({ node: 'http://localhost:9200' });

const provider = new ElasticsearchLockProvider(client);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new ElasticsearchLockProvider(client, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `index` | `'shedlock'` | The Elasticsearch index used for lock documents. |
| `fieldNames` | see below | Override any of `name`, `lockUntil`, `lockedAt`, `lockedBy`. |

Default field names: `name`, `lockUntil`, `lockedAt`, `lockedBy` (via `FieldNames.DEFAULT`).

## Requirements

- Node.js >= 22
- Peer: `@elastic/elasticsearch`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
