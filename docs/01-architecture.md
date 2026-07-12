# TSLock — Architecture

## 1. Overview

TSLock is a monorepo of TypeScript packages implementing distributed locks. A small core package defines the abstractions; provider packages implement them against specific storage backends.

```
                         ┌──────────────────────────────────────────────────┐
                         │              @tslock/core                        │
                         │  LockProvider · SimpleLock · LockConfiguration   │
                         │  LockingTaskExecutor · LockAssert · LockExtender │
                         │  KeepAliveLockProvider · Utils                   │
                         └──────────────────────┬───────────────────────────┘
                                                │
            ┌───────────────────┬───────────────┼───────────────┬────────────────────┐
            │                   │               │               │                    │
     ┌──────▼──────┐   ┌───────▼───────┐ ┌─────▼──────┐ ┌───────▼──────┐    ┌────────▼────────┐
     │ @tslock/    │   │ @tslock/      │ │ @tslock/   │ │ @tslock/     │    │ @tslock/        │
     │ sql         │   │ mongo         │ │ redis      │ │ in-memory    │    │ test-support    │
     │ (pg,mysql2, │   │ (mongodb)     │ │ (ioredis,  │ │ (Map)        │    │ (contracts)     │
     │  mssql)     │   │               │ │  node-redis│ │              │    │                 │
     └─────────────┘   └───────────────┘ └────────────┘ └──────────────┘    └─────────────────┘
      ...20 more provider packages...
```

## 2. Monorepo Structure

```
tslock/
├── packages/
│   ├── core/                    # @tslock/core — abstractions, executor, assert, extender
│   ├── test-support/            # @tslock/test-support — abstract integration test contracts
│   ├── sql-support/             # @tslock/sql-support — shared SQL infra (DatabaseProduct, SqlConfiguration, SqlStatementsSource)
│   ├── sql/                     # @tslock/sql — raw driver adapters (pg, mysql2, mssql)
│   ├── kysely/                  # @tslock/kysely — SQL via Kysely query builder
│   ├── drizzle/                 # @tslock/drizzle — SQL via Drizzle ORM
│   ├── neo4j/                   # @tslock/neo4j
│   ├── couchbase/               # @tslock/couchbase
│   ├── spanner/                 # @tslock/spanner
│   ├── firestore/               # @tslock/firestore
│   ├── datastore/               # @tslock/datastore
│   ├── s3/                      # @tslock/s3
│   ├── gcs/                     # @tslock/gcs
│   ├── cassandra/               # @tslock/cassandra
│   ├── mongo/                   # @tslock/mongo
│   ├── dynamodb/                # @tslock/dynamodb
│   ├── elasticsearch/           # @tslock/elasticsearch
│   ├── opensearch/              # @tslock/opensearch
│   ├── arangodb/                # @tslock/arangodb
│   ├── redis-core/              # @tslock/redis-core — shared InternalRedisLockProvider
│   ├── redis/                   # @tslock/redis — node-redis adapter
│   ├── redis-ioredis/           # @tslock/redis-ioredis — ioredis adapter
│   ├── hazelcast/               # @tslock/hazelcast
│   ├── zookeeper/               # @tslock/zookeeper
│   ├── etcd/                    # @tslock/etcd
│   ├── memcached/               # @tslock/memcached
│   ├── nats/                    # @tslock/nats
│   └── in-memory/               # @tslock/in-memory
├── docs/
│   ├── 00-vision.md
│   ├── 01-architecture.md       # ← this file
│   ├── specs/                   # per-provider/group specs
│   ├── plans/                   # per-provider/group implementation plans
│   └── reviews/                 # independent reviews of each spec/plan
├── README.md
├── AGENTS.md
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.config.ts
└── package.json
```

### Package dependency rules

