# Failure modes: when double-execution is possible

TSLock provides **at-most-once execution under its model**. That model is time-based and assumes **synchronized wall clocks**. This guide documents when the guarantee fails — and what TSLock does *not* claim.

It is intentional that this document does not invent stronger promises than ShedLock's design.

## The model in one paragraph

A lock is a record whose `lockUntil` is roughly `now + lockAtMostFor` at acquisition (or extension). Another instance may acquire the lock only when its view of `now` is past that deadline (or the record is missing). Validity is therefore a function of **wall-clock time shared across writers and readers**, not of a logical lease negotiated without clocks.

**Assumption you must meet:** process clocks are NTP-synced (or otherwise tightly coupled). TSLock does not correct skew, does not use hybrid logical clocks, and does not provide fencing tokens for downstream writes.

## Guarantees (honest)

| Claim | Meaning |
|---|---|
| At-most-once *while the storage lease is live* | Concurrent `lock()` against an unexpired backend record should skip. Holding a local `SimpleLock` object is not proof of exclusivity after expiry or eviction. |
| Crash safety via expiry | If a holder dies without unlocking, the lock becomes acquirable after `lockAtMostFor` (backend permitting). |
| Not exactly-once | Skipped runs are not retried. Overlapping runs are possible under the failures below. |
| Not a distributed transaction | Holding a lock does not fence storage writes by itself. |

## Failure modes

### 1. Clock skew

If node B's clock is ahead of node A's by more than the remaining TTL on A's lock, B treats the lock as expired and can acquire it while A's task is still running.

```
A acquires at T_a → lockUntil ≈ T_a + lockAtMostFor
B's clock = T_a + skew
If skew > remaining TTL → B acquires → double execution
```

`lockAtLeastFor` only reduces *immediate* re-acquisition after a short unlock; it does not protect a long-running holder against large skew.

**Mitigation:** run NTP (or chrony) on every node; keep skew far smaller than your shortest `lockAtMostFor`; prefer durable backends over caches for critical jobs.

### 2. `lockAtMostFor` overrun

If a task runs longer than `lockAtMostFor` without extending (or keep-alive renewing), the lock expires while the task continues. Another instance can start the same job.

This is the same *mechanical* outcome as severe skew: wall time crossed `lockUntil` while the first holder still believes it owns the critical section.

**Mitigation:** set `lockAtMostFor` generously; for long jobs use `KeepAliveLockProvider` or `LockExtender.extendActiveLock`; make task bodies idempotent.

### 3. Memcached early eviction

Memcached is an LRU cache, not a durable lock store. Under memory pressure it may drop the lock key **before** TTL expiry. Another instance can `add` the key while the original holder is still running.

`lockAtMostFor` is then an *upper* bound on intended hold time, not a floor. See [`@tslock/memcached`](../packages/memcached/README.md) and the provider spec.

**Mitigation:** dedicated memcached sized so lock keys are never evicted; or use Redis, SQL, etcd, ZooKeeper, etc. for critical locks.

### 4. Crashed or failed keep-alive

`KeepAliveLockProvider` renews about every `lockAtMostFor / 2`. If renewals stop (process freeze, event-loop blockage, repeated extend failures, callback deactivation after loss), the underlying lock still expires at the last written `lockUntil`. Another instance can then acquire while the original task may still be running.

Keep-alive **reduces** overrun risk; it does not eliminate skew, eviction, or a hard crash that never unlocks.

**Mitigation:** monitor keep-alive failures (`onKeepAliveFailure` / lock health); keep `lockAtMostFor` large enough that a single missed renewal cannot expose a long critical section; still design for idempotency.

### 5. Stale unlock after re-acquisition

After expiry or eviction, a second instance may hold the lock. If the first instance later calls `unlock()` (or a delayed unlock path), some backends can mutate or clear the record without proving current ownership. The in-memory harness demonstrates this class of race for teaching purposes; production providers vary (Lua ownership checks, CAS, LWT, etc.).

Do not treat "I still have a `SimpleLock` object" as proof that the storage lease is exclusive after `lockUntil`.

### 6. Workers KV stale reads (two holders)

[`@tslock/cloudflare-kv`](../packages/cloudflare-kv/README.md) is an advisory provider. Workers KV has no compare-and-swap. Reads, including “this key is missing”, are cached at the edge for about 60 seconds, and same-location visibility of a write is not guaranteed.

Two isolates can both `GET` a miss, both `PUT` their own ownership token, and both observe that token on a follow-up read. Both `lock()` calls return a `SimpleLock`. A confirm read only proves that *this* caller saw its token.

**Mitigation:** use [`@tslock/cloudflare-do`](../packages/cloudflare-do/README.md) when overlapping execution is unacceptable. If you stay on KV, make the task idempotent and pass `acknowledgeAdvisoryLock: true` knowingly.

