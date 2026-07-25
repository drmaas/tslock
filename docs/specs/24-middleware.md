# Spec: Web Framework Middleware Integrations

## Overview

This spec defines TSLock's web framework middleware integrations — packages that provide drop-in middleware/plugins for Express, Fastify, Koa, and Hono. Each middleware automatically acquires a distributed lock around an HTTP request handler, enforcing at-most-once execution per lock name across application instances. If the lock is held by another instance, the middleware responds with a configurable HTTP status (default: 503 Service Unavailable) with a `Retry-After` header.

**Status:** v2 — deferred from v1 per vision doc, but spec/plan written early for exploration. Core must be stable before implementation.

## Packages

| Package | Framework | Dependencies |
|---|---|---|
| `@tslock/middleware-core` | (none — shared logic) | `@tslock/core` only |
| `@tslock/express` | Express 4.x / 5.x | `@tslock/core`, `@tslock/middleware-core`, `express` (peer) |
| `@tslock/fastify` | Fastify 5.x | `@tslock/core`, `@tslock/middleware-core`, `fastify` (peer) |
| `@tslock/koa` | Koa 2.x | `@tslock/core`, `@tslock/middleware-core`, `koa` (peer) |
| `@tslock/hono` | Hono 4.x | `@tslock/core`, `@tslock/middleware-core`, `hono` (peer) |

All framework adapter packages are thin — the heavy lifting lives in `@tslock/middleware-core`.

## Architecture

```
@tslock/middleware-core  (shared: lock-name derivation, config merging, lock lifecycle, error response)
   ├── @tslock/express   (extract method+path from req, express middleware signature)
   ├── @tslock/fastify   (extract method+path from request, fastify preHandler plugin)
   ├── @tslock/koa       (extract method+path from ctx, koa middleware signature)
   └── @tslock/hono      (extract method+path from c.req, hono middleware signature)
```

Each adapter:
1. Extracts `method` and `path` from the framework's request object.
2. Derives a lock name.
3. Constructs a `LockConfiguration` from merged global + per-route config.
4. Calls `lockProvider.lock(config)` via the shared `LockMiddlewareLifecycle`.
5. If acquired: provides a framework-specific `runHandler` promise to the lifecycle, which dispatches the handler and resolves when the framework response completes. The lifecycle delegates to `DefaultLockingTaskExecutor`, which calls `lock.unlock()` in its `finally` block — **adapters never unlock themselves.**
6. If not acquired: sends the failure response (503 by default), does NOT execute the downstream handler.

## Public API

### 1. `@tslock/middleware-core`

This package is NOT installed directly by end users. It is a dependency of the framework adapter packages.

```typescript
interface MiddlewareConfig {
  lockProvider: LockProvider;
  lockAtMostFor?: DurationInput;    // default: parseDuration('30s')
  lockAtLeastFor?: DurationInput;   // default: parseDuration('0s')
  lockNamePrefix?: string;          // default: ''
  defaultLockedStatus?: number;     // default: 503
  defaultLockedBody?: unknown | ((meta: LockFailureResponse) => unknown);  // default: produces { error: '...', lockName, lockedBy, retryAfterSeconds }
  lockNameStrategy?: LockNameStrategy;  // default: methodPathStrategy
}

interface RouteLockConfig {
  name?: string;                     // override auto-derived name entirely
  lockAtMostFor?: DurationInput;     // override global default
  lockAtLeastFor?: DurationInput;    // override global default
  lockedStatus?: number;             // override global default
  lockedBody?: unknown | ((meta: LockFailureResponse) => unknown);  // override global default
}

type LockNameStrategy = (method: string, path: string) => string;

function methodPathStrategy(method: string, path: string): string;

interface MiddlewareLockResult {
  wasExecuted: boolean;
}

interface LockMiddlewareMetadata {
  lockName: string;
  lockUntil: number;        // epoch millis — when the lock expires
  lockedBy: string;
  lockAcquired: boolean;
  lockPresent: boolean;     // true when a lock was present (even if by another instance)
}
```