1. **`@tslock/core`** depends on nothing (zero runtime deps).
2. **`@tslock/test-support`** depends on `@tslock/core` + Vitest (dev-only).
3. **`@tslock/sql-support`** depends on `@tslock/core` only (zero driver deps).
4. **`@tslock/sql`** depends on `@tslock/core` + `@tslock/sql-support` + `pg` / `mysql2` / `mssql` (peer deps — user installs the one they need).
5. **`@tslock/kysely`** depends on `@tslock/core` + `@tslock/sql-support` + `kysely` (peer dep).
6. **`@tslock/drizzle`** depends on `@tslock/core` + `@tslock/sql-support` + `drizzle-orm` (peer dep).
7. **`@tslock/redis-core`** depends on `@tslock/core` only (shared Redis logic, no Redis client dep).
8. **`@tslock/redis`** depends on `@tslock/core` + `@tslock/redis-core` + `redis` (peer dep).
9. **`@tslock/redis-ioredis`** depends on `@tslock/core` + `@tslock/redis-core` + `ioredis` (peer dep).
10. **Every other provider package** depends on `@tslock/core` + its driver (peer dep).
11. **No provider depends on another provider.** Shared logic lives in core or in a shared support package (`sql-support`, `redis-core`).
12. **Peer dependencies, not bundled dependencies**, for drivers. Users install the driver version they want. This avoids version conflicts and keeps packages lean.

## 3. Core Abstractions

### 3.1 Types (TypeScript adaptation of ShedLock core)

All types are async-native. Lock operations return `Promise`.

```typescript
// ─── LockConfiguration ──────────────────────────────────────────────

interface LockConfiguration {
  readonly name: string;
  readonly lockAtMostFor: number;    // millis
  readonly lockAtLeastFor: number;   // millis
  readonly createdAt: number;        // epoch millis (set by ClockProvider)
}

// Derived getters as helper functions (TS has no idiomatic interface getters):
function lockAtMostUntil(config: LockConfiguration): number  // createdAt + lockAtMostFor
function lockAtLeastUntil(config: LockConfiguration): number  // createdAt + lockAtLeastFor
function unlockTime(config: LockConfiguration): number        // max(now, lockAtLeastUntil)

// ─── SimpleLock ──────────────────────────────────────────────────────

interface SimpleLock {
  unlock(): Promise<void>;
  extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined>;
}

// AbstractSimpleLock → AbstractSimpleLock base class
abstract class AbstractSimpleLock implements SimpleLock {
  protected valid = true;
  protected constructor(protected readonly config: LockConfiguration) {}
  async unlock(): Promise<void> { this.checkValidity(); await this.doUnlock(); this.valid = false; }
  async extend(...): Promise<SimpleLock | undefined> {
    this.checkValidity();
    const newConfig = { ...this.config, lockAtMostFor, lockAtLeastFor, createdAt: now() };
    const result = await this.doExtend(newConfig);
    this.valid = false;
    return result;
  }
  protected abstract doUnlock(): Promise<void>;
  protected async doExtend(config: LockConfiguration): Promise<SimpleLock | undefined> {
    throw new Error('Extend not supported');
  }
  protected checkValidity(): void { if (!this.valid) throw new LockException('Lock already released'); }
}

// ─── LockProvider ────────────────────────────────────────────────────

interface LockProvider {
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
}

// ExtensibleLockProvider — marker interface (in TS: just a marker type)
interface ExtensibleLockProvider extends LockProvider {}

// ─── LockingTaskExecutor ─────────────────────────────────────────────

interface LockingTaskExecutor {
  executeWithLock(task: () => Promise<void>, config: LockConfiguration): Promise<TaskResult<void>>;
  executeWithLock<T>(task: () => Promise<T>, config: LockConfiguration): Promise<TaskResult<T>>;
}

interface TaskResult<T> {
  wasExecuted: boolean;
  getResult(): T | undefined;
}
```

### 3.2 LockConfiguration Construction

In ShedLock, `LockConfiguration` is constructed by framework integrations (Spring extracts it from `@SchedulerLock` annotations). In TSLock (no framework), the user constructs it directly or via a builder helper:

```typescript
// Direct:
const config: LockConfiguration = {
  name: 'my-task',
  lockAtMostFor: parseDuration('30m'),
  lockAtLeastFor: parseDuration('5s'),
  createdAt: ClockProvider.now(),
};

// Helper (recommended):
const lock = await lockProvider.lock(
  lockConfig('my-task').atMostFor('30m').atLeastFor('5s').build()
);
```

### 3.3 Duration Parsing

```typescript
// Accepts: number (millis), string ("30s", "5m", "1h", "1d", "500ms"), 
// or { hours, minutes, seconds, millis } object
function parseDuration(input: number | string | DurationParts): number  // returns millis
```

