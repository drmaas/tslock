# @tslock/koa

> TSLock middleware integration for Koa.

The Koa adapter acquires a lock before entering downstream middleware, returns a configurable lock-failure response when another request owns the lock, and releases the lock when the request completes.

## Installation

```bash
pnpm add @tslock/core @tslock/koa @tslock/in-memory koa
```

## Usage

```typescript
import Koa from 'koa';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createKoaLock } from '@tslock/koa';

const app = new Koa();
const tslock = createKoaLock({
  lockProvider: new InMemoryLockProvider(),
  lockAtMostFor: '30s',
});

app.use(tslock());
app.use((ctx) => {
  ctx.body = { ok: true };
});
```

The default lock name is derived from the HTTP method and request path. Configure `lockNamePrefix`, `lockAtMostFor`, `lockAtLeastFor`, or `defaultLockedStatus` through `createKoaLock`.

## Integration tests

The end-to-end suite uses a real Node HTTP server and covers acquisition, concurrent rejection, release and reacquisition, custom status codes, handler errors, `LockAssert`, and middleware reentrancy:

```bash
pnpm --filter @tslock/koa test:integration
```

## Requirements

- Node.js >= 22
- Peer: `koa`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
