# Implementation Plan: Web Framework Middleware Integrations

## Overview

This plan covers building 5 new packages: `@tslock/middleware-core` (shared middleware logic) + 4 framework adapters (`@tslock/express`, `@tslock/fastify`, `@tslock/koa`, `@tslock/hono`). These provide drop-in middleware that wraps HTTP handlers in distributed locks.

**Prerequisite:** `@tslock/core` must be implemented first (plan `00-core.md`). All middleware packages depend on it.

**Note:** Implementation is deferred until `@tslock/core` is stable per the v2 deferral in `docs/00-vision.md`. This plan exists to guide implementation when that time comes.

## Prerequisites

- `@tslock/core` package built and passing all tests
- pnpm workspace initialized at repo root
- `tsconfig.base.json` at repo root

## Steps

### Step 1: Initialize package structures

Create 5 packages with standard TSLock layout:

```
packages/middleware-core/
packages/express/
packages/fastify/
packages/koa/
packages/hono/
```

Each gets: `package.json`, `tsconfig.json`, `tsup.config.ts`, `src/index.ts` (placeholder).

**`package.json` template (middleware-core):**
```json
{
  "name": "@tslock/middleware-core",
  "version": "1.0.0",
  "description": "Shared middleware infrastructure for TSLock framework integrations",
  "license": "Apache-2.0",
  "type": "module",
  "main": "./dist/index.cjs",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "import": "./dist/index.js",
      "require": "./dist/index.cjs",
      "types": "./dist/index.d.ts"
    }
  },
  "files": ["dist"],
  "scripts": {
    "build": "tsup",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@tslock/core": "workspace:*"
  },
  "engines": { "node": ">=22" }
}
```

Framework adapter `package.json` template adds `@tslock/middleware-core: workspace:*` dependency and the framework as a peer dependency.

### Step 2: Implement `@tslock/middleware-core`

**File: `src/middleware-config.ts`**

- `MiddlewareConfig` interface: `lockProvider`, `lockAtMostFor?`, `lockAtLeastFor?`, `lockNamePrefix?`, `defaultLockedStatus?`, `defaultLockedBody?`, `lockNameStrategy?`
- `RouteLockConfig` interface: `name?`, `lockAtMostFor?`, `lockAtLeastFor?`, `lockedStatus?`, `lockedBody?`
- `resolveMiddlewareConfig(input: Partial<MiddlewareConfig> & { lockProvider: LockProvider }): MiddlewareConfig` — fills defaults, returns frozen object
- `mergeRouteConfig(global: MiddlewareConfig, route?: RouteLockConfig): ResolvedRouteConfig` — field-by-field override
- Defaults: `lockAtMostFor = 30_000`, `lockAtLeastFor = 0`, `defaultLockedStatus = 503`

**File: `src/lock-name-strategy.ts`**

- `LockNameStrategy` type: `(method: string, path: string) => string`
- `methodPathStrategy(method, path): string` — `"GET:/api/users"`
- Apply `lockNamePrefix`: if set, prepend `"<prefix>:"`

**File: `src/lock-metadata.ts`**

- `LockMetadata` interface: `lockName`, `lockedBy`, `lockUntil`, `retryAfterSeconds`
- `LockFailureResponse` interface: `status`, `body`, `headers`
- `defaultLockedBody(meta: LockMetadata): object` — `{ error: "...", lockName, lockedBy, retryAfterSeconds }`

**File: `src/middleware-lifecycle.ts`**

- `LockRequestContext` interface: `method`, `path`
- `LockMiddlewareLifecycle` interface: `executeWithLock(ctx, routeConfig, runHandler, sendLockedResponse)`
- `createLockMiddlewareLifecycle(config: MiddlewareConfig): LockMiddlewareLifecycle`
- Internal: creates a `DefaultLockingTaskExecutor` from the provided `lockProvider`
- `executeWithLock`:
  1. Derive lock name from `lockNameStrategy(method, path)` + optional prefix, or use `routeConfig.name`
  2. Merge configs
  3. Create `LockConfiguration` via `createLockConfig(name, lockAtMostFor, lockAtLeastFor)`
  4. Call `executor.executeWithLock(async () => { await runHandler(); }, lockConfig)`
  5. If `wasExecuted`: return `{ wasExecuted: true }`
  6. If `!wasExecuted`: compute `retryAfterSeconds`, build `LockFailureResponse`, await `sendLockedResponse(result)`, return `{ wasExecuted: false }`