### 3.4 ClockProvider

```typescript
class ClockProvider {
  private static clock: () => number = () => Date.now();  // epoch millis
  static now(): number { return ClockProvider.clock(); }
  static setClock(clock: () => number): void { ClockProvider.clock = clock; }
}
```

**Design note:** ShedLock truncates to millis. `Date.now()` already returns integer millis, so no truncation needed.

### 3.5 LockAssert — AsyncLocalStorage-based

This is the **critical adaptation** from Java's ThreadLocal to Node's AsyncLocalStorage.

```typescript
import { AsyncLocalStorage } from 'node:async_hooks';

class LockAssert {
  private static storage = new AsyncLocalStorage<string[]>();

  static assertLocked(): void {
    const stack = LockAssert.storage.getStore();
    if (!stack || stack.length === 0) {
      throw new LockException('Lock assertion failed — code not running within a lock context');
    }
  }

  static alreadyLockedBy(name: string): boolean {
    const stack = LockAssert.storage.getStore();
    return !!stack && stack.includes(name);
  }

  // Called by DefaultLockingTaskExecutor — not public API
  static startLock(name: string): string[] {
    const current = LockAssert.storage.getStore() ?? [];
    return [...current, name];
  }

  static endLock(stack: string[]): string[] {
    return stack.slice(0, -1);
  }
}
```

**How it works:** `DefaultLockingTaskExecutor` uses `LockAssert.storage.run(stack, callback)` to establish a new async context. All `await` chains within the task see the lock stack. Sibling async operations outside the task do not. This is the correct semantic: only code within the locked task's continuation should pass `assertLocked()`.

### 3.6 LockExtender — AsyncLocalStorage-based

```typescript
class LockExtender {
  private static storage = new AsyncLocalStorage<SimpleLock[]>();

  static async extendActiveLock(lockAtMostFor: number, lockAtLeastFor: number): Promise<void> {
    const stack = LockExtender.storage.getStore();
    if (!stack || stack.length === 0) throw new NoActiveLockException();
    const currentLock = stack[stack.length - 1];
    const newLock = await currentLock.extend(lockAtMostFor, lockAtLeastFor);
    if (!newLock) throw new LockCanNotBeExtendedException();
    stack[stack.length - 1] = newLock;  // swap in-place
  }

  // Called by DefaultLockingTaskExecutor
  static startLock(lock: SimpleLock): SimpleLock[] {
    const current = LockExtender.storage.getStore() ?? [];
    return [...current, lock];
  }
  static endLock(stack: SimpleLock[]): SimpleLock[] {
    return stack.slice(0, -1);
  }
}
```

### 3.7 DefaultLockingTaskExecutor

```typescript
class DefaultLockingTaskExecutor implements LockingTaskExecutor {
  constructor(
    private readonly lockProvider: LockProvider,
    private readonly listener: LockingTaskExecutorListener = NO_OP_LISTENER,
  ) {}

  async executeWithLock<T>(
    task: () => Promise<T>,
    config: LockConfiguration,
  ): Promise<TaskResult<T>> {
    // Reentrancy: if already locked by this name in this async context, just run
    if (LockAssert.alreadyLockedBy(config.name)) {
      return this.executeTask(task, config);
    }

    this.listener.onLockAttempt(config);
    const lock = await this.lockProvider.lock(config);

    if (!lock) {
      this.listener.onLockNotAcquired(config);
      return TaskResult.notExecuted();
    }

    this.listener.onLockAcquired(config);

    // Run task within a new AsyncLocalStorage context that has the lock stack
    return await LockAssert.storage.run(
      LockAssert.startLock(config.name),
      async () => {
        return await LockExtender.storage.run(
          LockExtender.startLock(lock),
          async () => {
            try {
              return await this.executeTask(task, config);
            } finally {
              try {
                await lock.unlock();
              } catch (e) {
                // log warning, don't suppress task result
              }
            }
          },
        );
      },
    );
  }

  private async executeTask<T>(task: () => Promise<T>, config: LockConfiguration): Promise<TaskResult<T>> {
    this.listener.onTaskStarted(config);
    const start = performance.now();
    try {
      const result = await task();
      return TaskResult.result(result);
    } finally {
      this.listener.onTaskFinished(config, durationFromMillis(performance.now() - start));
    }
  }
}
```

