# TSLock

> Distributed locks for scheduled tasks in TypeScript — a port of [ShedLock](https://github.com/lukas-krecan/ShedLock).

TSLock ensures that a scheduled task executes on **at most one** instance at a time across multiple Node.js processes. When a task's lock is held by another instance, the task **skips** (does not queue, does not wait).

## Why?

When you run multiple instances of a Node.js/TypeScript application — in Kubernetes, ECS, Lambda, or behind a load balancer — scheduled tasks fire on **every** instance simultaneously. TSLock prevents duplicate work, data corruption, and wasted resources by coordinating execution via a shared storage backend.

## Key properties

| Property | Description |
|---|---|
| **At-most-once execution** | If the lock is held, the task is skipped entirely. |
| **Time-based locks** | Locks expire after `lockAtMostFor` — no orphaned locks if a node crashes. |
| **Minimum hold time** | `lockAtLeastFor` prevents re-execution from clock drift on short tasks. |
| **Non-blocking** | Lock acquisition is a check-and-skip, never a wait. |
| **Assumes synchronized clocks** | Lock validity depends on wall-clock time; nodes must have NTP-synced clocks. |

## What TSLock is NOT

- **Not a scheduler.** Pair it with `node-cron`, `bree`, Agenda, EventBridge Scheduler, or your own `setInterval`.
- **Not a queue.** Skipped tasks are not retried or deferred.
- **Not a distributed transaction coordinator.** It is a simple time-based lock.

## Quick start

```bash
pnpm add @tslock/core @tslock/redis ioredis
```

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createRedisLockProvider } from '@tslock/redis';
import { createClient } from 'redis';

const redisClient = createClient({ url: 'redis://localhost:6379' });
await redisClient.connect();

const provider = createRedisLockProvider(redisClient);
const executor = new DefaultLockingTaskExecutor(provider);

// Wrap your scheduled task:
await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig({ name: 'my-task', lockAtMostFor: '5m', lockAtLeastFor: '1m' }),
);
```

## Duration formats

`lockAtMostFor` and `lockAtLeastFor` accept:

| Format | Example | Meaning |
|---|---|---|
| Human string | `'5m'`, `'30s'`, `'1h'`, `'1d'` | 5 minutes, 30 seconds, 1 hour, 1 day |
| Milliseconds (number) | `30000` | 30 seconds |
| Duration object | `{ minutes: 5 }` | 5 minutes |

## Provider matrix

TSLock supports 23 providers for v1 (Ignite deferred). Each uses the canonical TS/JS driver.

### SQL (3 packages + shared infrastructure)

| Package | Driver | Mechanism |
|---|---|---|
| `@tslock/sql` | `pg` / `mysql2` / `mssql` | Raw driver adapters |
| `@tslock/kysely` | `kysely` | Type-safe query builder |
| `@tslock/drizzle` | `drizzle-orm` | TS-native ORM |
| `@tslock/sql-support` | — | Shared SQL infra (`DatabaseProduct`, `SqlConfiguration`) |

### Storage-based (8 — insert-or-update pattern)

| Package | Driver |
|---|---|
| `@tslock/neo4j` | `neo4j-driver` |
| `@tslock/couchbase` | `couchbase` |
| `@tslock/spanner` | `@google-cloud/spanner` |
| `@tslock/firestore` | `@google-cloud/firestore` |
| `@tslock/datastore` | `@google-cloud/datastore` |
| `@tslock/s3` | `@aws-sdk/client-s3` |
| `@tslock/gcs` | `@google-cloud/storage` |
| `@tslock/cassandra` | `cassandra-driver` |

### Direct (5)

| Package | Driver |
|---|---|
| `@tslock/mongo` | `mongodb` |
| `@tslock/dynamodb` | `@aws-sdk/client-dynamodb` |
| `@tslock/elasticsearch` | `@elastic/elasticsearch` |
| `@tslock/opensearch` | `@opensearch-project/opensearch` |
| `@tslock/arangodb` | `arangojs` |

### Redis (2 packages + shared core)

| Package | Driver |
|---|---|
| `@tslock/redis` | `redis` (node-redis, official) |
| `@tslock/redis-ioredis` | `ioredis` |
| `@tslock/redis-core` | — (shared `InternalRedisLockProvider`) |

### Specialized (5)

| Package | Driver |
|---|---|
| `@tslock/hazelcast` | `hazelcast-client` |
| `@tslock/zookeeper` | `zk` (node-zookeeper) |
| `@tslock/etcd` | `etcd3` |
| `@tslock/memcached` | `memjs` |
| `@tslock/nats` | `nats` (JetStream KV) |

### In-memory (1)

| Package | Use case |
|---|---|
| `@tslock/in-memory` | Testing and local development only — **not** for production distributed locking. |

## Core abstractions

| Abstraction | Description |
|---|---|
| `LockProvider` | `lock(config) → Promise<SimpleLock \| undefined>` — returns `undefined` if lock not acquired. |
| `SimpleLock` | `unlock()` / `extend(lockAtMostFor, lockAtLeastFor)` — one-shot, single-use. |
| `LockConfiguration` | Immutable: `name`, `lockAtMostFor`, `lockAtLeastFor`, `createdAt`. |
| `LockingTaskExecutor` | Wraps a task in lock acquire/release. Emits listener events. |
| `LockAssert` | Assert code runs within a lock context (via `AsyncLocalStorage`). |
| `LockExtender` | Manually extend the active lock from within the task. |
| `KeepAliveLockProvider` | Wraps an `ExtensibleLockProvider` + scheduler, auto-renews every `lockAtMostFor/2`. |
| `TrackingLockProviderWrapper` | Introspect active locks. |

## Lock extension

Some providers support `extend()` (they implement `ExtensibleLockProvider`). Use `LockExtender.extendActiveLock()` from within a task to manually extend:

```typescript
import { LockExtender } from '@tslock/core';

