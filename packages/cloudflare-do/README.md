# @tslock/cloudflare-do

> TSLock provider backed by [Cloudflare Durable Objects](https://developers.cloudflare.com/durable-objects/).

Strongly consistent, per-object serialized storage makes Durable Objects a good fit for ShedLock-style locks at the edge. **Use this package when overlapping execution is unacceptable.** [`@tslock/cloudflare-kv`](../cloudflare-kv/README.md) is a separate, explicitly best-effort provider: Workers KV is eventually consistent and has no compare-and-swap, so two holders are possible.

## Installation

```bash
pnpm add @tslock/core @tslock/cloudflare-do
```

## Architecture

1. Deploy `TslockLockDurableObject` (or call `handleTslockLockRequest` from your own DO class).
2. Prefer **one Durable Object per lock name** via `idFromName(lockName)` so unrelated locks do not serialize together.
3. From Workers or Node, use `createCloudflareDoLockProvider({ fetch })` where `fetch(lockName, init)` routes to that object (stub `.fetch` or an HTTP Worker URL).

## Worker sketch

```typescript
import { TslockLockDurableObject } from '@tslock/cloudflare-do';

export { TslockLockDurableObject };

// wrangler.toml: [[durable_objects.bindings]] name = "TSLOCK" class_name = "TslockLockDurableObject"

export default {
  async fetch(request: Request, env: { TSLOCK: DurableObjectNamespace }): Promise<Response> {
    const name = new URL(request.url).searchParams.get('name') ?? 'default';
    const id = env.TSLOCK.idFromName(name);
    return env.TSLOCK.get(id).fetch(request);
  },
};
```

## Client usage

```typescript
import { createLockConfig, DefaultLockingTaskExecutor } from '@tslock/core';
import { createCloudflareDoLockProvider } from '@tslock/cloudflare-do';

const provider = createCloudflareDoLockProvider({
  fetch: (lockName, init) =>
    fetch(`https://locks.example.workers.dev/?name=${encodeURIComponent(lockName)}`, init),
});

const executor = new DefaultLockingTaskExecutor(provider);
await executor.executeWithLock(
  () => myScheduledTask(),
  createLockConfig('my-task', '5m', '1m'),
);
```

Inside a Worker with a binding:

```typescript
createCloudflareDoLockProvider({
  fetch: (lockName, init) => {
    const id = env.TSLOCK.idFromName(lockName);
    return env.TSLOCK.get(id).fetch('https://do/lock', init);
  },
});
```

## Ownership and clocks

Unlock is a no-op when `lockedBy` does not match the caller, so a late unlock after expiry cannot release a new holder. The Durable Object compares stored `lockUntil` to its own `Date.now()` while new deadlines use client `createdAt` + durations — keep client and Worker clocks NTP-synced (same assumption as the rest of TSLock).

## Bun / Node

The client runs on Node.js >= 22 (and Bun when Node-compatible `fetch` is available). There is no Bun-only package. See the root [CONTRIBUTING.md](../../CONTRIBUTING.md) Bun notes.

## Exports

| Export | Description |
|---|---|
| `createCloudflareDoLockProvider`, `CloudflareDoLockProvider` | Client `ExtensibleLockProvider` |
| `TslockLockDurableObject` | Deployable DO class (duck-typed storage) |
| `handleTslockLockRequest`, `applyLockOp` | Protocol helpers for custom DO classes |
| `createMemoryDoLockStorage` | In-memory storage for tests |

## Requirements

- Node.js >= 22 for the client package build/runtime
- Cloudflare Workers + Durable Objects for production edge coordination

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