**Key differences from ShedLock Java:**
1. **`AsyncLocalStorage.run()`** replaces ThreadLocal push/pop. The context is automatically inherited by all async continuations of the task.
2. **`performance.now()`** for timing instead of `System.nanoTime()`.
3. **Listener calls are synchronous** (no `safeEmit` async wrapper needed — just try/catch). Listener is still best-effort: failures are caught and logged, never block lock release.
4. **Unlock in `finally`** — if the task throws, the lock is still released. ShedLock does the same.

### 3.8 LockingTaskExecutorListener

```typescript
interface LockingTaskExecutorListener {
  onLockAttempt(config: LockConfiguration): void;
  onLockAcquired(config: LockConfiguration): void;
  onLockNotAcquired(config: LockConfiguration): void;
  onTaskStarted(config: LockConfiguration): void;
  onTaskFinished(config: LockConfiguration, executionTime: number): void;
}

const NO_OP_LISTENER: LockingTaskExecutorListener = {
  onLockAttempt: () => {},
  onLockAcquired: () => {},
  onLockNotAcquired: () => {},
  onTaskStarted: () => {},
  onTaskFinished: () => {},
};
```

This is the **metrics extension point**. Users implement this interface to wire Prometheus, OpenTelemetry, Datadog, or any metrics system. No metrics framework dependency in core.

### 3.9 KeepAliveLockProvider

Wraps an `ExtensibleLockProvider` and auto-extends locks on a timer.

```typescript
class KeepAliveLockProvider implements LockProvider {
  constructor(
    private readonly provider: ExtensibleLockProvider,
    private readonly scheduler: Scheduler,  // wraps setInterval/setTimeout
  ) {}

  static readonly MIN_LOCK_AT_MOST_FOR = 30_000;  // 30s

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    if (config.lockAtMostFor < KeepAliveLockProvider.MIN_LOCK_AT_MOST_FOR) {
      throw new LockException(`lockAtMostFor must be at least 30s, got ${config.lockAtMostFor}ms`);
    }
    const lock = await this.provider.lock(config);
    if (!lock) return undefined;
    return new KeepAliveLock(lock, config, this.scheduler);
  }
}
```

**`KeepAliveLock`** schedules `setInterval` at `lockAtMostFor / 2` to call `lock.extend(lockAtMostFor, remainingLockAtLeastFor)`. On unlock, cancels the interval. Does not support manual `extend()` (throws).

**Scheduler abstraction:** Instead of Java's `ScheduledExecutorService`, use a thin `Scheduler` interface wrapping `setInterval`/`clearInterval`. This allows injecting a fake scheduler in tests.

### 3.10 Utils

```typescript
class Utils {
  static getHostname(): string {
    try {
      return os.hostname();
    } catch {
      return 'unknown';
    }
  }

  static toIsoString(epochMillis: number): string {
    // ISO-8601 with exactly 3 fractional digits for natural sort ordering
    // "2018-12-07T12:30:37.810Z"
    return new Date(epochMillis).toISOString().replace(/\.(\d{3})$/, '.$1');
    // Note: Date.toISOString() already produces 3-digit millis in Node.js
  }
}
```

## 4. Support Layer

### 4.1 StorageBasedLockProvider + StorageAccessor

The workhorse for 11 of the 24 providers. Same pattern as ShedLock:

```
lock(config):
  1. If lockRecordRegistry doesn't have this name:
     a. Try insertRecord(config)
     b. If success → add name to registry, return new StorageLock
     c. If fail → add name to registry (record exists), fall through
  2. Try updateRecord(config)  // WHERE lockUntil <= now
     a. If success → return new StorageLock
     b. If fail → return undefined (lock held by someone else)
  3. On exception during update after a fresh insert → clearCache(name)

StorageLock.unlock(config):
  → accessor.unlock(config)  // set lockUntil = unlockTime

StorageLock.extend(newConfig):
  → accessor.extend(newConfig)  // WHERE lockedBy = me AND lockUntil > now
  → if true: return new StorageLock
  → if false: return undefined
```

