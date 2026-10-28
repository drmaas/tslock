# Review: Web Framework Middleware Integrations — Code Review

**Spec:** `docs/specs/24-middleware.md`
**Plan:** `docs/plans/24-middleware.md`
**Prior review:** `docs/reviews/24-middleware.md`
**Review target:** Implemented code across 5 packages

## Overview

All 5 middleware packages are implemented and passing unit tests. The shared-core + thin-adapters architecture is sound and follows TSLock conventions. The prior review's 3 CRITICAL issues (Express `runHandler` promise-wrapping, Fastify `done()`-vs-`reply` resolution, executor-vs-adapter unlock responsibility) are all fully addressed. However, integration tests are entirely missing, the Hono adapter drops lock failure headers, and the `lockedBody` type doesn't reflect function support. The implementation is solid for unit-tested logic but incomplete without integration coverage.

## Summary

| Category | Verdict |
|---|---|
| Spec alignment | NEEDS REVISION |
| Plan alignment | NEEDS REVISION |
| Architecture alignment | PASS |
| Code quality | NEEDS REVISION |
| Tests | NEEDS REVISION |
| **Overall** | **NEEDS REVISION** |

## Spec Alignment Findings

### Addressed from prior review

| Prior Review Issue | Status |
|---|---|
| #1 — Express `runHandler` under-specified | **FIXED.** Uses `settled` flag, `finish`/`close` listeners, `lockAtMostFor`-based timeout, proper cleanup (`express-lock-factory.ts:31-63`). |
| #2 — Fastify `done()` resolves too early | **FIXED.** `done()` fires immediately, then `reply.then(resolve, reject)` resolves on response completion (`fastify-lock-plugin.ts:28-32`). |
| #3 — Executor-vs-adapter unlock confusion | **FIXED.** All adapters delegate to `DefaultLockingTaskExecutor` which unlocks in `finally`. No adapter calls `lock.unlock()` directly. |
| #4 — Handler hang timeout | **FIXED.** Express `runHandler` has `setTimeout(lockAtMostMs)` guarantee. |
| #5 — `lockedBody` type inconsistency | **PARTIALLY FIXED.** Runtime supports function form (`lock-metadata.ts:25`), but TypeScript types still say `unknown`. See issue CQ-1. |
| #6 — `LockAssert` context untested | **NOT ADDRESSED.** No integration test exists. Unit tests don't verify `AsyncLocalStorage` propagation through frameworks. |
| #7 — Reentrancy integration test | **NOT ADDRESSED.** No integration test exists. |
| #10 — Express 4.x async handler limitation | **NOT ADDRESSED.** No documentation or handling in the adapter. |
| #11 — `MiddlewareLockResult` typo | **FIXED.** Spelled correctly as `MiddlewareLockResult` throughout. |

### New issues

| # | Severity | Area | Description |
|---|---|---|---|
| SA-1 | **MEDIUM** | `lockedBody` type | `MiddlewareConfig.defaultLockedBody` and `RouteLockConfig.lockedBody` are typed `unknown`, but runtime in `buildLockFailureResponse` (`lock-metadata.ts:25`) treats functions as body factories: `typeof body === 'function' ? body({...}) : body`. The TypeScript type should be `unknown | ((meta: LockMetadata) => unknown)`. |
| SA-2 | **HIGH** | Hono response headers | The Hono adapter's `sendLockedResponse` (`hono-lock-factory.ts:40`) calls `c.json(body, status)` WITHOUT the headers object from `LockFailureResponse`. The `Retry-After`, `Lock-Name`, and `Locked-By` headers are never set on the Hono response. This violates the spec's requirement that lock failure responses include `Retry-After` and metadata headers. |
| SA-3 | **MEDIUM** | `LockMiddlewareMetadata` not implemented | The spec's public API defines `LockMiddlewareMetadata` with `lockName`, `lockUntil`, `lockedBy`, `lockAcquired`, `lockPresent`. The implementation only exports `LockMetadata` (without `lockAcquired`/`lockPresent`). These fields are unused anyway (no caller reads `wasExecuted` in an interesting way), but this is a spec deviation. |
| SA-4 | **MEDIUM** | `lockedBy` always `'unknown'` | `middleware-lifecycle.ts:60` hardcodes `lockedBy: 'unknown'` in the failure response. The spec shows `Locked-By: <hostname>` headers. The `DefaultLockingTaskExecutor` doesn't expose lock-holder info when `lock()` returns `undefined`, so the middleware can't populate this. This is an architectural limitation, not a bug. |
| SA-5 | **LOW** | `MiddlewareConfig.lockAtMostFor` non-optional | Spec says `lockAtMostFor?: DurationInput` (optional). Implementation's `MiddlewareConfig` type has it required (non-optional). The user-facing API (`createExpressLock({...})`) accepts `Partial<...>`, so this works in practice, but the internal type definition deviates. |

