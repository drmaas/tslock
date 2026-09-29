# @tslock/cloudfront-kvs

> TSLock provider backed by Amazon [CloudFront KeyValueStore](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/kvs-with-functions.html).

**Not Redis-compatible.** CloudFront KeyValueStore is a separate CloudFront edge KV API (`GetKey` / `PutKey` / store-wide ETag). For Valkey, ElastiCache Redis/Valkey, or MemoryDB, use [`@tslock/redis`](../redis/README.md) or [`@tslock/redis-ioredis`](../redis-ioredis/README.md) instead.

Locks are JSON values written through the **control-plane** KeyValueStore API (`@aws-sdk/client-cloudfront-keyvaluestore`). CloudFront Functions can **read** the same store at the edge but cannot write. Writes use optimistic concurrency with the **store-wide** ETag from KeyValueStore `DescribeKeyValueStore`.

## Installation

```bash
pnpm add @tslock/core @tslock/cloudfront-kvs @aws-sdk/client-cloudfront-keyvaluestore
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createCloudFrontKvsLockProvider } from '@tslock/cloudfront-kvs';
import { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';

const client = new CloudFrontKeyValueStoreClient({ region: 'us-east-1' });
const provider = createCloudFrontKvsLockProvider({
  client,
  kvsArn: 'arn:aws:cloudfront::123456789012:key-value-store/…',
});
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig('my-task', '5m', '1m'),
);
```

Configure the client for SigV4A as required by the CloudFront KeyValueStore API.

## Configuration

| Option | Default | Description |
|---|---|---|
| `client` | — (required) | `CloudFrontKeyValueStoreClient` owned by the caller. |
| `kvsArn` | — (required) | KeyValueStore ARN. |
| `keyPrefix` | `'tslock/'` | Prefix applied to every lock key. |
| `maxEtagRetries` | `3` | Retries when another writer changes the store ETag. |

## Edge limits

| Limit | Value |
|---|---|
| Max store size | 5 MB |
| Max key size | 512 bytes |
| Max value size | 1 KB |
| Batch `UpdateKeys` | 50 keys or 3 MB |
| Functions | Read-only |
| This provider | Control-plane reads/writes |

Store-wide ETag means concurrent updates to **different** keys can still conflict. Prefer low-frequency scheduled locks; use separate stores if you need higher write parallelism. Function readers may lag control-plane publishes — do not assume immediate edge visibility.

## Integration tests

Opt-in (requires AWS credentials and a real KeyValueStore):

```bash
TSLOCK_CLOUDFRONT_KVS_INTEGRATION=1 CLOUDFRONT_KVS_ARN=arn:aws:cloudfront::…:key-value-store/… \
  pnpm --filter @tslock/cloudfront-kvs test:integration
```

## Exports

| Export | Description |
|---|---|
| `createCloudFrontKvsLockProvider`, `CloudFrontKvsLockProvider` | Factory + class |
| `resolveCloudFrontKvsConfiguration` | Config resolver |
| `CloudFrontKvsLock` | `SimpleLock` implementation |

## Requirements

- Node.js >= 22
- Peers: `@tslock/core`, `@aws-sdk/client-cloudfront-keyvaluestore`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
