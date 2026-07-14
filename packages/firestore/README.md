# @tslock/firestore

> TSLock provider backed by Google Cloud [Firestore](https://cloud.google.com/firestore).

A [TSLock](../../README.md) provider that uses the `StorageBasedLockProvider` pattern with a `StorageAccessor` over a Firestore collection. First-time locks are created with a `doc.create()` (fails on exists); updates re-use the document.

## Installation

```bash
pnpm add @tslock/core @tslock/firestore @google-cloud/firestore
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createFirestoreProvider } from '@tslock/firestore';
import { Firestore } from '@google-cloud/firestore';

const firestore = new Firestore({ projectId: process.env.GCP_PROJECT_ID });

const provider = createFirestoreProvider({ firestore });
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createFirestoreProvider(config)` accepts:

| Option | Default | Description |
|---|---|---|
| `firestore` | — (required) | A `Firestore` instance. |
| `collectionName` | `'shedlock'` | The collection holding lock documents. |
| `fieldNames` | see below | Override any of `lockUntil`, `lockedAt`, `lockedBy`. |
| `lockedByValue` | `os.hostname()` | Identifier written to `lockedBy`. |
| `useTimestamps` | `false` | Store the time fields as Firestore `Timestamp` values instead of strings. |

Default field names: `lockUntil`, `lockedAt`, `lockedBy`. The document ID is the lock name.

## Requirements

- Node.js >= 22
- Peer: `@google-cloud/firestore`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