## Plan Alignment Findings

### File structure

All source files listed in the plan are created:

- `packages/middleware-core/`: all 5 `src/` files + 4 test files present. Additional `lock-metadata.test.ts` created (not in plan, but good).
- `packages/express/`: all 2 `src/` files + `express-lock.unit.test.ts` present. **Integration test (`express-lock.integration.test.ts`) MISSING.**
- `packages/fastify/`: all 3 `src/` files + `fastify-lock.unit.test.ts` present. **Integration test (`fastify-lock.integration.test.ts`) MISSING.**
- `packages/koa/`: all 2 `src/` files + `koa-lock.unit.test.ts` present. **Integration test (`koa-lock.integration.test.ts`) MISSING.**
- `packages/hono/`: all 2 `src/` files + `hono-lock.unit.test.ts` present. **Integration test (`hono-lock.integration.test.ts`) MISSING.**

### Package configuration

All packages have correct `package.json` (dual ESM/CJS, peer deps), `tsconfig.json` (extends base), and `tsup.config.ts` (esm + cjs + dts).

### Missing from plan

| # | Severity | Description |
|---|---|---|
| PA-1 | **HIGH** | **Integration tests missing for all 4 adapters.** The plan requires integration tests for Express, Fastify, Koa, and Hono. None exist. These tests are critical for verifying: lock-acquired → 200, lock-held → 503 with headers, lock-released-after-handler → 200, custom error responses, handler-error → lock-still-released, LockAssert context propagation, and reentrancy via nested middleware. |
| PA-2 | **MEDIUM** | **Step 9 (pnpm-workspace.yaml update) and Step 11 (documentation).** These final steps don't produce code, but should be verified. The middleware packages are in the workspace config. README updates were not checked. |

## Architecture Alignment Findings

All architecture requirements pass:

| Check | Status |
|---|---|
| `@tslock/middleware-core` depends only on `@tslock/core` | PASS |
| Each adapter depends on `@tslock/middleware-core` (dependency, not peer) | PASS |
| Each adapter has correct framework peer dependency | PASS |
| Adapters are thin (delegating lock logic to `createLockMiddlewareLifecycle`) | PASS |
| Uses `DefaultLockingTaskExecutor` for lock/execute/unlock lifecycle | PASS |
| `AsyncLocalStorage` context propagation via `DefaultLockingTaskExecutor` | PASS (per executor code, not integration-tested) |
| Dual ESM/CJS via tsup | PASS |
| Plain typed config objects, no builder classes | PASS |
| No comments (TSLock convention) | PASS |
| Lock acquisition failure returns response (not throws) | PASS |
| Storage errors propagate to framework error handler | PASS |
| Unlock always in executor's `finally` block (never by adapter) | PASS |

## Code Quality Findings

### Addressed from prior review

| Prior Issue | Status |
|---|---|
| Fastify route path fallback (`request.routeOptions?.url ?? request.url`) | **FIXED** (`fastify-lock-plugin.ts:26`) |
| Koa `_matchedRoute` fallback | **FIXED** (`koa-lock-factory.ts:24`) |
| Hono `routePath` fallback to `c.req.path` | **FIXED** (`hono-lock-factory.ts:11-17`) |
| Fastify `.d.ts` module augmentation | **FIXED** (`fastify.d.ts`) |

### Bugs

