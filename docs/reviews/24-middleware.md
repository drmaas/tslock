# Review: Web Framework Middleware Integrations

**Spec:** `docs/specs/24-middleware.md`
**Plan:** `docs/plans/24-middleware.md`

## Overview

The middleware design follows the shared-core + thin-adapters pattern established by `@tslock/sql-support` + `@tslock/sql` and `@tslock/redis-core` + `@tslock/redis`: a `@tslock/middleware-core` package holds all lock/response/derivation logic, and four framework adapter packages (`@tslock/express`, `@tslock/fastify`, `@tslock/koa`, `@tslock/hono`) wrap that shared core with framework-specific request-extraction and response-sending glue. This is the right architecture. However, the spec has several underspecified critical areas around `DefaultLockingTaskExecutor` integration, unlock timing, Express promise-wrapping, and the `lockedBody` type. The plan is mostly thorough but omits concrete implementation details for the Express `runHandler` promise and doesn't address Handler timeout. The design is sound but needs specification tightening before implementation.

## Architecture Alignment — NEEDS REVISION

**Shared-core + thin-adapters pattern: PASS.** `@tslock/middleware-core` depends only on `@tslock/core`; each adapter depends on `@tslock/middleware-core` + its framework peer dep. No adapter depends on another adapter. This mirrors the `sql-support`/`redis-core` pattern correctly.

**Dependency rules: PASS.** No provider depends on another provider. All adapters depend on `@tslock/core` + `@tslock/middleware-core` + framework peer dep. Correct.

**Use of `DefaultLockingTaskExecutor`: FAILS — two related problems.**

**Problem 1: Executor unlock vs adapter unlock conflict.** The spec says each adapter uses a "response-on-finish hook" for unlock (e.g., Express: `res.on('finish', ...).unlock()`), but the `LockMiddlewareLifecycle` delegates to `DefaultLockingTaskExecutor.executeWithLock()`, which also calls `lock.unlock()` in its `finally` block. If both exist, there's a double-unlock that causes the second call to throw `LockException('Lock already released')`. The plan's Step 3 resolves this implicitly: Express's `runHandler` wraps `next()` in a Promise that resolves on `finish`/`close`, so the executor's `finally` block is the SOLE unlock path, and the adapter does not separately unlock. The spec's "response-on-finish hook" phrasing for each framework is therefore misleading — it's actually a "response-on-finish Promise resolution," not a response-on-finish unlock. **Fix:** Rewrite the per-framework sections to clearly distinguish "when does the runHandler promise resolve" from "when is unlock called." Unlock is always called in the executor's `finally` block. The adapter's job is PURELY to make the `runHandler` promise resolve at the right time for that framework.

