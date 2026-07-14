# @tslock/gcs

> TSLock provider backed by Google Cloud [Storage](https://cloud.google.com/storage).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` over the GCS client. First-time locks are created with `create` + `doesNotExist` precondition; updates use `save` + `generationMatch` for optimistic concurrency.

## Installation

```bash
pnpm add @tslock/core @tslock/gcs @google-cloud/storage
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { GcsLockProvider, createGcsProviderConfig } from '@tslock/gcs';
import { Storage } from '@google-cloud/storage';

const storage = new Storage();
const config = createGcsProviderConfig({ bucket: 'my-shedlock-bucket' });

const provider = new GcsLockProvider(storage, config);
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createGcsProviderConfig({ bucket, objectPrefix?, lockedBy? })` accepts:

| Option | Default | Description |
|---|---|---|
| `bucket` | — (required) | The GCS bucket to store lock objects in. |
| `objectPrefix` | `'shedlock/'` | Prefix applied to every lock object key. |
| `lockedBy` | `os.hostname()` | Identifier written to the lock object. |

The object key for a lock is `${objectPrefix}${lockName}`.

## Requirements

- Node.js >= 22
- Peer: `@google-cloud/storage`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
