# @tslock/nats

> TSLock provider backed by [NATS](https://nats.io/) JetStream's Key-Value store.

A [TSLock](../../README.md) provider that implements `LockProvider` directly using a JetStream KV bucket. Acquisition uses `kv.create(name, value)` (fails if the key exists) for first-time locks and `kv.update(name, value, revision)` (fails on revision mismatch) to take over an expired lock. The lock value is an 8-byte big-endian long encoding the `lockUntil` epoch millis.

## Installation

```bash
pnpm add @tslock/core @tslock/nats nats
```

## Usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createNatsLockProvider } from '@tslock/nats';

const provider = await createNatsLockProvider({ servers: 'localhost:4222' });
const executor = new DefaultLockingTaskExecutor(provider);

await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Configuration

`createNatsLockProvider(options)` is async and accepts:

| Option | Default | Description |
|---|---|---|
| `servers` | — (required) | Comma-separated NATS server URLs. |
| `bucketName` | `'shedlock-locks'` | The JetStream KV bucket name. |
| `storage` | `StorageType.Memory` | KV bucket storage type (`Memory` or `File`). |
| `connectionOptions` | `undefined` | Extra `nats.connect()` options. |

## Requirements

- Node.js >= 22
- Peer: `nats`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
