# @tslock/s3

> TSLock provider backed by Amazon [S3](https://aws.amazon.com/s3/).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` over the S3 client. First-time locks are created with `PutObject` + `IfNoneMatch: "*"` (fails if the object exists); updates use conditional `PutObject` with generation matching. Each lock is a small object under a configurable prefix.

## Installation

```bash
pnpm add @tslock/core @tslock/s3 @aws-sdk/client-s3
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { S3LockProvider, createS3ProviderConfig } from '@tslock/s3';
import { S3Client } from '@aws-sdk/client-s3';

const s3 = new S3Client({});
const config = createS3ProviderConfig({ bucket: 'my-shedlock-bucket' });

const provider = new S3LockProvider(s3, config);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createS3ProviderConfig({ bucket, objectPrefix? })` accepts:

| Option | Default | Description |
|---|---|---|
| `bucket` | — (required) | The S3 bucket to store lock objects in. |
| `objectPrefix` | `'shedlock/'` | Prefix applied to every lock object key. |

The object key for a lock is `${objectPrefix}${lockName}`.

## Requirements

- Node.js >= 22
- Peer: `@aws-sdk/client-s3`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