```typescript
interface StorageAccessor {
  insertRecord(config: LockConfiguration): Promise<boolean>;
  updateRecord(config: LockConfiguration): Promise<boolean>;
  unlock(config: LockConfiguration): Promise<void>;
  extend(config: LockConfiguration): Promise<boolean>;  // default: throw
}

abstract class AbstractStorageAccessor implements StorageAccessor {
  protected getHostname(): string { return Utils.getHostname(); }
  // insertRecord, updateRecord, unlock, extend implemented by subclasses
}

class StorageBasedLockProvider implements ExtensibleLockProvider {
  constructor(private readonly accessor: StorageAccessor) {}
  private readonly lockRecordRegistry = new LockRecordRegistry();

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    // ... as above
  }
}
```

### 4.2 LockRecordRegistry

In-memory cache of lock names known to exist. Prevents redundant `insertRecord` attempts after the first one fails (the record already exists, so `updateRecord` is the right path).

```typescript
class LockRecordRegistry {
  private readonly records = new Set<string>();
  lockRecordRecentlyCreated(name: string): boolean { return this.records.has(name); }
  addRecord(name: string): void { this.records.add(name); }
  clearCache(name: string): void { this.records.delete(name); }
}
```

**Note:** ShedLock uses `WeakHashMap` + synchronization. In Node.js (single-threaded event loop), a plain `Set` is safe for async access — no race conditions between concurrent async operations within the same process. We do NOT need `synchronized` equivalents. However, we should be careful about interleaving: since async operations can interleave at `await` points, the registry state could change between check and use. This is acceptable because the registry is an optimization (avoids unnecessary insert attempts), not a correctness mechanism. The insert/update themselves are atomic at the storage layer.

### 4.3 TrackingLockProviderWrapper

```typescript
class TrackingLockProviderWrapper implements LockProvider {
  private readonly activeLocks = new Set<SimpleLock>();

  constructor(private readonly delegate: LockProvider) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const lock = await this.delegate.lock(config);
    if (!lock) return undefined;
    return new TrackingSimpleLock(lock, this.activeLocks);
  }

  getActiveLocks(): ReadonlySet<SimpleLock> { return this.activeLocks; }
}
```

### 4.4 LockException

```typescript
class LockException extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LockException';
  }
}
```

## 5. SQL Support Layer

### 5.1 Shared SQL Infrastructure (`@tslock/sql-support`)

Zero driver dependencies. Depends only on `@tslock/core`. Used by `@tslock/sql`, `@tslock/kysely`, and `@tslock/drizzle`.

```
DatabaseProduct enum:
  POSTGRES, SQL_SERVER, ORACLE, MYSQL, MARIA_DB, HSQL, H2, DB2, COCKROACH_DB, UNKNOWN

SqlConfiguration:
  databaseProduct, tableName (default "shedlock"),
  timeZone, columnNames { name, lockUntil, lockedAt, lockedBy },
  lockedByValue (default hostname), useDbTime
  Validation: can't set both useDbTime and timeZone

SqlStatementsSource:
  create(config) → factory based on databaseProduct + useDbTime
  params(config) → { name, lockUntil, now, lockedBy, unlockTime }
  SQL statements: INSERT, UPDATE (WHERE lockUntil <= :now), EXTEND, UNLOCK
```

### 5.2 Raw Driver Provider (`@tslock/sql`)

Provides thin `SqlConnection` adapters for `pg`, `mysql2`, `mssql` and a `SqlStorageAccessor` that works with any of them via the `SqlConnection` interface:

```typescript
interface SqlConnection {
  query(sql: string, params: Record<string, unknown>): Promise<QueryResult>;
}
```

Users create a `SqlConnection` adapter for their driver:
- `pg`: `const conn = new PgConnection(pool);`
- `mysql2`: `const conn = new Mysql2Connection(pool);`
- `mssql`: `const conn = new MssqlConnection(pool);`

These adapters ship inside `@tslock/sql`. Drivers are peer dependencies — users install only the one they need.

### 5.3 Kysely Provider (`@tslock/kysely`)

Uses Kysely's type-safe query builder. Shares `SqlConfiguration` and `SqlStatementsSource` from `@tslock/sql-support`. The `KyselyStorageAccessor` uses Kysely's `db.executeQuery()` instead of raw SQL strings.

### 5.4 Drizzle Provider (`@tslock/drizzle`)