| # | Severity | File | Description |
|---|---|---|---|
| CQ-1 | **HIGH** | `hono-lock-factory.ts:40` | `sendLockedResponse` calls `c.json(body, status)` without settin `Retry-After`, `Lock-Name`, or `Locked-By` headers. Must call `c.header()` before `c.json()`, or pass the headers object as the third argument to `c.json()`. |
| CQ-2 | **MEDIUM** | `middleware-lifecycle.ts:54` | `lockUntil` is computed as `now + resolved.lockAtMostFor` instead of using the actual `LockConfiguration.createdAt + lockAtMostFor`. For non-`useDbTime` providers these are nearly identical, but the `Retry-After` value may be off by a few milliseconds. More importantly, the real `LockConfiguration` (created by `createLockConfig` at line 42) has its own `createdAt` that should be the authoritative source. |
| CQ-3 | **MEDIUM** | `middleware-lifecycle.ts:35-41` | Lock name derivation uses `routeConfig?.name ?? (resolved.lockName \|\| undefined)`. `mergeRouteConfig` always sets `lockName` to `routeConfig?.name ?? ''`, so `resolved.lockName \|\| undefined` converts the empty string back to `undefined`, then `deriveLockName` treats `undefined` as "no override". This double-fallback is confusing but correct. Cleaner: pass `routeConfig?.name` directly. |

### Design / correctness concerns

| # | Severity | File | Description |
|---|---|---|---|
| CQ-4 | **MEDIUM** | `middleware-lifecycle.ts:55` | `defaultLockedBody` fallback logic: `typeof resolved.lockedBody !== 'undefined' && resolved.lockedBody !== null ? resolved.lockedBody : defaultLockedBody`. When `resolved.lockedBody` is `undefined` (default), falls back to `defaultLockedBody` (the function). `buildLockFailureResponse` then detects `typeof body === 'function'` and calls it. This works correctly but the double-indirection (`resolveMiddlewareConfig` stores `undefined` → lifecycle substitutes function → response builder calls it) is fragile and hard to follow. |
| CQ-5 | **LOW** | `middleware-config.ts:65-66` | Import of `parseDuration` and `methodPathStrategy` at bottom of file (non-standard placement). Works due to hoisting but unusual for TSLock convention. |
| CQ-6 | **LOW** | `middleware-lifecycle.ts:60` | `lockedBy: 'unknown'` — should use `Utils.getHostname()` from core to at least identify the current instance as the responder, even though it can't identify the lock holder. |
| CQ-7 | **LOW** | `express-lock-factory.ts:25` | `void (async () => { ... })()` — Express middleware returns `void`, so the async IIFE pattern is correct. Error handling via `catch (err) { next(err); }` matches the spec's error handling table. |
| CQ-8 | **LOW** | `hono-lock-factory.ts:40` | `c.json(result.body as object, result.status as 200)` — the `as 200` type assertion is misleading; `result.status` is `503` at runtime and the cast is erased. Harmless but confusing. |
| CQ-9 | **LOW** | `tsup.config.ts` (all 5) | Target `node20` instead of `node22`. Consistent across the whole project, not just middleware. |

## Test Coverage Assessment

### Unit tests: PASS

All 43+9+8+7+8+9 = 84 unit tests pass across 5 packages.

| Package | Tests | Coverage |
|---|---|---|
| middleware-core | 43 | Config merging, lock name strategies, failure response building, lifecycle (lock acquired, not acquired, custom status, custom body, function body, handler error, unlock on success/failure, route override) |
| express | 8 | Method/path extraction, lock failure (503 + body + headers), lock success calls `next()`, unlock on `finish`, unlock on `close`, custom `lockedStatus`, custom `lockedBody` function, provider error propagation |
| fastify | 7 | Plugin decorates `tslock`, preHandler blocks on lock failure, allows on lock acquisition, `routeOptions.url` precedence, custom `lockedStatus`, provider error propagation, factory exposes `lockProvider`/`config` |
| koa | 8 | Method/path extraction, lock failure sets ctx.status/body (no `next()`), lock success calls `next()`, unlock after handler, unlock in finally on handler throw, custom status, provider error propagates, `_matchedRoute` fallback |
| hono | 9 | Method/routePath extraction, lock failure returns 503, lock success calls `next()`, unlock after handler, unlock in finally on throw, `routePath` fallback to path, registered `routePath` usage, custom status, provider error propagates |

