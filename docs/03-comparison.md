# TSLock compared to Redlock and BullMQ-style locks

> Short, accuracy-first comparison of lock **models**. This is not a feature bake-off.

TSLock (like ShedLock) targets **scheduled tasks across multiple app instances**: acquire a time-based lock or **skip** this tick. Other popular Node patterns solve different problems. Mixing them up leads to the wrong expectations about queuing, retries, and failure behavior.

Related: [`02-migration-from-shedlock.md`](./02-migration-from-shedlock.md), root [`README.md`](../README.md) (key properties and caveats).

## Shared vocabulary

| Term | Meaning here |
|---|---|
| **Skip-if-held** | Contending caller returns immediately without running the task. No wait queue for that tick. |
| **Time-based lease** | Lock expires after `lockAtMostFor` (wall clock or DB clock), so a crashed holder does not block forever. |
| **Queue / worker** | Work is stored and processed later, often with retries and concurrency controls. |

## At a glance

| | **TSLock** | **Redis Redlock** | **BullMQ-style locks / jobs** |
|---|---|---|---|
| Primary goal | At-most-one run of a **scheduled** task across instances | Mutual exclusion via **quorum** of Redis masters | **Job queue**: enqueue work, workers process it |
| On contention | **Skip** this tick | Block / fail acquire (library-dependent); not “skip cron” | Job **waits** in the queue (or delayed / retried) |
| Typical store | Many backends (SQL, Redis, Mongo, …) | Multiple independent Redis nodes | Redis (as queue + job state) |
| Clock assumption | **Yes** — lease end times depend on synchronized clocks (or SQL `useDbTime`) | Clock / timing assumptions are part of the algorithm’s debate | Job timing uses Redis TTLs and worker heartbeats; model is queue semantics, not ShedLock leases |
| Same as ShedLock Redis? | Redis provider uses single-instance `SET NX PX` + Lua | **No** — different algorithm | **No** |

## TSLock (ShedLock model)

**Use when:** several Node processes all fire the same cron (or similar), and only one should do the work; a missed tick is acceptable.

**Properties:**

- Non-blocking acquire: held lock → task not executed.
- `lockAtMostFor` / `lockAtLeastFor` match ShedLock.
- Providers vary; Redis is **not** Redlock (see below).
- Does **not** schedule work, does **not** queue skipped runs, does **not** provide distributed transactions or leader election.

**Correctness bounds you should assume:**

- Clocks must be close enough for your lease margins (NTP), unless the provider uses server time.
- If a task runs longer than `lockAtMostFor` without extend/keep-alive, another instance may start.
- “At most one” applies to overlapping executions under the lock protocol — it is **not** a guarantee that every scheduled tick runs exactly once.

## Redis Redlock

**What it is:** an algorithm that tries to take a lock on a **majority** of independent Redis masters (quorum), with TTLs, aimed at mutual exclusion when you distrust a single Redis failure domain.

**How TSLock differs:**

- `@tslock/redis` / `@tslock/redis-ioredis` follow ShedLock: **one** Redis logical keyspace, `SET key NX PX <ttl>`, unlock/extend via Lua that checks ownership. See [`packages/redis/README.md`](../packages/redis/README.md).
- TSLock does **not** implement Redlock and does **not** claim Redlock’s (or stronger) multi-master properties.
- Vision doc non-goal: *“Not a replacement for Redis Redlock.”* ([`00-vision.md`](./00-vision.md) §9).

**When people reach for Redlock:** cross-cutting critical sections with Redis-only stacks and multi-master topology. That is a different design problem from “dedupe this cron across pods.” Even then, read the known critiques of Redlock under pauses and clock issues before depending on it for safety-critical exclusion.

## BullMQ-style locks and queues

**What BullMQ (and similar) optimize for:** durable **jobs** — enqueue, compete among workers, retry, rate-limit, delay, prioritize. Locks/tokens exist so a worker owns a job while processing; the product center of gravity is the **queue**, not skip-if-held scheduling.

**How TSLock differs:**

| Concern | TSLock | BullMQ-style |
|---|---|---|
| Missed / contended schedule | Tick **skipped**; nothing is stored for later | Work remains (or is re-added) until success / DLQ policy |
| “Who runs?” | First successful lock holder for this name/lease | Workers pull jobs; concurrency is queue configuration |
| Framework coupling | Core is agnostic; optional Nest/HTTP/scheduler adapters | Typically Redis + BullMQ APIs / Nest `@nestjs/bull` etc. |
| Retries | Your code or outer scheduler; lock miss ≠ retry | Built-in attempts, backoff, failed-job handling |

**Do not use TSLock as a job queue.** If every cron fire must eventually run exactly once (or at least once with retries), you want a queue or an outbox — not ShedLock-style skip.

BullMQ’s Redis locks are implementation details of job ownership. They are not a drop-in substitute for TSLock’s multi-provider scheduled-task model, and TSLock is not a substitute for BullMQ’s delivery guarantees.

## Choosing quickly

```text
Need "only one instance runs this cron tick; OK to skip if busy"?
  → TSLock (or ShedLock on the JVM)

Need "work must be processed later with retries / concurrency limits"?
  → Queue (BullMQ, SQS, …) — not TSLock

Need "Redlock quorum across Redis masters"?
  → Not TSLock’s Redis provider; evaluate Redlock (and its limits) separately
```

## Explicit non-claims

TSLock does **not** claim:

- Exactly-once execution of every schedule tick.
- Wait/fair queuing for lock waiters.
- Redlock quorum safety.
- Independence from clock skew when using client wall time for `lockUntil`.
- That skipped work will be replayed.

For operational caveats (`lockAtMostFor`, registry cache, Memcached eviction), see the root README [Caveats](../README.md#caveats).
