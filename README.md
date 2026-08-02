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

## Lock names

Lock names must be non-empty, contain no control characters, and be at most 1024 UTF-8 bytes. This shared limit keeps names safe across Redis keys, object keys, document IDs, znode paths, and other provider backends.

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

### Middleware integrations

| Package | Framework | Spec |
|---|---|---|
| `@tslock/middleware-core` | Shared middleware lifecycle and configuration | [README](./packages/middleware-core/README.md) |
| `@tslock/express` | Express 4.x / 5.x | [docs/specs/24-middleware.md](./docs/specs/24-middleware.md) |
| `@tslock/fastify` | Fastify 5.x | [docs/specs/24-middleware.md](./docs/specs/24-middleware.md) |
| `@tslock/koa` | Koa 2.x | [docs/specs/24-middleware.md](./docs/specs/24-middleware.md) |
| `@tslock/hono` | Hono 4.x | [docs/specs/24-middleware.md](./docs/specs/24-middleware.md) |

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

The workspace intentionally denies install scripts for the transitive `cpu-features` and `ssh2` packages used by testcontainers. Standard local Docker-socket integration tests do not require these optional native builds. Docker-over-SSH is not supported by the default policy; if you need it locally, change both entries to `true` in `pnpm-workspace.yaml`, reinstall, and ensure your machine has the required native build toolchain. Do not commit that local override unless the policy is intentionally changing.

### Common commands

```bash
pnpm -r typecheck       # tsc --noEmit across all packages
pnpm -r test            # vitest run (unit tests) across all packages
pnpm test:integration  # in-memory, MongoDB, and PostgreSQL integration suites
# requires Docker for MongoDB/PostgreSQL; Redis is opt-in when a Redis service is available:
TSLOCK_REDIS_INTEGRATION=1 REDIS_URL=redis://127.0.0.1:6379 pnpm test:integration
pnpm -r build           # tsup build across all packages
pnpm check              # combined format check + lint (Biome)
pnpm check:fix          # combined format + lint, applying safe fixes
pnpm format             # auto-format all files with Biome
pnpm lint               # lint with Biome
pnpm bench              # build packages and measure lock/executor overhead
pnpm check:packed-peers # verify packed peer ranges contain no workspace:* values
```

CI runs `pnpm check && pnpm typecheck && pnpm test && pnpm build` on every push.

### Contribution workflow skills

When using an agent, choose the repository-local skill that matches the primary change:

| Contribution | Skill | Use it for | Not for |
|---|---|---|---|
| Bug fix | [`tslock-bugfix`](./.opencode/skills/tslock-bugfix/SKILL.md) | Reproduce, fix, verify, review, and repeat for a defect or regression | New features, docs-only, or test-only work |
| Feature/provider | [`tslock-sdd`](./.opencode/skills/tslock-sdd/SKILL.md) | Spec → plan → implement → verify → review for new behavior or substantial changes | Isolated bugs, docs-only, or test-only work |
| Documentation | [`tslock-doc-improver`](./.opencode/skills/tslock-doc-improver/SKILL.md) | Compare docs with specs, plans, reviews, and code, then reconcile them | Runtime bug fixes or new design work |
| Tests | [`tslock-test-improver`](./.opencode/skills/tslock-test-improver/SKILL.md) | Review coverage, add meaningful tests, verify, review, and repeat | Production fixes or feature design |
| Refactor | `tslock-sdd` for substantial changes; fast track for local mechanical edits | Architecture, public contracts, or multiple packages | Trivial cleanup |

These are OpenCode skills; contributors working without an agent can follow the same routing in [`CONTRIBUTING.md`](./CONTRIBUTING.md). The canonical names are `tslock-sdd`, `tslock-bugfix`, `tslock-doc-improver`, and `tslock-test-improver`.

### Adding a new provider

Use [`tslock-sdd`](./.opencode/skills/tslock-sdd/SKILL.md) or follow the equivalent process manually:

1. Open an issue to claim the provider and confirm it is in scope.
2. Read `docs/00-vision.md`, `docs/01-architecture.md`, and an existing provider's spec/plan/review as a template.
3. Create immutable `docs/specs/<NN>-<name>.md` and `docs/plans/<NN>-<name>.md`.
4. Implement under `packages/<name>/` following the package conventions in `AGENTS.md`.
5. Add the shared integration test contract from `@tslock/test-support`.
6. Run the full verification suite above and fix any failures.


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

All design docs are in [`docs/`](./docs). Contributor workflow routing is documented in [`CONTRIBUTING.md`](./CONTRIBUTING.md), and the executable agent workflows are in [`.opencode/skills/`](./.opencode/skills/).

| Doc | Content |
|---|---|
| [`docs/00-vision.md`](./docs/00-vision.md) | Product vision, scope, provider matrix, design decisions |
| [`docs/01-architecture.md`](./docs/01-architecture.md) | Monorepo structure, core abstractions, provider categories, test architecture |
| [`docs/specs/`](./docs/specs/) | Per-provider, middleware, architecture-hardening, build-policy, and verification-follow-up specifications (28 docs) |
| [`docs/plans/`](./docs/plans/) | Per-provider, middleware, architecture-hardening, build-policy, and verification-follow-up implementation plans (28 docs) |
| [`docs/reviews/`](./docs/reviews/) | Independent reviews of each spec/plan combo, including architecture hardening, build policy, verification follow-up, and a supplemental middleware-code review (29 docs) |

## Project status

All packages are implemented and verified. See `docs/` for design documentation.

## Publishing

Releases are performed locally (npm 2FA is interactive and cannot be automated via tokens). **Admin only.**

```bash
pnpm login                              # one-time — handles 2FA
pnpm changeset                          # describe changes, pick semver bump
pnpm version-packages                   # bump versions + update CHANGELOGs
pnpm format                             # reformat package.json
pnpm check:packed-peers                  # verify packed peer dependencies
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