Uses Drizzle ORM's query builder. Shares `SqlConfiguration` and `SqlStatementsSource` from `@tslock/sql-support`. The `DrizzleStorageAccessor` uses Drizzle's `db.execute()` / `db.run()` APIs. Drizzle supports PostgreSQL, MySQL, and SQLite — the SQL statements from `SqlStatementsSource` are used via Drizzle's `sql` template tag.

### 5.5 Database Time (`useDbTime`)

ShedLock supports `useDbTime()` — the lock records use the database server's clock instead of the application's clock. This avoids clock drift issues between application instances. TSLock supports this via DB-specific statement sources (e.g., `now()` in Postgres, `GETUTCDATE()` in SQL Server).

## 6. Provider Architecture by Category

### 6.1 Category A: StorageBasedLockProvider (11 providers)

```
@tslock/neo4j, @tslock/couchbase, @tslock/spanner, @tslock/firestore,
@tslock/datastore, @tslock/s3, @tslock/gcs, @tslock/cassandra,
@tslock/sql (pg/mysql2/mssql), @tslock/kysely
```

All implement `StorageAccessor` and delegate to `StorageBasedLockProvider`. The only difference is how `insertRecord`, `updateRecord`, `unlock`, `extend` are implemented against the specific backend.

### 6.2 Category B: Direct LockProvider (5 providers — Ignite deferred)

```
@tslock/mongo, @tslock/dynamodb, @tslock/elasticsearch, @tslock/opensearch,
@tslock/arangodb
```

Each implements `LockProvider` directly (not via `StorageBasedLockProvider`) because their locking mechanism doesn't fit the insert-or-update pattern. Examples:
- **Mongo**: `findOneAndUpdate` with upsert (single atomic operation).
- **DynamoDB**: `UpdateItem` with `ConditionExpression`.
- **ES/OpenSearch**: Painless script + upsert.
- **ArangoDB**: Stream transaction with exclusive lock.

**Ignite** deferred to v2 (immature Node.js driver).

### 6.3 Category C: Redis (3 packages, shared logic)

```
@tslock/redis-core (shared InternalRedisLockProvider), @tslock/redis (node-redis), @tslock/redis-ioredis (ioredis)
```

`@tslock/redis-core` contains `InternalRedisLockProvider` and the `RedisTemplate` interface. The two adapter packages implement `RedisTemplate` for their respective Redis clients:

```typescript
interface RedisTemplate {
  setIfAbsent(key: string, value: string, expireMillis: number): Promise<boolean>;
  setIfPresent(key: string, value: string, expireMillis: number): Promise<boolean>;
  eval(script: string, keys: string[], args: string[]): Promise<unknown>;
  delete(key: string): Promise<void>;
  get(key: string): Promise<string | null>;
}
```

Locking: `SET key NX PX expireMs`. Unlock: Lua script checks `GET == value` then `DEL` (or `PEXPIRE` for `lockAtLeastFor`). Extend: Lua script checks `GET == value` then `PEXPIRE`.

### 6.4 Category D: Hazelcast

Uses `IMap` with entry-level TTL. Locks the store entry, checks/updates the lock record, unlocks the store entry. Different from StorageBasedLockProvider because it uses Hazelcast's `EntryProcessor` / `lock`/`tryLock` semantics.

### 6.5 Category E: ZooKeeper

PERSISTENT znodes (not ephemeral). Lock = znode whose data is the ISO timestamp of `lockAtMostUntil`. Acquire = create-or-set-version. No extend. Uses optimistic concurrency via `version` check.

### 6.6 Category F: Etcd

Lease + transaction. Lock = put key with lease (TTL = `lockAtMostFor`). Unlock = revoke lease (or re-put with shorter lease for `lockAtLeastFor`). No extend.

### 6.7 Category G: Memcached

`add` (fails if key exists). Lock = `add(key, expireSeconds, value)`. Unlock = `delete` (or `replace` with shorter TTL for `lockAtLeastFor`). No extend. **Caveat:** memcached can evict locks early under memory pressure.

### 6.8 Category H: NATS JetStream

KeyValue bucket with revision-based optimistic concurrency. Lock = `create` (fails if key exists) or `update` with revision (fails if revision mismatch). Value = 8-byte epoch millis. No extend.

### 6.9 Category I: InMemory

