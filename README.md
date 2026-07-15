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
pnpm add @tslock/core @tslock/redis redis
```

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createNodeRedisLockProvider } from '@tslock/redis';
import { createClient } from 'redis';

const redisClient = createClient({ url: 'redis://localhost:6379' });
await redisClient.connect();

const provider = createNodeRedisLockProvider(redisClient);
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

## Packages

TSLock is a pnpm-workspaces monorepo. Install the core plus one or more providers. Each provider's README has setup steps, configuration options, and a copy-pasteable example.

### Core & infra

| Package | Description | README |
|---|---|---|
| `@tslock/core` | Lock model, executor, `LockAssert`, `LockExtender`, `KeepAliveLockProvider`. Zero runtime deps. | [README](./packages/core/README.md) |
| `@tslock/sql-support` | Shared SQL infra (`DatabaseProduct`, `SqlConfiguration`, statements). | [README](./packages/sql-support/README.md) |
| `@tslock/redis-core` | Shared Redis locking logic (`InternalRedisLockProvider`, Lua scripts). | [README](./packages/redis-core/README.md) |
| `@tslock/test-support` | Shared integration test contracts + fuzz tests (dev-only). | [README](./packages/test-support/README.md) |
| `@tslock/in-memory` | In-memory provider — testing/local only, **not** for production. | [README](./packages/in-memory/README.md) |

### SQL providers

| Package | Driver | README |
|---|---|---|
| `@tslock/sql` | `pg` / `mysql2` / `mssql` | [README](./packages/sql/README.md) |
| `@tslock/kysely` | `kysely` | [README](./packages/kysely/README.md) |
| `@tslock/drizzle` | `drizzle-orm` | [README](./packages/drizzle/README.md) |

### Storage-based providers

| Package | Driver | README |
|---|---|---|
| `@tslock/neo4j` | `neo4j-driver` | [README](./packages/neo4j/README.md) |
| `@tslock/couchbase` | `couchbase` | [README](./packages/couchbase/README.md) |
| `@tslock/spanner` | `@google-cloud/spanner` | [README](./packages/spanner/README.md) |
| `@tslock/firestore` | `@google-cloud/firestore` | [README](./packages/firestore/README.md) |
| `@tslock/datastore` | `@google-cloud/datastore` | [README](./packages/datastore/README.md) |
| `@tslock/s3` | `@aws-sdk/client-s3` | [README](./packages/s3/README.md) |
| `@tslock/gcs` | `@google-cloud/storage` | [README](./packages/gcs/README.md) |
| `@tslock/cassandra` | `cassandra-driver` | [README](./packages/cassandra/README.md) |

### Direct providers

| Package | Driver | README |
|---|---|---|
| `@tslock/mongo` | `mongodb` | [README](./packages/mongo/README.md) |
| `@tslock/dynamodb` | `@aws-sdk/client-dynamodb` | [README](./packages/dynamodb/README.md) |
| `@tslock/elasticsearch` | `@elastic/elasticsearch` | [README](./packages/elasticsearch/README.md) |
| `@tslock/opensearch` | `@opensearch-project/opensearch` | [README](./packages/opensearch/README.md) |
| `@tslock/arangodb` | `arangojs` | [README](./packages/arangodb/README.md) |

### Redis providers

| Package | Driver | README |
|---|---|---|
| `@tslock/redis` | `redis` (node-redis, official) | [README](./packages/redis/README.md) |
| `@tslock/redis-ioredis` | `ioredis` | [README](./packages/redis-ioredis/README.md) |

### Specialized providers

| Package | Driver | README |
|---|---|---|
| `@tslock/hazelcast` | `hazelcast-client` | [README](./packages/hazelcast/README.md) |
| `@tslock/zookeeper` | `zookeeper` (node-zookeeper) | [README](./packages/zookeeper/README.md) |
| `@tslock/etcd` | `etcd3` | [README](./packages/etcd/README.md) |
| `@tslock/memcached` | `memjs` | [README](./packages/memcached/README.md) |
| `@tslock/nats` | `nats` (JetStream KV) | [README](./packages/nats/README.md) |

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
  if (!p) { p = createNodeRedisLockProvider(redisClient, { env: tenant }); providers.set(tenant, p); }
  return p;
}
```

## Caveats

