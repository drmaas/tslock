# @tslock/hono

> TSLock middleware integration for Hono.

The Hono adapter acquires a lock before entering the route handler, returns a configurable lock-failure response when another request owns the lock, and releases the lock after the request completes.

## Installation

```bash
pnpm add @tslock/core @tslock/hono @tslock/in-memory hono
```

## Usage

```typescript
import { Hono } from 'hono';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createHonoLock } from '@tslock/hono';

const app = new Hono();
const tslock = createHonoLock({
  lockProvider: new InMemoryLockProvider(),
  lockAtMostFor: '30s',
});

app.get('/reports', tslock(), (c) => c.json({ ok: true }));
```

The default lock name is derived from the HTTP method and request path. Configure `lockNamePrefix`, `lockAtMostFor`, `lockAtLeastFor`, or `defaultLockedStatus` through `createHonoLock`.

## Integration tests

The end-to-end suite uses Hono's request interface and covers acquisition, concurrent rejection, release and reacquisition, method-specific names, custom status codes, handler errors, `LockAssert`, and middleware reentrancy:

```bash
pnpm --filter @tslock/hono test:integration
```

## Requirements

- Node.js >= 22
- Peer: `hono`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