Plain `Map<string, number>` (name → lockedUntilEpochMillis). Synchronized access not needed (single-threaded event loop). Implements `ExtensibleLockProvider`. Test/local only.

## 7. Test Architecture

### 7.1 Test Support Package (`@tslock/test-support`)

Defines the canonical integration test contract that **every** provider must pass:

```
AbstractLockProviderIntegrationTest:
  ✓ shouldLockOnce
  ✓ shouldSkipIfLocked
  ✓ shouldUnlock
  ✓ shouldLockAtLeastFor
  ✓ shouldNotExtendIfNotExtensible

AbstractExtensibleLockProviderIntegrationTest extends AbstractLockProviderIntegrationTest:
  ✓ shouldExtendLock
  ✓ shouldNotExtendIfExpired

AbstractStorageBasedLockProviderIntegrationTest extends ...:
  ✓ shouldCreateLockRecord
  ✓ shouldNotCreateDuplicateRecord
  ✓ shouldUpdateRecordIfExpired

FuzzTester:
  ✓ shouldHandleConcurrentLockAttempts (N concurrent tasks, exactly one acquires)
```

Each provider's test suite extends these abstract tests and provides the `LockProvider` instance + backend setup/teardown.

### 7.2 Unit Tests

- **Core**: unit tests for `LockConfiguration`, `ClockProvider`, `LockAssert` (with AsyncLocalStorage), `LockExtender`, `DefaultLockingTaskExecutor` (with mock LockProvider), `KeepAliveLockProvider` (with fake scheduler), `LockRecordRegistry`, duration parsing, Utils.
- **Provider**: unit tests for `StorageAccessor` implementations using mocked driver clients.

### 7.3 Integration Tests

Each provider package has an `__tests__/integration/` directory with:
- A `docker-compose.yml` (or Testcontainers config) for the backend.
- A test file extending `AbstractLockProviderIntegrationTest`.
- Setup: start container, create schema/collection/index, instantiate provider.
- Teardown: drop schema, stop container.

### 7.4 Test Framework

**Vitest** (recommended — modern, ESM-native, fast, good TypeScript support, built-in mocking).

**Integration test infra**: Testcontainers via `testcontainers` npm package (spin up real PostgreSQL, MongoDB, Redis, etc. in Docker containers for integration tests). For cloud-only backends (S3, GCS, Spanner, Firestore, Datastore), use **LocalStack** (S3) / **emulator** where available, or skip integration tests and rely on unit tests + manual verification. Document this clearly.

## 8. Build & Packaging

### 8.1 Build Tool

**`tsup`** (esbuild-based, fast, dual ESM/CJS output, zero config). Each package:
- `src/` → `dist/` (ESM + CJS + type declarations)
- `package.json` with `exports` field for conditional imports
- `tsconfig.json` extending root `tsconfig.base.json`

### 8.2 TypeScript Configuration

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true
  }
}
```

### 8.3 Package.json Exports

Each provider package:
```json
{
  "name": "@tslock/neo4j",
  "version": "1.0.0",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "peerDependencies": {
    "@tslock/core": "^1.0.0",
    "neo4j-driver": "^5.0.0"
  },
  "peerDependenciesMeta": {
    "@tslock/core": { "optional": false }
  }
}
```

### 8.4 Node.js Target

- **Minimum**: Node 18 (LTS until April 2025 — but may bump to Node 20).
- **Recommended**: Node 20+ (LTS, `AsyncLocalStorage` stable, `performance.now()` stable).
- **AsyncLocalStorage**: Available since Node 13.10, stable since Node 16. No concern.

## 9. Error Handling

### 9.1 Exception Hierarchy

```
Error
  └── LockException
       ├── NoActiveLockException        (LockExtender called with no active lock)
       ├── LockCanNotBeExtendedException (extend failed at storage layer)
       └── (provider-specific errors propagate as-is from driver)
