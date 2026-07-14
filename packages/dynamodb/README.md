# @tslock/dynamodb

> TSLock provider backed by Amazon [DynamoDB](https://aws.amazon.com/dynamodb/).

A [TSLock](../../README.md) provider that implements `LockProvider` directly using `UpdateItem` with a `ConditionExpression`. The condition asserts the record is absent or expired, so acquisition is atomic in a single round-trip.

## Installation

```bash
pnpm add @tslock/core @tslock/dynamodb @aws-sdk/client-dynamodb
```

## Setup

Create a table with a simple primary key (or use an existing one):

```bash
aws dynamodb create-table \
  --table-name shedlock \
  --attribute-definitions AttributeName=_id,AttributeType=S \
  --key-schema AttributeName=_id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { DynamoDBLockProvider } from '@tslock/dynamodb';

const provider = new DynamoDBLockProvider({ tableName: 'shedlock' });
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`new DynamoDBLockProvider(options)` accepts:

| Option | Default | Description |
|---|---|---|
| `tableName` | — (required) | The DynamoDB table name. |
| `client` | `new DynamoDBClient({})` | A `DynamoDBClient` instance (override for custom region/credentials). |
| `partitionKey` | `'_id'` | The partition key attribute name. |
| `sortKey` | `undefined` | `{ name, value }` if your table uses a composite key. |

## Requirements

- Node.js >= 22
- Peer: `@aws-sdk/client-dynamodb`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