### Integration tests: FAIL

**All 4 adapter integration test files are missing.** The spec and plan require these test cases per adapter:

| Test case | Purpose |
|---|---|
| Lock acquired → 200 | First request executes handler, returns normal response |
| Lock held → 503 | Second concurrent request gets 503 with `Retry-After`, `Lock-Name`, `Locked-By` headers |
| Lock released → 200 | After first handler completes, third request acquires lock |
| Custom error response | `lockedStatus` / `lockedBody` override works end-to-end |
| Handler error → 500 | Lock still released, next request acquires lock |
| **LockAssert integration** | Handler calls `LockAssert.assertLocked()` — does NOT throw. Unprotected handler throws `LockException`. Proof that `AsyncLocalStorage` context propagates through each framework's middleware model. |
| **Reentrancy** | Middleware applied at both `app.use('/api', tslock())` and `app.get('/api/task', tslock(), handler)` with same lock name prefix. Inner middleware detects reentrancy, handler runs without re-acquiring. |

The LockAssert and reentrancy tests are **critical** — LockAssert validates the `AsyncLocalStorage.config` propagation that is the primary architectural justification for routing through `DefaultLockingTaskExecutor`. Without this test, there is no proof that lock context works through callback-based (Express) or async-based (Koa/Hono) middleware chains.

### Missing unit test coverage

| # | Severity | Description |
|---|---|---|
| TC-1 | **LOW** | Express "handler throws" path — unit test checks unlock on finish/close but doesn't explicitly test that a handler that throws still triggers finish/close (Express error middleware may not send a response → no finish event). |
| TC-2 | **LOW** | `middleware-lifecycle.test.ts:159-160, 174-175` — `lockSpy` is created but never asserted. Two tests ("uses route config override for lock name" and "lock name uses lockNamePrefix") create a spy on `lockProvider.lock` but never check `lockSpy.mock.calls` to verify the lock config's name. |
| TC-3 | **MEDIUM** | Hono response headers — the mock `c.json()` returns `{ body, headers: new Map() }` which doesn't simulate real Hono behavior. No test verifies that `Retry-After` or metadata headers are sent on lock failure. |

## Overall Verdict: NEEDS REVISION

### What's good

- The shared-core + thin-adapters architecture is correctly implemented.
- All 3 CRITICAL issues from the prior review are fully addressed: Express `runHandler` has proper cleanup/timeout/settled-flag, Fastify uses `done()`+`reply.then()`, and no adapter unlocks independently.
- Unit tests are comprehensive and all pass (84 tests across 5 packages).
- Code follows TSLock conventions (no comments, plain typed configs, dual ESM/CJS).
- Lock name derivation, config merging, and error propagation are correct.

### What must be fixed (blocking)

1. **HIGH — Hono drops lock failure headers.** `sendLockedResponse` in `hono-lock-factory.ts:40` must set `Retry-After`, `Lock-Name`, and `Locked-By` headers via `c.header()` before calling `c.json()`. Currently no headers are sent on Hono lock failure responses.

2. **HIGH — No integration tests exist.** All 4 adapters require integration tests per the spec and plan. Without them, LockAssert context propagation (the biggest architectural risk) and reentrancy behavior are unverified through real framework middleware chains.

### What should be fixed (recommended)

3. **MEDIUM — `lockedBy` is always `'unknown'`.** Should at minimum use `Utils.getHostname()` to identify the responding instance, even if the lock holder can't be determined.

4. **MEDIUM — `lockedBody` type should include function form.** `unknown | ((meta: LockMetadata) => unknown)` to reflect runtime support.

5. **MEDIUM — Missing unit test assertions.** The lock name override and prefix tests create unused `lockSpy`. Add assertions to verify lock names.

6. **LOW — `lockUntil` computed independently of `LockConfiguration.createdAt`.** Use the actual config's `createdAt + lockAtMostFor` for `Retry-After` calculation, or at least document the approximation.