```

### 9.2 Error Propagation Strategy

- **Lock acquisition failure (lock held)**: NOT an error. Returns `undefined`. The task is skipped.
- **Storage errors (connection lost, constraint violation, etc.)**: Propagate as exceptions. The task is not executed. The caller decides whether to retry.
- **Unlock errors**: Caught and logged (in `DefaultLockingTaskExecutor`'s `finally` block). The task result is preserved. A stuck lock will expire via `lockAtMostFor`.
- **Extend errors**: Propagate to the caller of `LockExtender.extendActiveLock()`. In `KeepAliveLockProvider`, extend errors are caught and logged — the lock will expire naturally.
- **Listener errors**: Always caught and logged. Never block lock release or task execution.

### 9.3 Driver Error Mapping

Each provider maps driver-specific errors to TSLock semantics:
- **Duplicate key / conflict / conditional check failed** → lock not acquired (return `undefined`), not an error.
- **Connection errors** → propagate.
- **Key/column not found** → propagate (indicates misconfiguration).

## 10. Time & Duration Model

### 10.1 Internal Representation

- **Instant**: `number` (epoch millis). `Date.now()` for current time.
- **Duration**: `number` (millis). All internal APIs use millis.
- **ISO formatting**: `new Date(epochMillis).toISOString()` — produces `2018-12-07T12:30:37.810Z` (3-digit millis, natural sort order). This matches ShedLock's `Utils.toIsoString()`.

### 10.2 Public API

The public API accepts durations in user-friendly formats via `parseDuration()`:

```typescript
parseDuration(30000)              // → 30000 (millis)
parseDuration('30s')              // → 30000
parseDuration('5m')               // → 300000
parseDuration('1h')               // → 3600000
parseDuration('1d')               // → 86400000
parseDuration('500ms')            // → 500
parseDuration({ minutes: 5 })     // → 300000
```

**No ISO-8601 duration parsing** (`PT15M`) in v1 — it's a Java idiom rarely used in TS. Can add later if requested.

### 10.3 No Temporal Polyfill

The Temporal API is not yet in Node.js stable. We use plain `number` (epoch millis) internally. No `@js-temporal/polyfill` dependency. This keeps core zero-dep.

## 11. Reentrancy Model

**Same as ShedLock:** if `LockAssert.alreadyLockedBy(name)` returns true within the current async context, `DefaultLockingTaskExecutor` executes the task directly without attempting to acquire the lock again.

This means: if task A holds lock "foo" and calls task B which also needs lock "foo", task B runs without re-acquiring. This is reentrancy within the same async call chain.

**Cross-context reentrancy is NOT supported:** if task A holds lock "foo" and a separate independent async operation tries to acquire lock "foo", it will be skipped (lock held). This is correct.

## 12. Threading & Concurrency Model

Node.js is single-threaded (ignoring worker threads). This simplifies several ShedLock concepts:

| ShedLock (Java) | TSLock (Node.js) |
|---|---|
| `synchronized` methods | Not needed (single-threaded event loop) |
| `ConcurrentHashMap` | Plain `Map` (no concurrent access) |
| `ThreadLocal` | `AsyncLocalStorage` |
| `WeakHashMap` | `Map` or `Set` (no concern about thread safety) |
| `ScheduledExecutorService` | `setInterval` / `setTimeout` |
| `volatile` | Not needed |

**Async interleaving caveat:** While there's no true parallelism, async operations interleave at `await` points. This means:
- `LockRecordRegistry` state can change between check and use. This is acceptable — it's an optimization, not a correctness mechanism.
- `StorageBasedLockProvider.lock()` is not atomic across the insert-then-update sequence. But each individual storage operation IS atomic, so correctness is maintained at the storage layer.

## 13. Resolved Design Decisions

| Decision | Choice |
|---|---|
| **Monorepo tool** | pnpm workspaces |
| **SQL packages** | `@tslock/sql-support` (shared infra) + `@tslock/sql` (raw: pg/mysql2/mssql) + `@tslock/kysely` + `@tslock/drizzle` |
| **Redis packages** | `@tslock/redis-core` (shared logic) + `@tslock/redis` (node-redis) + `@tslock/redis-ioredis` (ioredis) |
| **Ignite** | Deferred to v2 |
| **Test framework** | Vitest |
| **Cloud integration tests** | LocalStack (S3, DynamoDB) + GCP emulators (Firestore, Datastore). Spanner/GCS: unit tests only. |
| **Package scope** | `@tslock/*` |
| **Module format** | Dual ESM + CJS (tsup) |
| **Node.js minimum** | Node 20+ |
| **Config API** | Plain typed object + `parseDuration()` |
