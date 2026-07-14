# TSLock — Product Vision

> A TypeScript port of [ShedLock](https://github.com/lukas-krecan/ShedLock): distributed locks for scheduled tasks, ensuring at-most-one-execution across application instances.

## 1. Problem Statement

When you run multiple instances of a Node.js or TypeScript application — in Kubernetes, ECS, Lambda, or behind a load balancer — scheduled tasks fire on **every** instance simultaneously. This causes:

- **Duplicate work**: every node processes the same batch job, sends the same webhook, runs the same cleanup.
- **Data corruption**: concurrent writes to the same record from multiple instances.
- **Wasted resources**: redundant API calls, database scans, third-party charges.
- **Inconsistent state**: race conditions when multiple instances mutate shared state.

The Node.js/TypeScript ecosystem today offers:
- **Framework-coupled solutions** (NestJS `@nestjs/schedule`, BullMQ) — lock you into a framework.
- **Single-backend solutions** (Redis-only lock libraries like `redlock`) — limit your storage choices.
- **DIY implementations** — fragile, untested, rarely handle edge cases (clock drift, lock extension, `lockAtLeastFor`).

None of these have the maturity, breadth of backends, or battle-testing of ShedLock, which has been running in production at scale across the JVM ecosystem for years.

## 2. What TSLock Is

TSLock is a **framework-agnostic, provider-pluggable** distributed lock library for TypeScript. It guarantees that a scheduled task executes on **at most one** instance at a time. When a task's lock is held by another instance, the task **skips** (does not queue, does not wait).

### Key properties

| Property | Description |
|---|---|
| **At-most-once execution** | If the lock is held, the task is skipped entirely. |
| **Time-based locks** | Locks expire after `lockAtMostFor` — no orphaned locks if a node crashes. |
| **Minimum hold time** | `lockAtLeastFor` prevents re-execution from clock drift on short tasks. |
| **Non-blocking** | Lock acquisition is a check-and-skip, never a wait. |
| **Assumes synchronized clocks** | Lock validity depends on wall-clock time; nodes must have NTP-synced clocks. |

### What TSLock is NOT

- **Not a scheduler.** TSLock does not schedule tasks. You wrap your already-scheduled task in a lock. Pair it with `node-cron`, `bree`, Agenda, EventBridge Scheduler, or your own `setInterval`.
- **Not a distributed transaction coordinator.** It is a simple time-based lock.
- **Not a queue.** Skipped tasks are not retried or deferred.

## 3. Target Users

| Audience | Motivation |
|---|---|
| **Teams running distributed Node.js services** | Need distributed locks without adopting a heavy framework. |
| **JVM-to-Node migrants** | Used ShedLock in Java; want the same patterns and API mental model in TS. |
| **Platform/infra teams** | Want a single lock library that works across 20+ backends so teams can pick their storage. |
| **Application developers** | Need a simple, type-safe, well-tested lock around cron jobs, batch processors, cleanup tasks. |

## 4. Design Principles

1. **Framework-agnostic.** No dependency on NestJS, Express, Fastify, or any web/DI framework. Pure TypeScript library.
2. **Provider-pluggable.** One core API, 20+ storage backends. Each provider is a separate package with only its driver dependency.
3. **Minimal dependencies.** Core package has zero runtime dependencies. Each provider package pulls only its canonical driver. No transitive dependency bombs.
4. **Type-safe.** First-class TypeScript types throughout. Configuration objects are typed. No `any` in public APIs.
5. **Async-native.** All lock operations return `Promise`. Built for the Node.js event loop. `AsyncLocalStorage` replaces Java's `ThreadLocal` for lock context propagation.
6. **Familiar API.** Developers who know ShedLock should recognize every abstraction: `LockProvider`, `SimpleLock`, `LockConfiguration`, `LockingTaskExecutor`, `LockAssert`, `LockExtender`, `KeepAliveLockProvider`.
7. **Testable.** Every provider passes the same integration test contract. The `InMemoryProvider` works as a test double.

## 5. Scope

### 5.1 In Scope (v1)

| Feature | Status |
|---|---|
| Core abstractions (`LockProvider`, `SimpleLock`, `LockConfiguration`) | ✅ |
| `LockingTaskExecutor` with listener support | ✅ |
| `LockAssert` — assert code runs within a lock context | ✅ |
| `LockExtender` — manually extend the active lock | ✅ |
| `KeepAliveLockProvider` — auto-renew locks during long tasks | ✅ |
| `TrackingLockProviderWrapper` — introspect active locks | ✅ |
| All 24 ShedLock providers, each with canonical TS/JS driver | ✅ |
| Integration test contracts (shared abstract test suite) | ✅ |
| `InMemoryProvider` for testing/local development | ✅ |
| Duration parsing (`"30s"`, `30000`, `{ minutes: 5 }`) | ✅ |

### 5.2 Out of Scope (v1, deferred to v2+)

| Feature | Reason |
|---|---|
| **Web framework integrations** (NestJS, Express, Fastify decorators) | TS decorators are not standardized; API-first is cleaner. Add in v2 once core is stable. |
| **Metrics integrations** (Prometheus, OpenTelemetry) | `LockingTaskExecutorListener` is the extension point. Users can wire metrics themselves now; official packages later. |
| **Annotation/decorator-based locking** | No `@SchedulerLock` equivalent. API-driven: `executor.executeWithLock(task, config)`. |
| **Built-in scheduler integration** | No cron parser, no `setInterval` wrapper. User wires TSLock around their scheduler. |
| **Quarkus/CDI equivalent** | No DI container integration. |

### 5.3 Explicitly Not Supported (ever)

- **Reentrant locks across different lock names.** Reentrancy only applies to the same lock name within the same async context.
- **Fair queuing.** Locks are skip-if-held, not wait-in-line.
- **Lock inheritance across process boundaries.** No IPC lock propagation.

## 6. Provider Matrix

TSLock supports all 24 ShedLock providers. Each uses the canonical or most widely adopted TS/JS driver.

### 6.1 SQL Providers (3 TSLock packages, shared infrastructure)

| ShedLock Provider | Mechanism | TS/JS Driver | TSLock Package |
|---|---|---|---|
| jdbc-template | StorageBasedLockProvider | `pg` / `mysql2` / `mssql` (raw drivers) | `@tslock/sql` |
| r2dbc | StorageBasedLockProvider | Merged into `@tslock/sql` (Node drivers are async-native; R2DBC's reactive distinction does not apply) | `@tslock/sql` |
| jOOQ | StorageBasedLockProvider | `kysely` (type-safe query builder, most canonical TS SQL DSL) | `@tslock/kysely` |
| (new) | StorageBasedLockProvider | `drizzle-orm` (popular TS-native ORM) | `@tslock/drizzle` |

**Shared infrastructure:** `@tslock/sql-support` provides `DatabaseProduct`, `SqlConfiguration`, `SqlStatementsSource` — used by all three SQL packages.

**Rationale:** Java distinguishes blocking (JDBC) from reactive (R2DBC) because JDBC blocks threads. Node.js SQL drivers are inherently async/non-blocking, so the JDBC/R2DBC distinction collapses into one provider. jOOQ (code-generation SQL DSL) maps to Kysely. Drizzle is a popular TS-native ORM with its own query builder, added as a third SQL option.

### 6.2 Storage-Based Providers (8 — all use `StorageBasedLockProvider` insert-or-update pattern)

| ShedLock Provider | Mechanism | TS/JS Driver | TSLock Package |
|---|---|---|---|
| Neo4j | Cypher unique constraint | `neo4j-driver` | `@tslock/neo4j` |
| Couchbase | insert + CAS replace | `couchbase` | `@tslock/couchbase` |
| Spanner | readWriteTransaction + Mutation | `@google-cloud/spanner` | `@tslock/spanner` |
| Firestore | runTransaction | `@google-cloud/firestore` | `@tslock/firestore` |
| Datastore | newTransaction | `@google-cloud/datastore` | `@tslock/datastore` |
| S3 | Head + Put with conditions | `@aws-sdk/client-s3` | `@tslock/s3` |
| GCS | create with doesNotExist / generationMatch | `@google-cloud/storage` | `@tslock/gcs` |
| Cassandra | LWT (IF NOT EXISTS / IF condition) | `cassandra-driver` | `@tslock/cassandra` |

### 6.3 Direct Providers (5 — Ignite deferred)

| ShedLock Provider | Mechanism | TS/JS Driver | TSLock Package |
|---|---|---|---|
| Mongo | findOneAndUpdate + upsert | `mongodb` (official) | `@tslock/mongo` |
| DynamoDB | UpdateItem with conditionExpression | `@aws-sdk/client-dynamodb` | `@tslock/dynamodb` |
| Elasticsearch | painless script + upsert + refresh | `@elastic/elasticsearch` | `@tslock/elasticsearch` |
| OpenSearch | painless script + upsert + refresh | `@opensearch-project/opensearch` | `@tslock/opensearch` |
| ArangoDB | stream transaction + insert/update | `arangojs` | `@tslock/arangodb` |
| ~~Ignite~~ | ~~keyValueView get/put/replace~~ | ~~apache-ignite-client~~ | ~~Deferred to v2~~ |

**Ignite note:** The `apache-ignite-client` Node.js thin client exists but is immature and low-adoption. Deferred to v2 pending a more mature driver.

### 6.4 Redis (3 ShedLock variants → 2 TSLock packages)

| ShedLock Provider | Mechanism | TS/JS Driver | TSLock Package |
|---|---|---|---|
| Spring RedisConnectionFactory | SET NX PX + Lua scripts | N/A (no Spring in TS) | — |
| Jedis | SET NX PX + Lua scripts | `redis` (node-redis, official) | `@tslock/redis` |
| Lettuce | SET NX PX + Lua scripts | `ioredis` (most widely adopted) | `@tslock/redis-ioredis` |

**Rationale:** ShedLock has 3 Redis variants because Java has 3 Redis client libraries. In TS, the two dominant clients are `ioredis` (most adopted, feature-rich) and `redis` (official). The "Spring" variant has no equivalent (no Spring in TS). Both TSLock Redis packages share the same `InternalRedisLockProvider` logic; only the thin adapter differs.

### 6.5 Specialized Providers (5)

| ShedLock Provider | Mechanism | TS/JS Driver | TSLock Package |
|---|---|---|---|
| Hazelcast | IMap with TTL | `hazelcast-client` | `@tslock/hazelcast` |
| ZooKeeper | PERSISTENT znode + version check | `zk` (node-zookeeper) | `@tslock/zookeeper` |
| Etcd | Lease + txn (version == 0) | `etcd3` | `@tslock/etcd` |
| Memcached | add (fails if exists) + replace | `memjs` | `@tslock/memcached` |
| NATS JetStream | KeyValue bucket + create/update with revision | `nats` | `@tslock/nats` |

### 6.6 In-Memory (1)

| ShedLock Provider | Mechanism | TSLock Package |
|---|---|---|
| InMemory | `Map<string, LockRecord>` with synchronized access | `@tslock/in-memory` |

**Usage:** Testing and local development only. Not for production distributed locking.

### 6.7 Summary: 24 ShedLock providers → 25 TSLock packages

The mapping:
- R2DBC merges into `@tslock/sql` (async distinction doesn't apply in Node).
- Spring Redis has no TS equivalent (no Spring). The 2 remaining Redis variants (Jedis→`redis`, Lettuce→`ioredis`) become 2 packages sharing `@tslock/redis-core`.
- jOOQ → Kysely (`@tslock/kysely`). Drizzle added as `@tslock/drizzle` (no ShedLock equivalent, user-requested).
- Shared SQL infrastructure in `@tslock/sql-support` (used by `@tslock/sql`, `@tslock/kysely`, `@tslock/drizzle`).
- Ignite deferred to v2 (immature Node.js driver). 23 providers for v1.
- `@tslock/core` + `@tslock/test-support` are infrastructure packages (not providers).

## 7. Key Differences from ShedLock (Java)

| Aspect | ShedLock (Java) | TSLock (TypeScript) |
|---|---|---|
| **Concurrency model** | Thread-based (`ThreadLocal`) | Async (`AsyncLocalStorage`) |
| **Lock operations** | Synchronous (`Optional<SimpleLock>`) | Async (`Promise<SimpleLock | undefined>`) |
| **Task execution** | `Runnable` / `Callable` | `() => Promise<void>` / `() => Promise<T>` |
| **Time API** | `java.time.Instant` / `Duration` | Epoch millis (`number`) internally; `Duration` helper for API |
| **Duration formats** | `1s`, `5ms`, `PT15M`, ISO-8601 | `30s`, `30000`, `{ minutes: 5 }` (ISO-8601 duration optional) |
| **Module system** | Maven multi-module | npm/pnpm workspaces monorepo |
| **Packaging** | JAR per module | npm package per provider (`@tslock/*` scoped) |
| **Framework integration** | Spring, Micronaut, CDI | None (v1); add in v2 |
| **Metrics** | Micrometer | `LockingTaskExecutorListener` extension point (user wires their own) |
| **Annotation support** | `@SchedulerLock` | None (API-driven) |
| **Reentrancy detection** | `ThreadLocal` deque | `AsyncLocalStorage` deque |

## 8. Success Criteria

1. **Behavioral parity**: All providers pass the shared integration test contract (lock once, skip if held, unlock, extend where supported, `lockAtLeastFor` honored, fuzz test passes).
2. **API familiarity**: A ShedLock user can read the TSLock API and immediately understand every type and method.
3. **Zero unnecessary dependencies**: `@tslock/core` has zero runtime deps. Each provider package depends only on its driver + `@tslock/core`.
4. **Tree-shakeable**: Core is small; users only bundle the provider they use.
5. **Documentation**: Every provider has a README with setup, configuration, and usage example.
6. **Type safety**: No `any` in public APIs. Configuration objects are fully typed.
7. **Test coverage**: ≥90% on core. Each provider has integration tests against a real (containerized) backend.

## 9. Non-Goals (v1)

- **Not the fastest lock library.** Correctness and clarity over micro-optimization. A lock check is a single round-trip to the backing store; latency is dominated by network, not library overhead.
- **Not a distributed coordination framework.** No leader election, no barrier, no phaser. Just locks.
- **Not a replacement for Redis Redlock.** Redlock is a different algorithm (quorum-based). TSLock's Redis provider uses single-instance `SET NX PX` + Lua, matching ShedLock's approach.
- **Not polyglot.** TypeScript/Node.js only. Not designed for browser, Deno, or Bun (though it may work on Bun since Bun supports Node APIs).

## 10. Versioning & Compatibility

- **v1.0.0**: Initial release with all providers and core abstractions.
- **Semver**: Breaking changes to the core API require a major version bump. Provider packages follow their own semver but track core's major.
- **Node.js support**: LTS strategy — support the current LTS. At launch: Node 22+ (current LTS).
- **TypeScript**: Target TS 5.x. Emit ESM + CJS dual format.

## 11. License

Apache 2.0, matching ShedLock.

## 12. Resolved Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| **Monorepo tool** | pnpm workspaces | Fast, disk-efficient, mature for TS monorepos |
| **SQL packages** | `@tslock/sql` (raw drivers) + `@tslock/kysely` + `@tslock/drizzle` | Three SQL approaches: raw driver adapters, Kysely query builder, Drizzle ORM. All share `@tslock/sql-support` infrastructure. R2DBC merges into `@tslock/sql` (Node drivers are async-native). |
| **Redis packages** | `@tslock/redis` (node-redis) + `@tslock/redis-ioredis` (ioredis) | Both are widely adopted. Share `@tslock/redis-core` logic. |
| **Ignite** | Skip for v1 | `apache-ignite-client` is immature/low-adoption. Document as future work. 23 providers for v1. |
| **Test framework** | Vitest | ESM-native, fast, excellent TS support |
| **Cloud integration tests** | LocalStack + emulators | LocalStack for S3/DynamoDB, GCP emulators for Firestore/Datastore. Skip Spanner/GCS (no emulator) — unit tests only. |
| **Package scope** | `@tslock/*` | Short, memorable, matches project name |
| **Module format** | Dual ESM + CJS | Maximum compatibility. tsup handles both. |
| **Node.js minimum** | Node 22+ | Current LTS, AsyncLocalStorage fully stable |
| **Config API** | Plain object + `parseDuration()` | Simplest, TypeScript validates shape. No builder class. |
