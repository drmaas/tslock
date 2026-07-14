# @tslock/datastore

> TSLock provider backed by Google Cloud [Datastore](https://cloud.google.com/datastore).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` over Datastore transactions. This is a faithful port of ShedLock's `DatastoreLockProvider`.

## Installation

```bash
pnpm add @tslock/core @tslock/datastore @google-cloud/datastore
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createDatastoreProvider } from '@tslock/datastore';
import { Datastore } from '@google-cloud/datastore';

const datastore = new Datastore({ projectId: process.env.GCP_PROJECT_ID });

const provider = createDatastoreProvider({ datastore });
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createDatastoreProvider(config)` accepts:

| Option | Default | Description |
|---|---|---|
| `datastore` | — (required) | A `Datastore` instance. |
| `entityName` | `'shedlock'` | The kind used for lock entities. |
| `fieldNames` | see below | Override any of `lockUntil`, `lockedAt`, `lockedBy`. |
| `lockedByValue` | `os.hostname()` | Identifier written to `lockedBy`. |
| `useDate` | `false` | Store the time fields as `Date` values instead of strings. |

Default field names: `lockUntil`, `lockedAt`, `lockedBy`. The entity key is the lock name.

## Requirements

- Node.js >= 22
- Peer: `@google-cloud/datastore`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