### Step 3: Implement `@tslock/express`

**File: `src/express-lock-factory.ts`**

- `ExpressLockFactory` interface: callable `(routeConfig?) => RequestHandler` + `.lockProvider`, `.config`
- `createExpressLock(config: MiddlewareConfig): ExpressLockFactory`
- Internal `createMiddleware(thisFactory, routeConfig?)`:
  1. Extract `method = req.method` and `path = req.path`
  2. Call `lifecycle.executeWithLock(ctx, routeConfig, runHandler, sendLockedResponse)`
  3. `runHandler`: wraps Express's callback-based `next()` in a Promise with cleanup and timeout:
     ```typescript
     const runHandler = () => new Promise<void>((resolve, reject) => {
       let settled = false;
       const onFinish = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
       const onClose = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
       const timeout = setTimeout(() => { if (!settled) { settled = true; cleanup(); resolve(); } }, lockConfig.lockAtMostFor);
       const cleanup = () => {
         clearTimeout(timeout);
         res.off('finish', onFinish);
         res.off('close', onClose);
       };
       res.on('finish', onFinish);
       res.on('close', onClose);
       next(); // Express dispatches handler synchronously within this tick
     });
     ```
     The `settled` flag prevents double-resolution. The `lockAtMostFor` timeout prevents handler hangs from holding the lock permanently. `finish` fires after response flushed; `close` covers client disconnects. Handler executes synchronously within `next()` so `AsyncLocalStorage.run()` context is active during handler execution.
  4. `sendLockedResponse`: `res.status(status).set(headers).json(body)`
- Errors from `lock()`: call `next(err)`
- Errors from handler: don't catch — let Express error middleware handle it. The `res.on('close')` listener still fires for unlock.

**File: `src/index.ts`** — re-exports from express-lock-factory.

### Step 4: Implement `@tslock/fastify`

**File: `src/fastify-lock-plugin.ts`**

- `FastifyLockFactory` interface: callable `(routeConfig?) => preHandler`
- `createFastifyLockPlugin(config: MiddlewareConfig): FastifyPluginCallback`
- Plugin function:
  1. Call `fastify.decorate('tslock', factory)` — add `fastify.tslock` accessor
  2. Declare type augmentation via `fastify.decorate`
- Internal `createPreHandler(thisFactory, routeConfig?)`:
  1. Extract `method = request.method` and `path = request.routeOptions.url ?? request.url`
  2. Call `lifecycle.executeWithLock(ctx, routeConfig, runHandler, sendLockedResponse)`
  3. `runHandler`: `done()` is called immediately to allow Fastify to dispatch the route handler; the promise resolves on `reply` completion instead:
     ```typescript
     const runHandler = () => new Promise<void>((resolve) => {
       done(); // Fastify dispatches the route handler after this
       reply.then(() => resolve()); // reply is a thenable that resolves when response is sent
     });
     ```
     Fastify's `reply` is a thenable that resolves after the response is sent. If the handler throws, Fastify's error handler sends a response and `reply` still resolves. Do NOT resolve on `done()` — it fires before the handler starts, which would unlock before execution.
  4. `sendLockedResponse`: `reply.status(status).headers(headers).send(body)`
- Fastify needs a `.d.ts` module augmentation for the `tslock` decorator:

```typescript
// src/fastify.d.ts
declare module 'fastify' {
  interface FastifyInstance {
    tslock: FastifyLockFactory;
  }
}
```

**File: `src/index.ts`** — re-exports + exports the type augmentation.

### Step 5: Implement `@tslock/koa`

**File: `src/koa-lock-factory.ts`**

- `KoaLockFactory` interface: callable `(routeConfig?) => Middleware`
- `createKoaLock(config: MiddlewareConfig): KoaLockFactory`
- Internal `createMiddleware(thisFactory, routeConfig?)`:
  1. Extract `method = ctx.method` and `path = ctx.path` (or `ctx._matchedRoute` if available via koa-router)
  2. Call `lifecycle.executeWithLock(ctx, routeConfig, runHandler, sendLockedResponse)`
  3. `runHandler`: `await next()` — wrapped in try/catch; `await next()` resolves when downstream middleware complete
  4. `sendLockedResponse`: `ctx.status = status; ctx.set(headers); ctx.body = body`
