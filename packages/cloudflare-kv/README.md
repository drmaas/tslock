# @tslock/cloudflare-kv

> Advisory lock provider backed by [Cloudflare Workers KV](https://developers.cloudflare.com/kv/).

**This is not mutual exclusion.** Workers KV is eventually consistent, has no compare-and-swap, and caches reads (including “key missing”) for about 60 seconds. Two Workers can both acquire the same name. Use [`@tslock/cloudflare-do`](../cloudflare-do/README.md) when overlapping execution is unacceptable.

Construction requires `acknowledgeAdvisoryLock: true` so that choice is explicit in code.

## When a duplicate run is possible

| Failure | What you observe |
|---|---|
| Stale or cached read | Both callers miss the live record (or see an old miss) and both `PUT` their own token. |
| Delayed delete | After `unlock()`, another location still sees the previous value and skips, or a stale copy of *your* token makes `DELETE` remove a newer holder. |
| 60 second TTL floor | `expirationTtl` cannot be below 60. The lease you check is `lockUntil`. The key can outlive a short lease, and KV can also drop the key on its own clock once the TTL elapses. |
| 1 write/second/key | A second `put` or `delete` inside one second throws (HTTP 429). That includes a fast unlock and keep-alive when `lockAtMostFor` is under about two seconds. |

Details and the in-memory reproductions live in [Failure modes](../../docs/failure-modes.md#6-workers-kv-stale-reads-two-holders).

A confirm read after `PUT` (default `confirmWrite: true`) only checks that *this* caller saw its token. It does not stop another location from doing the same.

## Installation

```bash
pnpm add @tslock/core @tslock/cloudflare-kv
```

No Cloudflare types package is required. Pass any object with `get`, `put`, and `delete` matching a Workers `KVNamespace` binding.

## Workers binding

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createCloudflareKvLockProvider } from '@tslock/cloudflare-kv';

interface Env {
  LOCKS: KVNamespace;
}

export default {
  async scheduled(_event: ScheduledEvent, env: Env): Promise<void> {
    const provider = createCloudflareKvLockProvider({
      kv: env.LOCKS,
      acknowledgeAdvisoryLock: true,
    });
    const executor = new DefaultLockingTaskExecutor(provider);
    await executor.executeWithLock(() => myScheduledTask(), createLockConfig('my-task', '5m', '1m'));
  },
};
```

Prefer Durable Objects for this scheduled task if two overlapping runs would be harmful:

```typescript
import { createCloudflareDoLockProvider } from '@tslock/cloudflare-do';
```

## REST (Node, optional)

The REST helper talks to the Cloudflare API. It uses the same get/put/delete protocol and does **not** make the lock strongly consistent.

```typescript
import { createCloudflareKvLockProvider, createCloudflareKvRestNamespace } from '@tslock/cloudflare-kv';

const provider = createCloudflareKvLockProvider({
  acknowledgeAdvisoryLock: true,
  kv: createCloudflareKvRestNamespace({
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID!,
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID!,
    apiToken: process.env.CLOUDFLARE_KV_API_TOKEN!,
  }),
});
```

## Configuration

| Option | Default | Description |
|---|---|---|
| `kv` | — | `KVNamespace` binding or REST namespace (`get` / `put` / `delete`). |
| `acknowledgeAdvisoryLock` | — | Must be `true`. |
| `keyPrefix` | `tslock:` | Prepended to the lock name. Storage key must be 1..512 UTF-8 bytes. |
| `confirmWrite` | `true` | Re-read after `put`. Mismatch returns “not acquired” and does not delete. |

Records are JSON: `{ lockUntil, lockedAt, lockedBy, token }`. `token` is the ownership id for unlock and extend. `lockedBy` is the hostname and is not an ownership check.

`expirationTtl` is `max(60, floor(remainingMs / 1000) + 1)`. Acquire and extend compare `lockUntil` to `ClockProvider.now()`, not to whether the key exists.

## Tests

Unit and shared extensible contracts use an in-memory namespace (fresh reads). Failure-mode tests cover two cached misses, a delayed delete, the TTL floor (`MutableClock`), write-rate rejection, and a stale unlock that deletes a newer holder.

Miniflare / Wrangler is not part of CI. Real KV will not satisfy “exactly one winner” or sub-second unlock/reacquire.

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
