# @tslock/fastify

> TSLock middleware integration for Fastify.

The Fastify adapter acquires a lock in a route `preHandler`, returns a configurable lock-failure response when another request owns the lock, and releases the lock after the request completes.

## Installation

```bash
pnpm add @tslock/core @tslock/fastify @tslock/in-memory fastify
```

## Usage

```typescript
import Fastify from 'fastify';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { createFastifyLockPlugin } from '@tslock/fastify';

const app = Fastify();
await app.register(createFastifyLockPlugin({
  lockProvider: new InMemoryLockProvider(),
  lockAtMostFor: '30s',
}));

app.get('/reports', { preHandler: app.tslock() }, async () => ({ ok: true }));
```

The default lock name is derived from the HTTP method and route path. Configure `lockNamePrefix`, `lockAtMostFor`, `lockAtLeastFor`, or `defaultLockedStatus` through `createFastifyLockPlugin`.

## Integration tests

The end-to-end suite uses Fastify's real request injector and covers acquisition, concurrent rejection, release and reacquisition, method-specific names, custom status codes, handler errors, `LockAssert`, and middleware reentrancy:

```bash
pnpm --filter @tslock/fastify test:integration
```

## Requirements

- Node.js >= 22
- Peer: `fastify`

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