- **Set `lockAtMostFor` generously** — it's the safety net if a node crashes. If a task runs longer than `lockAtMostFor`, it may execute twice.
- **Set `lockAtLeastFor` for short tasks** — prevents re-execution from clock drift.
- **Do not manually delete lock rows/documents** — the in-memory `LockRecordRegistry` cache means a deleted row won't be recreated until process restart.
- **Clocks must be synchronized** (NTP) — lock validity depends on wall-clock time.
- **Memcached can evict locks early** if the cache is full — use a dedicated memcached instance or a different provider for critical locks.

## Local development

Contributions are welcome — see [`CONTRIBUTING.md`](./CONTRIBUTING.md) for the full guide. The short version:

### Prerequisites

- **Node.js >= 22** (check with `node -v`; manage versions with [fnm](https://github.com/Schniz/fnm) or [nvm](https://github.com/nvm-sh/nvm) — the repo pins `22.x` in [`.nvmrc`](./.nvmrc))
- **pnpm 11+** (enable via corepack: `corepack enable`)
- **Docker** (only for integration tests, which use testcontainers / emulators)

### Clone & install

```bash
git clone https://github.com/drmaas/tslock.git
cd tslock
corepack enable
pnpm install
```

### Common commands

```bash
pnpm -r typecheck       # tsc --noEmit across all packages
pnpm -r test            # vitest run (unit tests) across all packages
pnpm -r test:integration # integration tests (requires Docker / emulators)
pnpm -r build           # tsup build across all packages
pnpm check              # combined format check + lint (Biome)
pnpm check:fix          # combined format + lint, applying safe fixes
pnpm format             # auto-format all files with Biome
pnpm lint               # lint with Biome
```

CI runs `pnpm check && pnpm typecheck && pnpm test && pnpm build` on every push.

### Adding a new provider

The repo follows a spec → plan → implement → verify → review workflow. See [`AGENTS.md`](./AGENTS.md) for the full process and `docs/plans/` for per-provider implementation plans. In short:

1. Read `docs/00-vision.md`, `docs/01-architecture.md`, and an existing provider's spec/plan/review as a template.
2. Create `docs/specs/<NN>-<name>.md` and `docs/plans/<NN>-<name>.md`.
3. Implement under `packages/<name>/` following the package conventions in `AGENTS.md`.
4. Add the shared integration test contract from `@tslock/test-support`.
5. Run the full verification suite above and fix any failures.

### Project layout

```
tslock/
├── packages/        # @tslock/* packages (core + 23 providers + infra)
├── docs/            # vision, architecture, per-provider specs/plans/reviews
├── .changeset/      # changesets config
├── .github/         # CI workflow
├── AGENTS.md        # instructions for AI agents + contributor conventions
└── README.md        # this file
```

## Documentation

All design docs are in [`docs/`](./docs):

| Doc | Content |
|---|---|
| [`docs/00-vision.md`](./docs/00-vision.md) | Product vision, scope, provider matrix, design decisions |
| [`docs/01-architecture.md`](./docs/01-architecture.md) | Monorepo structure, core abstractions, provider categories, test architecture |
| [`docs/specs/`](./docs/specs/) | Per-provider specifications |
| [`docs/plans/`](./docs/plans/) | Per-provider implementation plans |
| [`docs/reviews/`](./docs/reviews/) | Independent reviews of each spec/plan combo |

## Project status

All packages are implemented and verified. See `docs/` for design documentation.

## Publishing

Releases are performed locally (npm 2FA is interactive and cannot be automated via tokens). **Admin only.**

```bash
pnpm login                              # one-time — handles 2FA
pnpm changeset                          # describe changes, pick semver bump
pnpm version-packages                   # bump versions + update CHANGELOGs
git add -A && git commit -m "chore: release v<version>"
pnpm publish -r                         # publish all packages to npm
git tag v<version> && git push origin v<version>
```

All `@tslock/*` packages share a single version (lockstep via Changesets fixed mode).

## Tech stack

| Aspect | Choice |
|---|---|
| Language | TypeScript 5.x |
| Module format | Dual ESM + CJS (tsup) |
| Node.js | >= 22 |
| Monorepo | pnpm workspaces |
| Test framework | Vitest |
| Integration tests | LocalStack + emulators + testcontainers |
| Linting / formatting | Biome |
| Package scope | `@tslock/*` |
| License | Apache 2.0 |

## Contributing

See [`CONTRIBUTING.md`](./CONTRIBUTING.md). By participating you agree to abide by its guidelines.

## License

Apache 2.0, matching [ShedLock](https://github.com/lukas-krecan/ShedLock). See [LICENSE](./LICENSE) for details.