await executor.executeWithLock(
  async () => {
    // ... long-running work ...
    await LockExtender.extendActiveLock('10m', 0); // extend by 10 minutes
    // ... continue work ...
  },
  createLockConfig({ name: 'long-task', lockAtMostFor: '5m' }),
);
```

`KeepAliveLockProvider` automates this — it wraps an extensible provider and renews the lock periodically:

```typescript
import { KeepAliveLockProvider } from '@tslock/core';
const provider = new KeepAliveLockProvider(extensibleProvider);
```

## Multi-tenancy

Wrap a `LockProvider` with a tenant-keyed map:

```typescript
const providers = new Map<string, LockProvider>();
function getProvider(tenant: string): LockProvider {
  let p = providers.get(tenant);
  if (!p) { p = createRedisLockProvider(redisClient, { env: tenant }); providers.set(tenant, p); }
  return p;
}
```

## Caveats

- **Set `lockAtMostFor` generously** — it's the safety net if a node crashes. If a task runs longer than `lockAtMostFor`, it may execute twice.
- **Set `lockAtLeastFor` for short tasks** — prevents re-execution from clock drift.
- **Do not manually delete lock rows/documents** — the in-memory `LockRecordRegistry` cache means a deleted row won't be recreated until process restart.
- **Clocks must be synchronized** (NTP) — lock validity depends on wall-clock time.
- **Memcached can evict locks early** if the cache is full — use a dedicated memcached instance or a different provider for critical locks.

## Documentation

All design docs are in [`docs/`](./docs):

| Doc | Content |
|---|---|
| [`docs/00-vision.md`](./docs/00-vision.md) | Product vision, scope, provider matrix, design decisions |
| [`docs/01-architecture.md`](./docs/01-architecture.md) | Monorepo structure, core abstractions, provider categories, test architecture |
| [`docs/specs/`](./docs/specs/) | Per-provider specifications (23 specs) |
| [`docs/plans/`](./docs/plans/) | Per-provider implementation plans (23 plans) |
| [`docs/reviews/`](./docs/reviews/) | Independent reviews of each spec/plan combo (23 reviews) |

## Project status

**Docs-only phase.** All vision, architecture, specs, plans, and reviews are complete. No code has been written yet. Implementation will follow the plans in `docs/plans/`.

## Tech stack

| Aspect | Choice |
|---|---|
| Language | TypeScript 5.x |
| Module format | Dual ESM + CJS (tsup) |
| Node.js | >= 20 |
| Monorepo | pnpm workspaces |
| Test framework | Vitest |
| Integration tests | LocalStack + emulators + testcontainers |
| Package scope | `@tslock/*` |
| License | Apache 2.0 |

## License

Apache 2.0, matching [ShedLock](https://github.com/lukas-krecan/ShedLock).