**Factory function (internal — used by adapter packages):**

```typescript
interface LockRequestContext {
  method: string;
  path: string;
}

// Framework adapters provide this to core. Core handles lock/response logic.
interface LockMiddlewareLifecycle {
  // Called by the adapter to run the lock-and-execute cycle
  executeWithLock(
    ctx: LockRequestContext,
    routeConfig: RouteLockConfig,
    runHandler: () => Promise<void>,
    sendLockedResponse: (result: LockFailureResponse) => Promise<void>,
  ): Promise<MiddlewareLockResult>;
}

interface LockFailureResponse {
  status: number;
  body: unknown;
  headers: Record<string, string>;   // includes Retry-After, Lock-Name, Locked-By
  lockName: string;
  lockedBy: string;
  lockUntil: number;
  retryAfterSeconds: number;
}

function createLockMiddlewareLifecycle(
  config: MiddlewareConfig,
): LockMiddlewareLifecycle;
```

**Lock name derivation default:**

`methodPathStrategy('GET', '/api/users')` → `"GET:/api/users"`

When a `lockNamePrefix` is set: `methodPathStrategy('GET', '/api/users')` + prefix `"myapp"` → `"myapp:GET:/api/users"`.

Users can provide a custom `lockNameStrategy` that ignores method and path entirely (e.g., returns a fixed string based on request headers or body).

### 2. `@tslock/express`

```typescript
import type { LockProvider } from '@tslock/core';
import type { MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';

interface ExpressLockFactory {
  // Returns middleware for use as app.use() or route handler
  (routeConfig?: RouteLockConfig): express.RequestHandler;

  // Direct access to internal resources
  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

function createExpressLock(config: MiddlewareConfig): ExpressLockFactory;
```

**Usage:**

```typescript
const tslock = createExpressLock({ lockProvider, lockAtMostFor: '30s' });

// Auto-derive lock name: method + path
app.get('/api/users', tslock(), handler);

// Per-route overrides
app.post('/api/users', tslock({ lockAtMostFor: '1m', lockAtLeastFor: '5s' }), handler);

// Custom lock name
app.delete('/api/users/:id', tslock({ name: 'user-mutation' }), handler);
```

**Lock name derivation:** Uses `req.method` and `req.path` (from Express, which is the matched route path, not the full URL). For Express, `req.path` gives `/api/users` (not `/api/users/123`). This means parameterized routes like `/api/users/:id` get a consistent lock name across different ID values — which is typically the desired behavior for protecting the endpoint.

**Handler execution (`runHandler` promise):** The adapter wraps Express's callback-based `next()` in a Promise that resolves after the response is sent. This promise is passed to `LockMiddlewareLifecycle.executeWithLock()` as the `runHandler` callback. The lifecycle delegates to `DefaultLockingTaskExecutor`, which calls `lock.unlock()` in its `finally` block after the `runHandler` promise settles. The adapter itself never calls unlock.

```typescript
const runHandler = () => new Promise<void>((resolve, reject) => {
  let settled = false;
  const onFinish = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
  const onClose = () => { if (!settled) { settled = true; cleanup(); resolve(); } };

  // Prevent handler hangs from holding the lock forever
  const timeout = setTimeout(() => {
    if (!settled) { settled = true; cleanup(); resolve(); }
  }, lockConfig.lockAtMostFor);

  const cleanup = () => {
    clearTimeout(timeout);
    res.off('finish', onFinish);
    res.off('close', onClose);
  };

  res.on('finish', onFinish);
  res.on('close', onClose);
  next(); // Express dispatches the route handler synchronously within this tick
});
```

