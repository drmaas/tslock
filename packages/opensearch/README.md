# @tslock/opensearch

> TSLock provider backed by [OpenSearch](https://opensearch.org/).

A [TSLock](../../README.md) provider that implements `LockProvider` directly using a Painless-style script + upsert with `refresh` for immediate visibility. This is the OpenSearch counterpart to [`@tslock/elasticsearch`](../elasticsearch/README.md); the two share the same algorithm and differ only in the client library.

## Installation

```bash
pnpm add @tslock/core @tslock/opensearch @opensearch-project/opensearch
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { OpenSearchLockProvider } from '@tslock/opensearch';
import { Client } from '@opensearch-project/opensearch';

const client = new Client({ node: 'http://localhost:9200' });

const provider = new OpenSearchLockProvider(client);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new OpenSearchLockProvider(client, options?)` accepts:

| Option | Default | Description |
|---|---|---|
| `index` | `'shedlock'` | The OpenSearch index used for lock documents. |
| `fieldNames` | see below | Override any of `name`, `lockUntil`, `lockedAt`, `lockedBy`. |

Default field names: `name`, `lockUntil`, `lockedAt`, `lockedBy` (via `FieldNames.DEFAULT`).

## Requirements

- Node.js >= 22
- Peer: `@opensearch-project/opensearch`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