- Handler errors: `await next()` throws → caught in `executeWithLock`'s try/finally → lock released
- Lock errors: thrown → caught by Koa's error handler (set `ctx.onerror`)

**File: `src/index.ts`** — re-exports.

### Step 6: Implement `@tslock/hono`

**File: `src/hono-lock-factory.ts`**

- `HonoLockFactory` interface: callable `(routeConfig?) => MiddlewareHandler`
- `createHonoLock(config: MiddlewareConfig): HonoLockFactory`
- Internal `createMiddleware(thisFactory, routeConfig?)`:
  1. Extract `method = c.req.method` and `path = c.req.routePath` (or `c.req.path` as fallback)
  2. Call `lifecycle.executeWithLock(ctx, routeConfig, runHandler, sendLockedResponse)`
  3. `runHandler`: `await next()`
  4. `sendLockedResponse`: `return c.json(body, status)` — Hono middleware can return a Response directly
- Hono's `c.req.routePath` is available in Hono 4.x for registered routes. For ad-hoc paths, fall back to `c.req.path`.
- Handler errors: `await next()` throws → caught in lifecycle → lock released in finally
- Lock errors: thrown → Hono's error handler catches

**File: `src/index.ts`** — re-exports.

### Step 7: Write unit tests

**middleware-core tests:**

7.1 `middleware-config.test.ts`:
- Defaults fill when partial config given
- Route config overrides global field-by-field
- Null/undefined route values fall back to global
- `lockAtMostFor` default = 30_000ms
- `defaultLockedStatus` default = 503

7.2 `lock-name-strategy.test.ts`:
- `methodPathStrategy('GET', '/api/users')` → `"GET:/api/users"`
- With prefix `"myapp"` → `"myapp:GET:/api/users"`
- With lowercase method → uppercased
- With empty path → `"GET:"`
- Custom strategy function produces expected name

7.3 `middleware-lifecycle.test.ts`:
- Mock `LockProvider` via `InMemoryProvider`
- Lock acquired → `runHandler` called, `sendLockedResponse` NOT called
- Lock not acquired (second concurrent lock for same name) → `runHandler` NOT called, `sendLockedResponse` called with 503
- `lockProvider.lock()` throws → error propagates, neither handler nor response called
- Handler throws → `sendLockedResponse` not called (error propagates)
- Config merge: route `lockAtMostFor` overrides global
- Custom `lockedStatus` → failure response uses custom status

**per-framework unit tests:**

7.4 `express-lock.unit.test.ts`:
- Mock `req`, `res`, `next`; mock `LockProvider`
- Extracts `req.method` and `req.path` for lock name
- Lock success: calls `next()`, unlocks on `res.emit('finish')`
- Lock failure: sends 503 with JSON body and `Retry-After` header, does NOT call `next()`
- `req.on('close')` also triggers unlock (fallback for aborted requests)
- Handler error: `next(err)` called by Express, lock still released on close/finish

7.5 `fastify-lock.unit.test.ts`:
- Mock `request`, `reply`; mock `LockProvider`, `done` callback
- Plugin registers `tslock` decorator
- Lock success: `done()` called immediately, `reply.then()` resolves → promise settles → executor unlocks
- Lock failure: `reply.status(503).headers(...).send(...)` called, `done()` NOT called
- Custom per-route config overrides global

7.6 `koa-lock.unit.test.ts`:
- Mock `ctx` (method, path, status, body, set, res); mock `LockProvider`, `next`
- Lock success: `await next()` called, returned normally
- Lock failure: `ctx.status = 503`, `ctx.body` set, `ctx.set(headers)` called, `next()` NOT called
- Lock error thrown: `ctx.onerror` receives error
- Handler throws: `await next()` rejects, caught in finally, lock released

7.7 `hono-lock.unit.test.ts`:
- Mock `c` (Context with req.method, req.routePath, json()); mock `LockProvider`, `next`
- Lock success: `await next()` called
- Lock failure: returns Response with 503 status, JSON body, headers
- Lock error thrown: error propagates

### Step 8: Write integration tests