**Key behaviors of this pattern:**
- `next()` calls the route handler synchronously within the same event-loop tick, so the `AsyncLocalStorage.run()` context from `DefaultLockingTaskExecutor` is active during handler execution — `LockAssert.assertLocked()` works inside the handler.
- The `finish` event fires after the response body is flushed to the client. The promise resolves, the executor's `finally` block calls `lock.unlock()`, and the lock is released. Downstream clients can now acquire the lock.
- The `close` event covers client disconnects (browser tab closed, network error). If the handler already sent a response, `finish` fires first; if the connection drops before a response, only `close` fires. The `settled` flag prevents double-resolution.
- The `lockAtMostFor`-based timeout guarantees the promise resolves (and the executor's finally block unlocks) even if the handler never sends a response and the connection stays open. The `clearTimeout` prevents the timeout from firing after `finish`/`close` already resolved.

**Express 4.x limitation:** Express 4.x does not catch unhandled promise rejections from async route handlers — if an async handler throws after calling `res.json()`, the process crashes before `finish` fires, and the lock stays held until its `lockAtMostFor` expiry. Use Express 5.x or the `express-async-errors` package for async handlers.

**On lock failure:** `res.status(status).set(headers).json(body)`. Does NOT call `next()`.

### 3. `@tslock/fastify`

```typescript
import type { FastifyPluginCallback } from 'fastify';
import type { MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';

interface FastifyLockFactory {
  // Returns a preHandler hook for route registration
  (routeConfig?: RouteLockConfig): FastifyPreHandler;

  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

function createFastifyLockPlugin(config: MiddlewareConfig): FastifyPluginCallback;
```

**Usage:**

```typescript
import { createFastifyLockPlugin } from '@tslock/fastify';

fastify.register(createFastifyLockPlugin({ lockProvider, lockAtMostFor: '30s' }), { name: 'tslock' });

// After registration, the `tslock` decorator is available on fastify
const tslock = fastify.tslock;

fastify.get('/api/users', { preHandler: tslock() }, handler);
fastify.post('/api/users', { preHandler: tslock({ lockAtMostFor: '1m' }) }, handler);
```

**Route-level lock name derivation:** Uses `request.method` and `request.raw.url` (or `request.routeOptions.url` — the registered route pattern). Fastify's `request.routeOptions.url` gives the pattern for parameterized routes (`/api/users/:id`).

**Handler execution (`runHandler` promise):** Fastify's `preHandler` hook receives a `done` callback that signals the hook is complete. The hook IS NOT the handler — the handler runs AFTER `done()` is called. The `runHandler` promise must therefore resolve on the `reply` completion, not on `done()`.

```typescript
const runHandler = () => new Promise<void>((resolve) => {
  done(); // allow Fastify to dispatch the route handler
  reply.then(() => resolve()); // resolve when the reply is fully sent
});
```

Fastify's `reply` is a thenable that resolves after the response is sent. If the handler throws, `reply.send(err)` or the error handler sends a response, and `reply` still resolves. The `done()` callback fires immediately so Fastify can invoke the route handler; the promise will resolve later when the `reply` completes.

**On lock failure:** `reply.status(status).headers(headers).send(body)`. Does NOT call the handler or `done()`.

The Fastify plugin uses `fastify.decorate('tslock', factory)` to expose the middleware factory on the Fastify instance. If TSLock is not registered, accessing `fastify.tslock` throws.

### 4. `@tslock/koa`

```typescript
import type { Middleware, Context } from 'koa';
import type { MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';

interface KoaLockFactory {
  (routeConfig?: RouteLockConfig): Middleware;

  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

function createKoaLock(config: MiddlewareConfig): KoaLockFactory;
```

**Usage:**

```typescript
const tslock = createKoaLock({ lockProvider, lockAtMostFor: '30s' });

router.get('/api/users', tslock(), handler);
router.post('/api/users', tslock({ lockAtMostFor: '1m' }), handler);
```

**Lock name derivation:**

**Handler execution (`runHandler` promise):** Koa middleware is async (`await next()`). The `runHandler` promise is simply `await next()` inside a `try/finally`. Koa's middleware stack resolves `next()` only after ALL downstream middleware complete (including the route handler setting `ctx.body`). This is the simplest adapter:

```typescript
const runHandler = async () => { await next(); };
```

The executor's `finally` block unlocks after `next()` resolves. The body may not be flushed to the socket at this point (Koa defers writing until after the top-level middleware returns), but that's acceptable — another instance attempting to acquire the lock will go through a network round-trip to the lock store, which takes more time than the local socket write.

**Lock name derivation:** Uses `ctx.method` and `ctx.path` (the raw URL pathname). If `koa-router` (or `@koa/router`) is used, `ctx._matchedRoute` contains the registered route pattern (e.g., `/api/users/:id`), enabling endpoint-based (not per-ID) lock names. Without `koa-router`, lock names are derived from raw paths — `/api/users/123` and `/api/users/456` produce different lock names. For endpoint-level locking without koa-router, provide a custom `lockNameStrategy` or explicit `name` override.

**On lock failure:** `ctx.status = status; ctx.body = body; ctx.set(headers)`. Does NOT call `next()`.

### 5. `@tslock/hono`

```typescript
import type { Context, Next } from 'hono';
import type { MiddlewareConfig, RouteLockConfig } from '@tslock/middleware-core';
import type { MiddlewareHandler } from 'hono/types';

interface HonoLockFactory {
  (routeConfig?: RouteLockConfig): MiddlewareHandler;

  lockProvider: LockProvider;
  config: MiddlewareConfig;
}

function createHonoLock(config: MiddlewareConfig): HonoLockFactory;
```

**Usage:**

```typescript
const tslock = createHonoLock({ lockProvider, lockAtMostFor: '30s' });

app.get('/api/users', tslock(), (c) => c.text('ok'));
app.post('/api/users', tslock({ lockAtMostFor: '1m' }), (c) => c.text('created'));
```

**Lock name derivation:** Uses `c.req.method` and `c.req.routePath` (the registered route pattern). Hono 4.x populates `c.req.routePath` after route matching — it is available when middleware is attached to a specific route handler (e.g., `app.get('/api/users/:id', tslock(), handler)`), but may be `undefined` or `'/*'` when middleware is attached globally (`app.use('*', tslock())`). Fall back to `c.req.path` if `routePath` is not a meaningful route pattern.

**Handler execution (`runHandler` promise):** Hono middleware is async (`await next()`). Same pattern as Koa — the `runHandler` is simply `await next()`.

**On lock failure:** Return `c.json(body, status)` with appropriate headers. Does NOT call `next()`.

## Configuration Merging

Route-level config overrides global config field-by-field. Null/undefined route values fall back to the global default.

```
effectiveStatys = routeConfig.lockedStatus ?? globalConfig.defaultLockedStatus
effectiveAtMostFor = routeConfig.lockAtMostFor ?? globalConfig.lockAtMostFor
effectiveLockName = routeConfig.name ?? lockNameStrategy(method, path)
```

If neither global nor route config specifies `lockAtMostFor`, the hard default is 30 seconds.

## Lock Failure Response

When the lock cannot be acquired (held by another instance):

**Default (503):**

```
HTTP/1.1 503 Service Unavailable
Retry-After: <seconds until lock expires>
Lock-Name: <lock name>
Locked-By: <hostname of lock holder>
Content-Type: application/json

{
  "error": "Resource locked by another instance",
  "lockName": "GET:/api/users",
  "lockedBy": "app-server-2",
  "retryAfterSeconds": 27
}
```

The `Retry-After` value is calculated as `Math.ceil((lockUntil - now) / 1000)` — seconds until the current lock expires.

**Configurable:**

- `lockedStatus`: any HTTP status code (typically 503, 423, or 409).
- `lockedBody`: a static JSON-serializable value (`unknown`) or a function `(meta: LockFailureResponse) => unknown` that receives lock metadata and returns a body. The function form is useful for including dynamic `retryAfterSeconds` or `lockName` in the response body.

```typescript
// static body
lockedBody: { error: 'try again later' }

// dynamic body — includes lock metadata in the response
lockedBody: (meta) => ({
  error: `Locked until ${new Date(meta.lockUntil).toISOString()}`,
  retryIn: meta.retryAfterSeconds,
})
```

Actually, this is getting complex. Let me simplify: `lockedBody` is `unknown`. If a function is provided, it's called with `(metadata)` and the return value is sent as the body. Simple.

## Error Handling

| Situation | Behavior |
|---|---|
| Lock acquired | Execute handler. Unlock on response finish/finally. Normal response. |
| Lock held by another instance | Send failure response (503). Do NOT execute handler. |
| `lockProvider.lock()` throws (storage error) | Propagate to framework's error handler (Express: `next(err)`, Fastify: reply with 500, Koa: throw, Hono: throw). The handler is NOT executed. |
| `lock.unlock()` throws | Caught and logged. The response is already sent. The lock will expire via `lockAtMostFor`. |
| Handler throws | For Express/Fastify: error propagates to framework error handler. For Koa/Hono: `await next()` re-throws, caught in try/catch, unlock in finally. Lock is always released. |
| Unlock fails + handler threw | Handler error propagates. Unlock error is logged and discarded (don't mask handler error). |

## Lock Lifecycle per Request

```
┌─────────────────────────────────────────────────────┐
│ Request arrives                                       │
│   │                                                   │
│   ├─ Extract method + path                            │
│   ├─ Derive lock name                                 │
│   ├─ Merge global + route config                      │
│   ├─ Create LockConfiguration                         │
│   ├─ lockProvider.lock(config)                        │
│   │                                                   │
│   ├─ lock acquired?                                      │
│   │   ├─ YES → execute handler                        │
│   │   │    └─ on response finish: lock.unlock()       │
│   │   │                                               │
│   │   └─ NO → send 503 response                       │
│   │        └─ headers: Retry-After, Lock-Name          │
│   │        └─ body: error payload                      │
└─────────────────────────────────────────────────────┘
```

## LockAssert & LockExtender Integration

Middleware routes through `DefaultLockingTaskExecutor` internally so that:

- `LockAssert.assertLocked()` works inside the handler.
- `LockExtender.extendActiveLock()` works inside the handler.
- `LockAssert.alreadyLockedBy(name)` works across nested middleware on the same route.

**Reentrancy:** If nested middleware triggers another lock request for the same name (e.g., inner middleware on a sub-route, or a service call that also locks), the reentrancy check in `DefaultLockingTaskExecutor` skips re-acquisition and runs the handler directly.

The `DefaultLockingTaskExecutor` is created once at `create<Framework>Lock()` time and reused for all requests.

## Edge Cases

| Edge Case | Behavior |
|---|---|
| **Multiple middleware on same route** | Each middleware instance acquires a separate lock (different lock name or same name → reentrancy kicks in for same name). |
| **Parameterized routes** | Routes like `/api/users/:id` derive a single lock name `GET:/api/users/:id` (not per-ID). This protects the endpoint, not individual resources. For per-resource locking, use a custom `lockNameStrategy` or `name` override. |
| **Wildcard routes** | Routes like `/api/*` derive `GET:/api/*`. The framework's matched path determines the lock name. |
| **Sub-apps / nested routers** | Lock applies at the route level where middleware is attached. Nested routers require middleware on each sub-route. |
| **Body parsing** | Lock acquisition happens before body parsing (middleware order matters). If body parsing is slow, consider moving tslock after body parsers. |
| **Request with no matching route** | The framework handles 404 before tslock middleware runs (if placed after route registration). If tslock is global middleware, it runs for all requests including 404s — but the lock name derived from path still protects the path. |
| **Zero-duration `lockAtMostFor`** | Allowed for "fire-and-forget" style: lock is acquired and immediately expired/unlocked. Useful for purely sequential requests that shouldn't overlap even briefly. |
| **Concurrent requests to same route (same instance)** | The second request sees the lock held (by the first request on the same instance) and returns 503. This is correct — at-most-once execution. |
| **Slow handler exceeds `lockAtMostFor`** | The lock expires while the handler is still running. Unlock may fail (lock already gone). Another instance may acquire the lock. The handler continues to run. Mitigation: use `KeepAliveLockProvider` or set `lockAtMostFor` longer than expected handler duration. |
| **Client disconnects before response** | The `close` event on `res` fires, triggering unlock. Lock is released even if the response was never sent. |

## File Structure

```
packages/middleware-core/
├── src/
│   ├── index.ts                     # public exports
│   ├── middleware-config.ts         # MiddlewareConfig, RouteLockConfig, config merging
│   ├── lock-name-strategy.ts        # LockNameStrategy, methodPathStrategy
│   ├── middleware-lifecycle.ts      # createLockMiddlewareLifecycle, LockMiddlewareLifecycle
│   ├── lock-metadata.ts             # LockMetadata, LockMiddlewareMetadata, LockFailureResponse
│   └── default-locked-body.ts       # defaultLockedBodyFactory
├── __tests__/
│   ├── middleware-config.test.ts
│   ├── lock-name-strategy.test.ts
│   └── middleware-lifecycle.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/express/
├── src/
│   ├── index.ts                     # createExpressLock
│   └── express-lock-factory.ts
├── __tests__/
│   ├── express-lock.unit.test.ts
│   └── express-lock.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/fastify/
├── src/
│   ├── index.ts                     # createFastifyLockPlugin
│   └── fastify-lock-plugin.ts
├── __tests__/
│   ├── fastify-lock.unit.test.ts
│   └── fastify-lock.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/koa/
├── src/
│   ├── index.ts                     # createKoaLock
│   └── koa-lock-factory.ts
├── __tests__/
│   ├── koa-lock.unit.test.ts
│   └── koa-lock.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts

packages/hono/
├── src/
│   ├── index.ts                     # createHonoLock
│   └── hono-lock-factory.ts
├── __tests__/
│   ├── hono-lock.unit.test.ts
│   └── hono-lock.integration.test.ts
├── package.json
├── tsconfig.json
└── tsup.config.ts
```

## Test Plan

### Unit Tests (middleware-core)

1. **`middleware-config.test.ts`:**
   - Global defaults apply when no route config provided
   - Route config overrides global field-by-field
   - Null/undefined route values fall back
   - `lockAtMostFor` default is 30s
   - `defaultLockedStatus` default is 503

2. **`lock-name-strategy.test.ts`:**
   - `methodPathStrategy('GET', '/api/users')` → `"GET:/api/users"`
   - Handles special characters in path
   - Handles empty path
   - Custom strategy function works

3. **`middleware-lifecycle.test.ts`:**
   - Lock acquired → handler runs → unlock called
   - Lock not acquired → handler skipped → failure response sent
   - `lockProvider.lock()` throws → error propagates
   - Handler throws → lock released in finally → error propagated
   - Reentrancy: same lock name in nested call → handler runs without re-acquiring
   - Merge config: route overrides global

### Unit Tests (per-framework adapters)

4. **`express-lock.unit.test.ts`:**
   - Extracts `method` and `path` from `req`
   - Lock failure sends 503 with correct body/headers
   - Lock success executes handler, unlocks on finish
   - Custom `lockedStatus` and `lockedBody` work
   - Error in `lock()` propagates via `next(err)`

5. **`fastify-lock.unit.test.ts`:**
   - Plugin decorates `fastify.tslock`
   - `preHandler` blocks handler when lock not acquired
   - `preHandler` allows handler when lock acquired
   - Custom status code sent on lock failure

6. **`koa-lock.unit.test.ts`:**
   - Extracts method and path from `ctx`
   - Lock failure sets `ctx.status` and `ctx.body`, does not call `next()`
   - Lock success calls `next()`, unlocks in finally

7. **`hono-lock.unit.test.ts`:**
   - Extracts method and routePath from `c.req`
   - Lock failure returns 503 response
   - Lock success calls `await next()`, unlocks in finally

### Integration Tests (per-framework)

Each framework adapter has a lightweight integration test that starts a real server (Express/Fastify/Koa/Hono) with the `InMemoryLockProvider`, sends HTTP requests, and verifies:

- **Lock acquired → 200:** First request executes handler, returns normal response.
- **Lock held → 503:** Second request (concurrent) gets 503 with `Retry-After`, `Lock-Name`, `Locked-By` headers.
- **Lock released → 200:** After first handler completes, third request executes.
- **Custom error response:** Overriding `lockedStatus` and `lockedBody` works.
- **Handler error → 500:** Handler throws, lock still released, next request acquires lock.
- **LockAssert integration:** Handler calls `LockAssert.assertLocked()` — does NOT throw. A separate request handler outside the middleware context calls `LockAssert.assertLocked()` and expects `LockException`. This is the canonical proof that `AsyncLocalStorage` context propagation works through each framework's middleware model.
- **Reentrancy:** Middleware applied at both app-level (`app.use('/api', tslock())`) and route-level (`app.get('/api/task', tslock(), handler)`) with the same lock name prefix. The inner middleware detects reentrancy (`LockAssert.alreadyLockedBy(name)`) and executes the handler without re-acquiring. Verify the handler runs exactly once.

### Shared Integration Test Contract

An abstract test suite in `@tslock/middleware-core` that all framework adapters extend, parameterized by a `startServer` callback. Each adapter provides its server bootstrap:

```typescript
abstract class AbstractMiddlewareIntegrationTest {
  abstract startServer(handler: (req, res) => void): Promise<Server>;
  abstract makeRequest(): Promise<Response>;
  // ...shared test cases
}
```

Actually, the request/response shapes differ too much across frameworks to share the integration test contract. Each adapter has its own integration test file with the same test cases but framework-specific HTTP client code.

## Dependencies

### `@tslock/middleware-core`
- **Runtime:** `@tslock/core`
- **Dev:** `typescript`, `tsup`, `vitest`, `@types/node`

### `@tslock/express`
- **Runtime:** `@tslock/core`, `@tslock/middleware-core`
- **Peer:** `express` (^4.0.0 || ^5.0.0)
- **Dev:** `express`, `@types/express`, `supertest` (for integration tests)

### `@tslock/fastify`
- **Runtime:** `@tslock/core`, `@tslock/middleware-core`
- **Peer:** `fastify` (^5.0.0)
- **Dev:** `fastify`, `light-my-request` (for integration tests — Fastify's built-in inject)

### `@tslock/koa`
- **Runtime:** `@tslock/core`, `@tslock/middleware-core`
- **Peer:** `koa` (^2.0.0)
- **Dev:** `koa`, `@types/koa`, `supertest`

### `@tslock/hono`
- **Runtime:** `@tslock/core`, `@tslock/middleware-core`
- **Peer:** `hono` (^4.0.0)
- **Dev:** `hono`

## Non-Goals

- **No framework-specific lock stores.** Middleware always delegates to a `LockProvider` — never bundles its own storage.
- **No authentication/authorization integration.** Deciding WHO can lock is the application's concern. The middleware only enforces at-most-once execution.
- **No request queuing.** Locked requests are rejected immediately (503), not queued. This matches the TSLock philosophy of skip-if-held.
- **No scheduler integration.** Middleware protects HTTP handlers, not scheduled tasks. Use `DefaultLockingTaskExecutor` directly for cron jobs.
- **No per-resource locking (e.g., per user ID).** The default strategy locks the endpoint, not individual resources. Users who need per-resource locking provide a custom `lockNameStrategy` that extracts the resource ID from the request.
- **No distributed rate limiting.** TSLock provides at-most-once, not N-per-second. Pair with a rate limiter for that use case.
- **No gRPC/GraphQL/WebSocket middleware.** v2 scope is HTTP middleware only. gRPC interceptors and WebSocket middleware can be added later.
- **No decorator/annotation support** (`@SchedulerLock` equivalent). API-driven only.
- **No metrics integration** (v2). The `LockingTaskExecutorListener` on core's `DefaultLockingTaskExecutor` is the extension point for wiring Prometheus, OpenTelemetry, etc. `MiddlewareConfig` does not expose a `listener` field in this spec, but it is a natural v2 addition — the `DefaultLockingTaskExecutor` created internally would accept it.
