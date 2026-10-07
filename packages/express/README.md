# @tslock/express

> TSLock middleware integration for Express.js.

The Express adapter acquires a lock before entering a route handler, returns a configurable lock-failure response when another request owns the lock, and releases the lock when the response finishes or the client disconnects.

## Installation

```bash
pnpm add @tslock/core @tslock/express @tslock/in-memory express
```

## Usage

```typescript
import express from 'express';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createExpressLock } from '@tslock/express';

const app = express();
const tslock = createExpressLock({
  lockProvider: new InMemoryLockProvider(),
  lockAtMostFor: '30s',
});

app.get('/reports', tslock(), (_req, res) => {
  res.json({ ok: true });
});
```

The default lock name is derived from the HTTP method and the matched Express route pattern (`req.baseUrl` + `req.route.path` when a route is matched; otherwise `req.baseUrl` + `req.path`). The path is lowercased when `case sensitive routing` is off and a trailing slash is stripped when `strict routing` is off — matching Express defaults — so `/run`, `/RUN`, and `/run/` share one lock, and `/jobs/:id` shares one lock across ids. Configure `lockNamePrefix`, `lockAtMostFor`, `lockAtLeastFor`, `defaultLockedStatus`, or a custom locked response through `createExpressLock`.

**Upgrade note:** parameterized routes previously locked per concrete path (`GET:/jobs/1`). After upgrading they lock on the pattern (`GET:/jobs/:id`). Old per-id lock records may remain until they expire; they are unused by the new names.

## Integration tests

The end-to-end suite starts a real Node HTTP server and exercises concurrent requests, lock release, handler errors, `LockAssert`, method-specific names, custom status codes, and middleware reentrancy:

```bash
pnpm --filter @tslock/express test:integration
```

## Requirements

- Node.js >= 22
- Peer: `express`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
