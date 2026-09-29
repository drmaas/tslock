# Migrate from ShedLock to TSLock

> One-page guide for JVM/ShedLock users moving scheduled-task locks to TypeScript.

TSLock is a TypeScript port of [ShedLock](https://github.com/lukas-krecan/ShedLock). The lock **model** is the same: time-based, non-blocking, skip-if-held. The API surface is familiar, but Node async semantics replace Java threads, and package/provider names differ.

Prefer this guide for day-to-day migration. For the full provider matrix and design history, see [`00-vision.md`](./00-vision.md) and [`01-architecture.md`](./01-architecture.md). For how TSLock differs from Redlock and BullMQ-style locks, see [`03-comparison.md`](./03-comparison.md).

## What stays the same

| Concept | Behavior |
|---|---|
| **At most one instance runs the task** | Another instance that loses the race **skips** — it does not wait or enqueue. |
| **`lockAtMostFor`** | Upper bound / crash safety net. After this duration the lock may be taken by someone else. |
| **`lockAtLeastFor`** | Minimum hold time; reduces double-runs from clock skew on short tasks. |
| **Familiar types** | `LockProvider`, `SimpleLock`, `LockConfiguration`, `LockingTaskExecutor`, `LockAssert`, `LockExtender`, `KeepAliveLockProvider`. |
| **Storage backends** | Same categories as ShedLock (SQL, Redis, Mongo, DynamoDB, …). Ignite is deferred in TSLock. |

## What you must change

| Aspect | ShedLock (Java) | TSLock (TypeScript) |
|---|---|---|
| Concurrency | `ThreadLocal` | `AsyncLocalStorage` |
| Lock API | Often sync (`Optional<SimpleLock>`) | Always async (`Promise<SimpleLock \| undefined>`) |
| Task shape | `Runnable` / `Callable` | `() => Promise<T>` |
| Durations | `Duration`, ISO-8601 (`PT30S`) | `'30s'`, millis number, or `{ seconds: 30 }` — **not** `PT…` strings |
| Config | Builders / Spring beans common | Plain objects + `createLockConfig(name, lockAtMostFor, lockAtLeastFor?)` |
| Packages | Maven modules | npm `@tslock/*` (install core + one provider + its driver) |
| Annotations | Spring `@SchedulerLock` | API-first; NestJS has [`@SchedulerLock`](../packages/nestjs/README.md) in `@tslock/nestjs` |
| Metrics | Micrometer | [`@tslock/otel`](../packages/otel/README.md); Prometheus is user-wired |

## Mental model (do not lose this)

1. **Skip, do not queue.** If the lock is held, that scheduled tick is dropped. Pair TSLock with a cron/scheduler; do not expect BullMQ-style retries of skipped runs.
2. **Wall-clock expiry.** Lock validity uses time (`lockUntil`). Application nodes need **NTP-synced clocks**, or use SQL `useDbTime` where your provider supports it so comparisons use the database clock.
3. **`lockAtMostFor` is a safety net, not a soft timeout.** If work outlives `lockAtMostFor`, another instance may start — set it generously or use `KeepAliveLockProvider` / `LockExtender`.

These are the same constraints as ShedLock. TSLock does not add stronger distributed consensus guarantees.

## Side-by-side: executor

**ShedLock (sketch):**

```java
lockingTaskExecutor.executeWithLock(
  (Task) () -> doWork(),
  new LockConfiguration("nightly-cleanup", Duration.ofMinutes(5), Duration.ofMinutes(1))
);
```

**TSLock:**

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createNodeRedisLockProvider } from '@tslock/redis';

const provider = createNodeRedisLockProvider(redisClient);
const executor = new DefaultLockingTaskExecutor(provider);

const result = await executor.executeWithLock(
  () => doWork(),
  createLockConfig('nightly-cleanup', '5m', '1m'),
);

if (!result.wasExecuted) {
  // another instance held the lock — this tick was skipped
}
```

`createLockConfig` is positional: `(name, lockAtMostFor, lockAtLeastFor?)`. Convert Java `PT30S` → `'30s'`, `PT5M` → `'5m'`.

## Side-by-side: NestJS / Spring-style annotation

ShedLock Spring:

```java
@Scheduled(cron = "0 0 * * * *")
@SchedulerLock(name = "report-task", lockAtMostFor = "PT50S", lockAtLeastFor = "PT10S")
public void report() { ... }
```

TSLock NestJS ([`@tslock/nestjs`](../packages/nestjs/README.md)):

```typescript
import { SchedulerLock, TslockModule } from '@tslock/nestjs';

@SchedulerLock({ name: 'report-task', lockAtMostFor: '50s', lockAtLeastFor: '10s' })
async report() { ... }
```

Register `TslockModule` with a `LockProvider`. When the lock is held, the method does not run (same skip semantics).

Without Nest, keep using `DefaultLockingTaskExecutor` around your existing scheduler (`node-cron`, Bree, EventBridge, `setInterval`, etc.). Optional thin adapters live under `@tslock/node-cron`, `@tslock/bree`, and `@tslock/aws-lambda`.

## Provider package map (common cases)

| ShedLock | TSLock package | Notes |
|---|---|---|
| JDBC / R2DBC | `@tslock/sql` + `@tslock/sql-support` | Node drivers are async; JDBC/R2DBC collapse into one package (`pg` / `mysql2` / `mssql`). |
| jOOQ | `@tslock/kysely` | |
| (no Java analog) | `@tslock/drizzle` | Extra SQL option. |
| Jedis / Lettuce Redis | `@tslock/redis` or `@tslock/redis-ioredis` | Single-instance `SET NX PX` + Lua — **not** Redlock. Shared logic in `@tslock/redis-core`. |
| MongoDB | `@tslock/mongo` | |
| DynamoDB | `@tslock/dynamodb` | |
| Other storage providers | See [README packages](../README.md#packages) and [`00-vision.md`](./00-vision.md) §6 | Same category patterns (A–I) as architecture docs. |
| Ignite | — | Deferred (immature Node driver). |

Each provider README has setup SQL/indexes, config, and a copy-paste example. Install the **driver as a peer** yourself; TSLock does not bundle it.

## Checklist

1. Pick a provider that matches your existing ShedLock storage (or the closest Node driver).
2. Install `@tslock/core`, the provider package, and the driver; create a `LockProvider`.
3. Replace `@SchedulerLock` / `LockingTaskExecutor` calls with TSLock equivalents; make every lock path `await`.
4. Rewrite durations from `PT…` / `Duration` to TSLock `DurationInput`.
5. Confirm NTP (or `useDbTime` on SQL) and generous `lockAtMostFor` / keep-alive for long jobs.
6. Treat `wasExecuted === false` (or Nest `undefined`) as **expected contention**, not a failure to retry via a queue.

## Further reading

- [`00-vision.md`](./00-vision.md) — scope, provider matrix, non-goals (including “not Redlock”).
- [`01-architecture.md`](./01-architecture.md) — abstractions, `AsyncLocalStorage`, provider categories.
- [`03-comparison.md`](./03-comparison.md) — TSLock vs Redlock vs BullMQ-style locks.
- Root [`README.md`](../README.md) — quick start, caveats, package list.