Each framework adapter gets a lightweight integration test using `@tslock/in-memory` as the `LockProvider`. Tests spin up a real server, send HTTP requests, and assert responses.

8.1 `express-lock.integration.test.ts`:
```
- Start Express server with tslock middleware on GET /api/locked
- GET /api/locked → 200 (lock acquired, handler ran)
- Concurrent GET /api/locked → 503 with Retry-After, Lock-Name, Locked-By headers
- After first handler finishes → GET /api/locked → 200 again
- POST /api/locked (different method) → 200 (different lock name)
- Custom lockedStatus=423 → failure responds 423
- Custom lockedBody function → failure body matches
- LockAssert integration: handler calls LockAssert.assertLocked() → does NOT throw. Separate unprotected handler calls assertLocked() → throws LockException.
- Reentrancy: apply tslock at both app.use('/api', tslock()) and app.get('/api/task', tslock(), handler). Verify handler runs (reentrancy via alreadyLockedBy) and response is 200, not 503.
```

8.2 `fastify-lock.integration.test.ts`:
```
- Same test cases as Express, adapted for Fastify's inject()
- Use fastify.inject() for HTTP requests (no supertest needed)
- LockAssert and reentrancy tests included
```

8.3 `koa-lock.integration.test.ts`:
```
- Same test cases, adapted for Koa
- Use supertest or raw http.request
- LockAssert and reentrancy tests included
```

8.4 `hono-lock.integration.test.ts`:
```
- Same test cases, adapted for Hono
- Use Hono's built-in request() method for testing (no server needed)
- LockAssert and reentrancy tests included
```

### Step 9: Update pnpm-workspace.yaml

Add the 5 new packages to the workspace config (when the file is created during core implementation).

### Step 10: Verify

```bash
pnpm -r typecheck       # tsc --noEmit across all packages
pnpm -r lint            # Biome lint
pnpm -r test            # vitest run all unit tests
pnpm -r test:integration  # integration tests
pnpm -r build           # tsup build all packages
```

### Step 11: Documentation

- **README.md:** Add a "Middleware Integrations" section listing the 4 framework adapters with brief usage examples.
- **AGENTS.md:** Update the provider categories table to include a new category or section for middleware adapters. Update the package list.
- **`docs/00-vision.md`:** Move "Web framework integrations" from "Out of Scope (v1)" to "In Scope (v2)" section.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `res.on('finish')` vs `res.on('close')` for unlock timing | Listen for both. `finish` fires on normal completion; `close` fires on abort. Use a flag to avoid double-unlock. |
| Express `req.path` is route-matched path, not raw URL | This is actually desired behavior — parameterized routes get consistent lock names. Document this. |
| Fastify `request.routeOptions.url` may not be available in all hooks | Fall back to `request.raw.url` if `routeOptions` is undefined (e.g., for 404 requests). |
| Koa `ctx._matchedRoute` is set by `koa-router`, not built-in | Fall back to `ctx.path` if `_matchedRoute` is undefined. Document the difference. |
| Hono `c.req.routePath` behavior differs across Hono versions | Target Hono 4.x. If unavailable, fall back to `c.req.path`. |
| `DefaultLockingTaskExecutor` lifecycle vs middleware lifecycle mismatch | The executor's task model (sync callback → Promise<T>) doesn't map perfectly to middleware's continuation-passing style. For Express, wrap `next()` in a Promise resolved on response finish. |
| Unlock during error handling | If the handler AND unlock throw, preserve handler error, log unlock error. |

## Estimation

~10-15 source files, ~400-600 lines implementation + ~600-800 lines tests. Per-framework adapters are very thin (each ~30-50 lines of code). Most complexity is in `middleware-core`.

## Order of Implementation

1. `@tslock/middleware-core` package init
2. `middleware-config.ts` (config types + merging)
3. `lock-name-strategy.ts`
4. `lock-metadata.ts` (response types)
5. `middleware-lifecycle.ts` (core lock/execute logic)
6. `middleware-core` tests
7. `@tslock/express` (adapter + tests)
8. `@tslock/fastify` (adapter + tests)
9. `@tslock/koa` (adapter + tests)
10. `@tslock/hono` (adapter + tests)
11. Integration tests for all 4 adapters
12. Documentation updates
13. Full verification suite