### 7. Workers KV delayed deletes (phantom holds)

`unlock()` deletes the key when `lockAtLeastFor` has already elapsed, or writes a shorter `lockUntil` otherwise. Another location can keep serving the previous value until its cache expires, so a second acquire skips while the key is already gone at the writer (`phantom hold`).

The inverse is worse: a holder whose cache still shows *its own* token will `DELETE` or `PUT` unconditionally. That write can remove a newer holder who acquired after a stale read. KV deletes are not conditional.

### 8. Workers KV 60 second expiration floor

KV rejects `expirationTtl` below 60 seconds. TSLock still treats `lockUntil` as the lease, so a 5 second `lockAtMostFor` can be re-acquired once that deadline passes even though the key remains. The stored TTL is `max(60, floor(remainingMs / 1000) + 1)` so the platform does not drop the key before the logical deadline. KV’s clock can still delete the key after that TTL; a later reader then sees a miss and may acquire while a slow holder is in the section.

### 9. Workers KV one write per second per key

KV returns HTTP 429 when the same key is written more than once per second. Acquire plus an immediate unlock is two writes. `KeepAliveLockProvider` renews about every `lockAtMostFor / 2`, so a lease under about two seconds renews too fast. The provider propagates the 429; it does not turn it into “lock not acquired”.

**Mitigation:** keep `lockAtMostFor` large enough that renewals are at least a second apart. For a hot key, use Durable Objects.

## What the automated harness covers

[`packages/in-memory/__tests__/failure-modes.test.ts`](../packages/in-memory/__tests__/failure-modes.test.ts) uses `@tslock/in-memory` plus `ClockProvider` / helpers from `@tslock/test-support` to **simulate** these outcomes in one process:

| Scenario | Simulation | Asserted behavior |
|---|---|---|
| Skew / overrun | Advance the shared clock past `lockUntil` while the first lock object is not unlocked | Second `lock()` succeeds |
| Early eviction | Delete the in-memory map entry mid-hold (Memcached-shaped loss) | Second `lock()` succeeds |
| Crashed / failed keep-alive | Stop renewals and expire, or delete the map entry then tick renewals | Second `lock()` succeeds after expiry; `onKeepAliveFailure` fires when extend finds no lease |
| `lockAtLeastFor` small drift | Unlock with a minimum hold, advance less than `lockAtLeastFor` | Second `lock()` still skipped |

[`packages/cloudflare-kv/__tests__/failure-modes.test.ts`](../packages/cloudflare-kv/__tests__/failure-modes.test.ts) uses a `MutableClock` plus in-memory KV fakes (including a per-location cache) for the Workers KV rows:

| Scenario | Simulation | Asserted behavior |
|---|---|---|
| Stale reads / two holders | Two caches that still remember a miss | Both `lock()` calls return a lock |
| Delayed delete | Reader cache keeps the pre-delete value | Next `lock()` skips until that cache entry is dropped |
| 60 second TTL floor | 5 second lease, clock advanced past `lockUntil` | `expirationTtl >= 60`, key still present, second `lock()` succeeds |
| 1 write/second/key | Fake throws 429 on the second write | `unlock()` rejects; the key remains |
| Stale unlock | Writer cache still shows its own token after a newer acquire | `DELETE` clears the newer holder; a third acquire succeeds |

Advancing one shared `ClockProvider` is **isomorphic** to another node being ahead of the writer's clock by more than the remaining TTL. It does not claim to reproduce multi-host NTP chaos, real Memcached LRU, or Cloudflare’s edge cache — only the lock-protocol consequences documented above. The KV tests model a cached miss and a cached hit; they do not open a network connection to Cloudflare.

## Operator checklist

1. Confirm NTP/chrony on every scheduler node.
2. Size `lockAtMostFor` ≫ expected runtime (+ skew budget); use keep-alive for long work.
3. Set `lockAtLeastFor` on short, frequent jobs to absorb small drift after unlock.
4. Avoid Memcached for locks that must not overlap; if you use it, isolate and size it.
5. On Cloudflare, use Durable Objects (`@tslock/cloudflare-do`) for locks that must not overlap. Treat Workers KV as advisory.
6. Make the scheduled work idempotent — locks reduce duplicates; they do not make unsafe work safe.
7. Prefer durable providers for money-moving or irreversible side effects.

## Related reading

- Root [README caveats](../README.md#caveats)
- Vision: synchronized clocks ([`docs/00-vision.md`](./00-vision.md))
- Architecture: Memcached caveat and Category K ([`docs/01-architecture.md`](./01-architecture.md))
- Workers KV provider ([`packages/cloudflare-kv/README.md`](../packages/cloudflare-kv/README.md))
- Keep-alive and lock health ([`packages/core/README.md`](../packages/core/README.md))