**Problem 2: Express `next()` promise-wrapping is dangerously underspecified.** Express's `next()` is callback-based and returns `void`. The spec and plan say "wrap `next()` in a Promise" but neither details how. The obvious approach — `new Promise(resolve => { next(); resolve(); })` — resolves IMMEDIATELY after `next()` returns, which is when the synchronous chain of middleware/handlers returns. For a synchronous handler `(req, res) => { res.json({...}) }`, `next()` dispatches the handler synchronously, the handler calls `res.json()`, `next()` returns, and the promise resolves BEFORE `res.json()` has flushed headers to the socket. The executor's `finally` block would then call `lock.unlock()` BEFORE the client receives the response — defeating the purpose (another instance could acquire the lock and respond while the first instance's response is still in-flight).

The plan's approach — `next()` plus listen for `res.on('finish')`/`res.on('close')` to resolve — is correct in concept. But:

- **No implementation detail is provided.** How does the middleware reconcile the fact that `next()` must be called to dispatch the handler, but the promise must not resolve until `finish` fires? The handler cannot be dispatched within the same event-loop tick as the lock acquisition without both happening within the `AsyncLocalStorage.run()` context — which requires that the handler's synchronous execution happens INSIDE the `runHandler` callback. This imposes a specific promise shape:
  ```ts
  const runHandler = () => new Promise<void>((resolve, reject) => {
    const onFinish = () => { cleanup(); resolve(); };
    const onClose = () => { cleanup(); resolve(); };
    const cleanup = () => { res.off('finish', onFinish); res.off('close', onClose); };
    res.on('finish', onFinish);
    res.on('close', onClose);
    next(); // Express calls the handler SYNCHRONOUSLY within this tick
  });
  ```
  This shape is subtle: the handler runs synchronously within `next()` (so `LockAssert` works), but the promise doesn't resolve until the response is flushed. The spec and plan should include this implementation detail.

- **Express 4.x vs 5.x async handler behavior is unaddressed.** Express 4.x does NOT catch unhandled promise rejections from async handlers (it crashes the process). Express 5.x does. A user with Express 4.x and an async handler that throws after calling `res.json()` would crash before `finish` fires, the promise never resolves, and the lock stays held until `lockAtMostFor` expires. The spec should document this and recommend Express 5.x or `express-async-errors` for async handlers.

- **`res.on('close')` fires on client abort even when `finish` already fired.** Using a shared cleanup flag to avoid double-resolve is correct, but the plan's risk table only mentions "avoid double-unlock" — not double-resolve of the promise. Fine since both lead to the same issue.

- **Handler never calls `res.send()`/`res.json()`/etc.** Neither `finish` nor `close` fires (if the connection stays open). The `runHandler` promise hangs forever. The lock stays held until `lockAtMostFor` expiration, but the request is effectively leaked. The spec should add a handler timeout matching `lockAtMostFor` to reject the promise and release the lock.

**Verdict on architecture alignment: NEEDS REVISION.** The structural architecture (shared-core + adapters) is correct, but the integration with `DefaultLockingTaskExecutor`'s unlock lifecycle needs clarification, and the Express `runHandler` promise-wrapping needs concrete specification.

## Spec Alignment — NEEDS REVISION

### Strengths

- **Config merging: well-defined.** `RouteLockConfig` field-by-field overrides `MiddlewareConfig`, with `??` fallback. Defaults (30s `lockAtMostFor`, 0 `lockAtLeastFor`, 503 status) are clear.
- **Lock name derivation: well-defined.** `methodPathStrategy` produces `"GET:/api/users"`; `lockNamePrefix` prepends; custom `LockNameStrategy` functions are supported. Edge cases (empty path → `"GET:"`) are covered.
- **Error handling table: comprehensive.** Seven scenarios covering lock acquired, held, storage errors, unlock failures, handler throws, and interaction between handler+unlock errors. Consistent with the core error philosophy (unlock failures logged, handler errors propagated).
- **Edge cases table: thorough.** Covers parameterized routes, wildcard routes, sub-apps, body parsing ordering, zero-duration locks, concurrent same-instance requests, slow handler overflow, and client disconnect.

### Issues

**1. `lockedBody` type is internally inconsistent (MEDIUM).** The `MiddlewareConfig` interface defines `defaultLockedBody?: unknown`. Later, the spec introduces `LockedBodyProvider: (meta: LockMetadata) => unknown` and says "If a function is provided, it's called with `(metadata)` and the return value is sent as the body." But then the spec self-corrects with "Actually, this is getting complex. Let me simplify: `lockedBody` is `unknown`." — yet the `LockedBodyProvider` type remains defined and isn't used in the final `MiddlewareConfig`. The per-route `lockedBody?: unknown` similarly doesn't mention the function form. **Fix:** Remove `LockedBodyProvider` and `LockMetadata` from the public API, or commit to the function form: `lockedBody?: unknown | ((meta: LockFailureResponse) => unknown)`. The `defaultLockedBody` factory function produces the default body but is typed as `unknown` in the config — this needs to be resolved.

**2. Hono `c.req.routePath` availability is imprecise (MEDIUM).** The spec says "Hono 4.x provides `c.req.routePath` for parameterized routes." This property is populated by Hono's router AFTER route matching. If the middleware is attached globally (e.g., `app.use('*', tslock())`) rather than to a specific route, `c.req.routePath` will be `undefined` (or `'/*'` depending on the pattern). The plan adds a fallback to `c.req.path`, which is correct, but the spec should document WHEN `routePath` is available (only when the middleware is attached to a specific route handler in the `.get('/path', tslock(), handler)` form). Also: the current Hono 4.x API surface includes `c.req.routePath` as a property AND `routePath(c)` as a standalone function from `hono/helpers`. Both work; the spec should choose one and document the import requirement if using the function form.

**3. Fastify `request.routeOptions.url` availability in 404 cases (LOW).** The plan correctly notes `routeOptions` may be undefined for 404 requests and falls back to `request.raw.url`. The spec should include this edge case in its edge-cases table. Currently, the edge-cases table says "The framework handles 404 before tslock middleware runs (if placed after route registration)" — but when it DOES run (global middleware), the lock name derivation must handle the missing `routeOptions` case.

**4. Koa `ctx._matchedRoute` is not a standard Koa API (LOW).** The spec acknowledges this and falls back to `ctx.path`. This is correct, but the spec should note that `_matchedRoute` is `koa-router`-specific, not `@koa/router`-specific (they share the API), and the lock name derivation without it will use the raw pathname (e.g., `/api/users/123` instead of `/api/users/:id`), which means per-ID lock names instead of per-endpoint lock names. Users using other routers (or no router at all) will get path-based names. The spec says "For parameterized routes, use a custom `lockNameStrategy` or `name` override" — this guidance should be more prominent for Koa users.

**5. `LockAssert`/`LockExtender` context propagation through Express is asserted but not verified (CRITICAL).** The spec states "Middleware routes through `DefaultLockingTaskExecutor` internally so that `LockAssert.assertLocked()` works inside the handler." This depends on:
- The Express handler `(req, res) => handler` being called synchronously within `next()`
- `next()` being called within the `LockAssert.storage.run()` context

The plan's approach (call `next()` inside the `runHandler` closure, which is the task passed to `executor.executeWithLock()`) does achieve this — because `executeWithLock` wraps the task in `AsyncLocalStorage.run(stack, async () => ...)`, and the `runHandler` closure calls `next()` synchronously before its promise resolves. The handler executes within the `AsyncLocalStorage` context. This is correct but fragile: it depends on Express dispatching the handler synchronously within `next()`. This behavior is intrinsic to Express (it's a synchronous middleware chain) but should be tested explicitly. The spec should add a test case: "`LockAssert.assertLocked()` does not throw inside an Express handler protected by tslock middleware."

**6. Reentrancy description is ambiguous about `app.use` vs `app.get` (LOW).** The spec says "If nested middleware triggers another lock request for the same name" — the reentrancy works. But it doesn't clarify the case where tslock is applied to BOTH `app.use('/api', tslock())` AND `app.get('/api/users', tslock())`: the outer middleware acquires the lock, sets up the `AsyncLocalStorage` context, then calls `next()` which dispatches the inner middleware. The inner middleware's `lifecycle.executeWithLock` calls `executor.executeWithLock`, which checks `LockAssert.alreadyLockedBy(name)` → `true` → executes the handler without re-acquiring. This is correct but the spec should be explicit about this common nesting pattern.

**7. No `KeepAliveLockProvider` integration guidance (MEDIUM).** The edge-cases table mentions "use `KeepAliveLockProvider` or set `lockAtMostFor` longer" for slow handlers. But the middleware's `lockProvider` is provided in `MiddlewareConfig` — if the user wraps their provider in `KeepAliveLockProvider`, does the middleware handle the extended lock correctly? Since `KeepAliveLock` auto-extends, and the middleware's `runHandler` promise may still be pending when the first extend cycle runs, the LockAssert/LockExtender context should still be intact (the promise is pending, so the `AsyncLocalStorage.run()` context is active). This should work. But the spec doesn't mention it.

**8. No `LockingTaskExecutorListener` exposure (LOW).** The middleware creates a `DefaultLockingTaskExecutor` internally. Users who want to wire metrics (e.g., count locked-vs-skipped requests) can't pass a listener. The spec's `MiddlewareConfig` could include an optional `listener?: LockingTaskExecutorListener` field that gets forwarded. This is a v2-quality feature and the spec correctly lists it as out of scope ("No metrics framework integration"), but it's worth noting as a future enhancement.

## Plan Alignment — NEEDS REVISION

### Strengths

- **Implementation order: logical.** middleware-core first (config → lock name → metadata → lifecycle → tests), then adapters (Express → Fastify → Koa → Hono), then integration tests, then docs. Dependencies respected.
- **Test coverage: comprehensive.** Unit tests for core (config, lock-name strategy, lifecycle) + per-adapter unit tests + per-framework integration tests. The test case matrix (lock acquired → 200, lock held → 503, lock released → 200, custom error, handler error, LockAssert integration) is thorough.
- **Risk table: good.** Identifies `finish` vs `close`, Express `req.path` behavior, Fastify `routeOptions` availability, Koa `_matchedRoute`, Hono `routePath` versioning, and executor/continuation model mismatch.

### Issues

**1. Express `runHandler` implementation is missing crucial details (CRITICAL).** The plan says "`runHandler`: wraps `next()` in a Promise — calls `next()` and listens for `res.on('finish')` / `res.on('close')` to resolve." This is a one-liner for the single most complex part of the Express adapter. It doesn't specify:
- The exact promise construction (see Spec Alignment Issue 5)
- How listener cleanup (`res.off`) is handled to prevent memory leaks
- How the `finish`/`close` listener lifecycle interacts with error paths (error handler may send a response → `finish` fires → promise resolves → executor runs finally → unlock. But if error handler calls `next(err)` instead of sending a response, no `finish` fires.)
- A safe timeout (reject the promise after `lockAtMostFor` ms to prevent handler hangs from permanently holding the lock)

**Fix:** Add a concrete code sketch or pseudocode for the Express `runHandler` with cleanup and timeout. Example:

```ts
const runHandler = () => new Promise<void>((resolve, reject) => {
  let settled = false;
  const finish = () => { if (!settled) { settled = true; cleanup(); resolve(); } };
  const timeout = setTimeout(() => finish(), config.lockAtMostFor);
  const cleanup = () => {
    clearTimeout(timeout);
    res.off('finish', finish);
    res.off('close', finish);
  };
  res.on('finish', finish);
  res.on('close', finish);
  next();
});
```

**2. Fastify `done` callback as `runHandler` may unlock too early (HIGH).** The plan says `runHandler: await new Promise(resolve => done(resolve))`. Fastify's `done` callback signals the preHandler hook is complete — NOT that the handler has finished executing. The preHandler fires BEFORE the route handler. If `done()` resolves the promise, the executor's `finally` would unlock BEFORE the handler even starts, defeating the lock. **Fix:** The Fastify `runHandler` must await the handler's completion. Options: (a) use `reply.then(() => resolve())` (Fastify's reply is a thenable that resolves after the response is sent), or (b) listen for `reply.raw.on('finish')`, or (c) for Fastify 5.x, wrap the handler in a promise that resolves when the response lifecycle completes. The spec mentions `reply.then()` as an option; the plan should commit to this approach and drop the `done`-based resolution.

**3. Integration test approach: Fastify `inject()` and Hono `request()` are good, but Supertest for Express/Koa is a heavy dev dependency (LOW).** `supertest` pulls in `superagent` and its dependencies. For Express, the native `http.createServer(handler).listen()` + `fetch()` or `http.request()` works without an additional dependency. For Koa, `app.callback()` returns a Node.js request listener. Express's `app.listen()` returns a server. Using native `http` clients reduces dev dependencies. This is a polite recommendation, not a requirement.

**4. Missing test: `LockAssert.assertLocked()` inside framework handlers (MEDIUM).** The integration test plan includes "LockAssert integration" but doesn't detail the test shape. The spec says `LockAssert.assertLocked()` should pass inside the handler. This test is critical because the `AsyncLocalStorage` context propagation is the main architectural risk. The plan should specify: "Integration test verifies that calling `LockAssert.assertLocked()` inside a handler wrapped by tslock middleware does not throw, and calling it outside (in a separate request not through the middleware) throws `LockException`."

**5. No test for reentrancy with nested middleware (MEDIUM).** The spec says reentrancy works but neither the spec's test plan nor the plan's test list includes a reentrancy integration test for any framework. A test where middleware is applied at both the app-level and route-level with the same lock name should verify the handler runs exactly once and `wasExecuted` is true.

**6. Fastify `.d.ts` module augmentation placement unspecified (LOW).** The plan includes a type declaration for `fastify.tslock` but doesn't specify where it lives or how TypeScript discovers it. It should either be in `src/index.ts` (exported so users import it) or in a `*.d.ts` file referenced in `package.json`'s `types` field. The standard Fastify plugin pattern uses `declare module 'fastify'` in the plugin's own source, but users must import the plugin to get the augmentation to take effect. The plan should clarify this.

**7. Step 9 (pnpm-workspace.yaml update) says "when the file is created during core implementation" (LOW).** This is a hedge — the plan assumes `pnpm-workspace.yaml` might not exist yet. It's safe to just say "add the 5 new packages" and let the implementer handle the case where the file doesn't exist yet.

## Cross-Package Concerns

**`@tslock/middleware-core` exports: PARTIAL.** The spec's public API for `middleware-core` includes:
- Types: `MiddlewareConfig`, `RouteLockConfig`, `LockNameStrategy`, `MiddlwareLockResult` (typo: should be `MiddlewareLockResult` — plane spec has `MiddlwareLockResult` on line 68), `LockMiddlewareMetadata`, `LockRequestContext`, `LockMiddlewareLifecycle`, `LockFailureResponse`
- Functions: `methodPathStrategy`, `createLockMiddlewareLifecycle`

But the adapter packages also need:
- **`defaultLockedBody` factory** — to build the default body. The spec mentions it but doesn't export it in the public API list. Adapters may need it for fallback.
- **`resolveMiddlewareConfig` / `mergeRouteConfig`** — the plan mentions these internal config helpers. If they're internal, adapters shouldn't need them; the lifecycle handles config internally. Fine.
- **`LockMetadata` interface** — if the `LockedBodyProvider` pattern is adopted, adapters need this type for custom body functions. Currently orphaned in the spec.

**`LockMiddlewareLifecycle` interface: acceptable.** The `executeWithLock` method takes `(ctx, routeConfig, runHandler, sendLockedResponse)` — this cleanly separates concerns: the adapter provides framework-specific request extraction and response sending; the lifecycle handles lock. Good design. One nit: the `MiddlwareLockResult` return type (with the typo) is a simple `{ wasExecuted: boolean }`. It's unclear if this result is useful to the adapter (all adapters just complete the request). Consider whether this return type is needed at all, or whether the lifecycle can return `void`.

**`TaskResult` vs `MiddlwareLockResult`: inconsistent.** The spec defines `MiddlwareLockResult` with `wasExecuted: boolean`, but `DefaultLockingTaskExecutor` already returns `TaskResult<T>` with richer semantics. The middleware discards the executor's `TaskResult` and constructs its own simpler result. This is a missed opportunity to propagate useful info (like the executor's listener metrics). Acceptable for v1 simplicity.

## Review Findings Applicability

**S3 review (09) — throw vs return false for update failures: NOT DIRECTLY APPLICABLE.** The S3 review's core finding (updateRecord should throw on 404 to trigger registry cache clear) doesn't apply to middleware — middleware doesn't use `StorageBasedLockProvider` or the `LockRecordRegistry`. However, the broader principle — "should lock failure to acquire return a response vs throw?" — IS relevant.

**Current middleware behavior:**
- Lock held → send 503 response (not an error). ✓
- `lockProvider.lock()` throws (storage error) → propagate to framework error handler. ✓

This is consistent. Lock-held is not a storage error; it's a normal operational state. Storage errors propagate. This matches the error philosophy in the core spec and the S3 review's distinction between "not acquired" (return false) and "can't even try" (throw).

**Redis review (16) — `safeUpdate` flag named misleading: ANALOGOUS.** The Redis review noted that `safeUpdate: true` is silently ignored for `lockAtLeastFor > 0` unlocks. In the middleware spec, the `lockProvider` is user-provided — users who need the `safeUpdate` guarantee must configure it at the provider level. The middleware doesn't touch it. But the middleware's `lockAtLeastFor` config interacts with whatever provider behavior the user has configured. The spec doesn't document this interaction (e.g., "if you use `lockAtLeastFor > 0` with the Redis provider, note that unlock bypasses the Lua ownership check"). This is a documentation gap but not a design flaw.

## Issues Found

| # | Severity | Area | Description |
|---|---|---|---|
| 1 | **CRITICAL** | Express `runHandler` spec | The promise-wrapping of Express `next()` is underspecified. The plan says "listens for `finish`/`close`" but provides no code sketch, cleanup logic, timeout, or error-path handling. Without a concrete spec, the implementation will be guesswork and likely buggy. |
| 2 | **CRITICAL** | Fastify `runHandler` plan | The plan resolves the runHandler promise on `done()`, which fires BEFORE the handler starts. This means unlock happens before execution — the lock is useless. Must resolve on `reply` completion, not `done`. |
| 3 | **HIGH** | Executor vs adapter unlock | The spec's per-framework "response-on-finish hook" phrasing implies the adapter unlocks, but `DefaultLockingTaskExecutor` unlocks in its `finally` block. No adapter implements a separate unlock (correctly, as the plan shows), but the spec language is misleading. Rewrite to clearly state: unlock is always via the executor; the adapter's job is to make the runHandler promise resolve at the right time. |
| 4 | **HIGH** | Handler hang (no timeout) | If a handler never sends a response and doesn't throw, neither `finish` nor `close` fires (connection stays open). The `runHandler` promise hangs forever, holding the lock until `lockAtMostFor` expiration. The Express adapter needs a timeout that rejects the promise after `lockAtMostFor` ms. |
| 5 | **MEDIUM** | `lockedBody` type inconsistency | `MiddlewareConfig.defaultLockedBody` is typed `unknown`, but the spec introduces `LockedBodyProvider: (meta: LockMetadata) => unknown` and then says "let me simplify." The final public API doesn't reconcile these. Either remove `LockedBodyProvider` or commit to supporting both `unknown` and `(meta) => unknown`. |
| 6 | **MEDIUM** | `LockAssert`/`LockExtender` context untested | The spec claims LockAssert works inside handlers but doesn't specify a test for it. The plan includes "LockAssert integration" in the test plan but no concrete test shape. This is the riskiest part of the Express adapter (callback-based middleware wrapped in `AsyncLocalStorage.run()`). |
| 7 | **MEDIUM** | No reentrancy integration test | Neither spec nor plan includes a test for nested middleware with the same lock name. The spec describes reentrancy behavior but doesn't require testing it. |
| 8 | **MEDIUM** | Hono `c.req.routePath` availability | Available only after route matching. Global middleware (`app.use('*', tslock())`) may not have it. The fallback to `c.req.path` is correct, but the spec should document when `routePath` is populated. Also: the current Hono 4.x API has `routePath(c)` as a function import from `hono/helpers` — confirm `c.req.routePath` is the canonical property or use the function. |
| 9 | **LOW** | Koa `_matchedRoute` dependency | `_matchedRoute` is `koa-router`-specific. Koa users without `koa-router` get raw path-based lock names (per-resource-ID instead of per-endpoint). The spec should make this distinction more prominent. |
| 10 | **LOW** | Express 4.x async handler crash | Express 4.x doesn't catch unhandled rejections from async handlers. The spec should document this and recommend Express 5.x or `express-async-errors`. |
| 11 | **LOW** | `MiddlwareLockResult` typo | Line 68 of the spec: `MiddlwareLockResult` — missing `e` (should be `MiddlewareLockResult`). |
| 12 | **LOW** | `LockingTaskExecutorListener` not exposed | Users who want to count locked-vs-skipped requests via the listener can't. Adding optional `listener?: LockingTaskExecutorListener` to `MiddlewareConfig` would be a natural extension point. Future work. |

## Recommendations

1. **Rewrite the Express `runHandler` section with a concrete code sketch** including promise construction, `finish`/`close` listener cleanup, and a `lockAtMostFor`-based timeout. This is the single highest-risk implementation detail.

2. **Fix the Fastify `runHandler` plan.** Do NOT resolve on `done()` — resolve on `reply` completion. Fastify's reply is a thenable: `reply.then(() => resolve())`. Update the plan to match the spec (which correctly says `reply.then()`). Remove the `done`-based approach entirely.

3. **Rewrite per-framework "response-on-finish hook" sections.** Change from "unlock on finish" to "resolve the runHandler promise on finish (or `await next()` for Koa/Hono). The actual unlock is handled by the executor's finally block." The adapter's unlock responsibility is zero — the executor always unlocks.

4. **Add a handler timeout to the Express adapter.** The `runHandler` promise should reject after `lockAtMostFor` ms. The executor's `finally` block will unlock (and the unlock may no-op since the lock already expired). This prevents handler hangs from permanently holding locks.

5. **Resolve the `lockedBody` type.** Choose one: (a) `unknown` only (users provide a static value; the library sends it as-is), or (b) `unknown | ((meta: LockFailureResponse) => unknown)`. Option (b) is more flexible and arguably more useful (allows dynamic `Retry-After` in the body). If choosing (b), expose `LockFailureResponse` from `@tslock/middleware-core` as the function argument type.

6. **Add a `LockAssert.assertLocked()` integration test** to each framework's integration suite. This is the proof that `AsyncLocalStorage` context propagation works through each framework's middleware model. For Express, this is the riskiest test — it validates the callback-based `next()` model correctly preserves the async context.

7. **Add a reentrancy integration test.** Apply tslock middleware at both `app.use('/api', tslock())` and `app.get('/api/users', tslock())` with the same `lockNamePrefix`. Verify the handler runs (reentrancy kicks in) and the lock name is the same.

8. **Verify Hono `c.req.routePath` vs `routePath(c)`.** Check Hono 4.x source: does `c.req.routePath` exist as a property, or is `routePath(c)` the only way? Choose one and document the other as fallback. The spec currently says `c.req.routePath` which may be correct (Hono 4.x does expose it internally), but verify before implementation.

9. **Document Express 4.x limitation.** Add a note in the non-goals or edge-cases: "Express 4.x does not catch rejections from async handlers. Use Express 5.x or `express-async-errors` if your route handlers are async."

10. **Consider adding `listener` to `MiddlewareConfig`** for v2. Not required now, but note it in the spec's future-work section so the config shape doesn't preclude it.

11. **Fix the `MiddlwareLockResult` typo.** Line 68 of the spec.

## Verdict: NEEDS REVISION

The design architecture (shared-core + thin adapters) is correct and follows established TSLock patterns. The lock name derivation, config merging, error handling, and edge cases are well-specified. However, two CRITICAL issues must be addressed before implementation:

1. **The Express `runHandler` promise-wrapping is dangerously underspecified** — a one-liner description of the most complex part of the most important adapter.
2. **The Fastify plan resolves `runHandler` on `done()` instead of `reply` completion** — the lock would be released before the handler executes.

Additionally, the executor-vs-adapter unlock responsibility is confusingly documented (HIGH), handler hangs have no timeout mechanism (HIGH), and `LockAssert` context propagation — the primary architectural justification for routing through `DefaultLockingTaskExecutor` — has no test coverage (MEDIUM).

Addressing these issues brings the spec/plan to implementation-ready. The underlying design is solid; it's the specification and plan details that need tightening.
