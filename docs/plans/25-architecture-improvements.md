# Implementation Plan: Architecture Improvements (Performance, Cohesion, Modularity, Security, Resilience, Fault Tolerance)

## Overview

This plan implements `docs/specs/25-architecture-improvements.md` (approved). It is a **v1.x backward-compatible hardening pass** across the whole TSLock monorepo: core correctness/resilience fixes, provider error-taxonomy unification, Redis `lockAtLeastFor` correctness, middleware hot-path optimization, security hardening, integration-test coverage, and CI improvements.

**Constraint:** no breaking public API changes (see spec §7). Every change ships with a changeset (lockstep versioning, spec 23).

## Resolved Open Decisions (spec §13)

| Decision | Resolution |
|---|---|
| Keep-alive failure policy | **(b) one retry then stop** — a single immediate retry for transient errors; if the second attempt also fails, deactivate the interval and notify via `onKeepAliveFailure`. |
| `pnpm audit` blocking vs non-blocking | **Non-blocking** initially (`continue-on-error: true`), tightened to blocking once the baseline is clean (tracked as a follow-up issue). |
| CI integration job | **Scheduled/on-demand** (`workflow_dispatch` + weekly cron) for container-based suites; **always-on** for redis/redis-ioredis/in-memory. |
| `updateRecord` missing → throw vs self-heal re-insert | **Throw** (Couchbase/S3/GCS pattern) + `StorageBasedLockProvider` clears the registry on any `updateRecord` exception. Keeps single-writer semantics; loud failure instead of silent permanent skip. |

## Prerequisites

- Spec `docs/specs/25-architecture-improvements.md` approved (done).
- Baseline green: `pnpm -r typecheck && pnpm check && pnpm -r test && pnpm -r build`.
- Docker available for integration-test steps (only Steps 7, 12).

## Steps

### Step 1: Core shared helpers (`@tslock/core`)

**File: `packages/core/src/utils.ts`**

- Memoize `getHostname()`: cache `os.hostname()` after first successful call; keep the `'unknown'` fallback.
- Add `toTtlSeconds(ms: number): number` → `Math.floor(ms / 1000) + 1` with JSDoc: never expire early; matches ShedLock's Memcached convention.
- Add `validateLockName(name: string): void` — rejects control chars (`/[\p{Cc}\p{Cf}]/u`) and names > 1024 UTF-8 bytes; throws `LockException`. (Called from `createLockConfig` in Step 2.)

**Tests (`packages/core/__tests__/utils.test.ts` or existing):** hostname memoization (spy on `node:os`), `toTtlSeconds` boundaries (999→1, 1000→2, 1500→2), `validateLockName` (control char, 1024-byte boundary, normal).

### Step 2: Core configuration & registry fixes (`@tslock/core`)

**File: `packages/core/src/lock-configuration.ts`** — `createLockConfig` calls `Utils.validateLockName(name)` after the non-empty check.

**File: `packages/core/src/storage-based-lock-provider.ts`** — in `lock()`, the `catch (e)` around `updateRecord` clears the registry on **any** exception (remove the `justInserted` condition **and the now-unused `justInserted` variable**). This is the warm-path self-heal from spec C2/F3.

**File: `packages/core/src/lock-assert.ts`** — `alreadyLockedBy(name)` scans the whole stack (`store.stack.includes(name)`), matching ShedLock and architecture doc §3.5. Add `@internal` JSDoc to the `storage` field (kept accessible in v1.x; privatization deferred to v2 per spec M3).

**Tests:** `lock-configuration.test.ts` (oversized/control-char names throw, 1024-byte boundary passes); `storage-based-lock-provider` (registry cleared on `updateRecord` throw when registry was warm → next `lock()` re-inserts); `lock-assert.test.ts` (nested `foo`→`bar`→`foo` reentrancy returns true; existing top-of-stack tests still pass).

### Step 3: Relocate `LockAssert.TestHelper` out of core (spec M1)

**File: `packages/core/src/lock-assert.ts`** — remove the `TestHelper` namespace and `SENTINEL`.

**File: `packages/test-support/src/...`** (new `lock-assert-helper.ts`) — move `makeAllAssertsPass` equivalent into `@tslock/test-support`, implemented with a real pushed lock context (replace the `enterWith` sentinel hack with `LockAssert.runWithLock('__test__', ...)` semantics or an exported `TestHelper` that pushes/pops via the documented `storage` accessor).

**Core's own tests** (`packages/core/__tests__/lock-assert.test.ts`) — replace `LockAssert.TestHelper` usage with the real `runWithLock` (or the relocated helper if core can dev-depend on test-support — prefer the former to keep core test deps minimal).

**Verification:** `pnpm --filter @tslock/core test` and `pnpm --filter @tslock/test-support test`.

### Step 4: Keep-alive hardening (spec R1, R3)

**File: `packages/core/src/keep-alive-lock-provider.ts`**

- Wrap `extendForNextPeriod` in try/catch inside the interval callback:
  1. First failure → one immediate retry (`extendForNextPeriod()` again).
  2. Second failure → deactivate + clear interval + call `onKeepAliveFailure(config, error)`.
  3. `extend()` returning `undefined` (lock lost) → deactivate + clear interval + call `onKeepAliveFailure(config, new LockException('Keep-alive lock was lost'))`.
- Add optional constructor option `onKeepAliveFailure?: (config: LockConfiguration, error: unknown) => void` to `KeepAliveLockProvider` (default no-op). Thread it into `KeepAliveLock`.
- Guard the interval callback so a rejected promise is never unhandled (the callback itself catches).

**Tests (`packages/core/__tests__/keep-alive-lock-provider.test.ts`):** (a) `extend()` rejects once then succeeds → interval continues, no crash; (b) `extend()` rejects twice → interval stopped, hook called, no unhandled rejection; (c) `extend()` returns `undefined` → hook called, interval stopped; (d) existing unlock-after-failure behavior preserved.

### Step 5: Unlock-error observability (spec R2)

**File: `packages/core/src/locking-task-executor-listener.ts`** — add optional `onUnlockError?(config: LockConfiguration, error: unknown): void` to the interface (optional member — source-compatible). Update `NO_OP_LISTENER`.

**File: `packages/core/src/locking-task-executor.ts`** — in `runUnderLock`'s `finally`, when `lock.unlock()` throws: `safeEmit(() => this.listener.onUnlockError?.(config, e))` (keep swallowing; task result preserved).

**Tests (`packages/core/__tests__/locking-task-executor.test.ts`):** unlock rejects → task result returned, `onUnlockError` invoked with the error; listener implementations without the new method compile unchanged (type-level check via existing test fixtures).

### Step 6: Redis correctness & security (spec C4, S1, F1)

**File: `packages/redis-core/src/scripts.ts`** — add `KEEP_IF_EQUALS_SCRIPT` (Lua: `if get(KEYS[1]) == ARGV[1] then return pexpire(KEYS[1], ARGV[2]) else return 0 end`).

**File: `packages/redis-core/src/internal-redis-lock-provider.ts`**

- `InternalRedisLockProvider.lock()`: use `Utils.getHostname()` instead of literal `'tslock'`; use `crypto.randomUUID()` for `randomId`.
- `RedisLock.doUnlock()`: if `lockAtLeastUntil(config) > ClockProvider.now()`:
  - `safeUpdate=true` → `redis.eval(KEEP_IF_EQUALS_SCRIPT, [key], [value, remainingMs])`.
  - `safeUpdate=false` → `redis.setIfPresent(key, value, remainingMs)`.
  - else existing delete path (unchanged).

**Tests (`packages/redis-core/__tests__/internal-redis-lock-provider.test.ts`, plus existing per-adapter tests):** unlock with `lockAtLeastFor>0` keeps key (assert eval with KEEP script / `setIfPresent` args, remaining ms); unlock with `lockAtLeastFor=0` deletes; value contains hostname + UUID-shaped randomId; existing `shouldLockAtLeastFor`-style unit coverage. Update `packages/redis` and `packages/redis-ioredis` unit tests if they assert the old value format.

### Step 7: Redis integration tests (spec F1, F2 — priority 1)

- Add `test:integration` scripts to `packages/redis` and `packages/redis-ioredis` (mirror datastore/firestore: a `vitest.integration.config.ts`).
- Add `__tests__/integration/` wiring the shared contract: `lockProviderIntegrationTests` from `@tslock/test-support` (covers `shouldLockAtLeastFor`, `shouldSkipIfLocked`, fuzz) against a real Redis container (`testcontainers` devDependency, or a documented local `redis://localhost:6379` fallback).
- Run locally: `pnpm --filter @tslock/redis test:integration` (and redis-ioredis).

### Step 8: Provider error-taxonomy unification (spec C1, C6, M4)

Standardize config-validation errors to `LockException` with a `<Provider>Configuration:` message prefix. Files (per the spec evidence):

- `packages/spanner/src/spanner-configuration.ts` (lines 36, 41, 53)
- `packages/datastore/src/datastore-configuration.ts` (34, 39, 49)
- `packages/firestore/src/firestore-configuration.ts` (34, 39, 49)
- `packages/dynamodb/src/dynamodb-lock-provider-options.ts` (17)
- `packages/memcached/src/memcached-lock-provider.ts` (35) — inline validation in `createMemcachedLockProvider`
- `packages/neo4j/src/neo4j-lock-provider.ts` (37)

Add shared validation helpers in `@tslock/core` (`Utils.assertNonEmpty(value, label)`, reuse `validateLockName`) and use them where they replace copy-paste (s3/gcs/cassandra/sql-support keep `LockException`, just refactor to the helpers).

**C6/M4 decision (from spec — record it, do not silently drop):** the duplicated `s3-errors.ts` / `gcs-errors.ts` error classifiers stay **as-is** — S3 (`name` + `$metadata.httpStatusCode`) and GCS (`code`) error shapes do not admit a single clean type-safe abstraction, and extracting one would violate the "no unrequested abstractions" rule. Add a one-line note in each file's package README documenting why they are intentionally separate.

**Tests:** per-provider config test asserting `instanceof LockException` and message prefix (extend existing config tests; add where missing).

### Step 9: `updateRecord` missing semantics — Firestore/Datastore/Spanner (spec C2, F3)

**Files:** `packages/firestore/src/firestore-storage-accessor.ts:75`, `packages/datastore/src/datastore-storage-accessor.ts:100`, `packages/spanner/src/spanner-storage-accessor.ts:51` — change `return false` on missing record to `throw new LockException('Lock record not found: <name>')` (Spanner: when `rows.length === 0`).

**Note (from spec):** verify ShedLock's own Firestore/Datastore `update` behavior during implementation and document parity in the provider README. SQL/Cassandra/Neo4j accessors are **unchanged** (row-count 0 is the correct "not updated" signal).

**Tests:** unit tests with mocked drivers (missing record → throws); integration tests in firestore/datastore add an external-delete self-heal case (delete record, then `lock()` re-creates it after registry clear). **Spanner:** no emulator available — document the emulator-less limitation in the spanner README (per spec §9) and rely on the mocked-driver unit test.

### Step 10: TTL helper migration (spec C5)

- `packages/memcached/src/memcached-lock-provider.ts:24` and `memcached-lock.ts:28` → `Utils.toTtlSeconds(...)`.
- `packages/etcd/src/etcd-accessor.ts:17,53` → `Utils.toTtlSeconds(...)` (behavior change: +1s for exact-second durations — safe direction; update etcd unit tests asserting TTL values).
- `RedisLock`/middleware `retryAfterSeconds` keep `Math.ceil` (different semantics; add a comment-free note in README).

### Step 11: Middleware hot-path & typing (spec P1, C7, C8, C9)

**File: `packages/middleware-core/src/middleware-config.ts`**

- `resolveMiddlewareConfig` stores **pre-resolved numbers** for global durations (resolve `lockAtMostFor`/`lockAtLeastFor` once at creation; keep the `DurationInput` fields for back-compat by resolving into a frozen `ResolvedMiddlewareConfig`).
- `mergeRouteConfig(globalResolved, route?)` parses route-level durations only when overridden; cache per-`RouteLockConfig` object identity in a `WeakMap` (routes are created once per route-registration).
- Add `StaticLockedBody`/`LockedBody` types (spec C7); type `defaultLockedBody`, `lockedBody`, `ResolvedRouteConfig.lockedBody` with `LockedBody`.
- Remove `ResolvedRouteConfig.lockName` (C8).
- Hoist the mid-file `parseDuration` import (C9).

**File: `packages/middleware-core/src/middleware-lifecycle.ts`** — use pre-resolved config; drop the redundant `resolved.lockName` read (use `routeConfig?.name` directly).

**Tests (`packages/middleware-core/__tests__/`):** zero `parseDuration` calls on hot path when defaults apply (counting spy); route-config cache hit/miss; `LockedBody` function typing (compile-time); existing lifecycle tests updated for the `ResolvedRouteConfig` shape change.

### Step 12: Broader integration coverage (spec F2 — priority 2+)

Following the spec's priority order, add `test:integration` + shared-contract wiring for: in-memory (trivial), mongo, sql (postgres via testcontainers), then container-backed suites where drivers permit (memcached, etcd, nats, hazelcast, zookeeper, couchbase, arangodb, neo4j, cassandra, elasticsearch, opensearch), and LocalStack for dynamodb/s3. Each: `vitest.integration.config.ts`, container/emulator config, README instructions.

**Scope gate for this step:** land redis + in-memory + mongo + sql in this plan; the remaining containers are tracked as follow-up issues with the same pattern (spec allows partial rollout; CI runs what exists).

Add a root aggregate script `test:integration` (`pnpm -r test:integration`) and a CI job (see Step 14).

### Step 13: Lock-name validation rollout (spec S2)

- Core validation lands in Step 2. Provider READMEs document the 1024-byte limit and control-char rejection (s3, redis, zookeeper, nats, memcached, etcd, and any provider that embeds the name in a key/path).
- No provider-side re-validation needed (core `createLockConfig` is the single entry point) — verify no provider bypasses `createLockConfig`.

### Step 14: CI & tooling (spec S3, S4, S5, P4, M2)

**`.github/workflows/ci.yml`**

- `pnpm install --frozen-lockfile`.
- Add `pnpm audit --prod` step with `continue-on-error: true` initially (non-blocking; tighten later per resolved decision).
- Add an integration job: always-on for redis/redis-ioredis/in-memory; `workflow_dispatch` + weekly cron for container suites.

**`packages/core/package.json`** (and others where trivially true) — add `"sideEffects": false` and `"./package.json": "./package.json"` to `exports`. Tree-shaking smoke test: bundle provider + core, assert unused exports absent.

**`pnpm-workspace.yaml`** — verify `zookeeper: false` under `allowBuilds` doesn't break the zookeeper package install/tests; document or adjust.

**`benchmarks/`** (new, excluded from `pnpm -r build/test/typecheck` aggregates): `InMemoryLockProvider` lock/unlock round-trip, `executeWithLock` overhead, middleware per-request overhead. Add README with baseline numbers.

**P3 placement (from spec §1.2 item 3):** the benchmark harness measures `AsyncLocalStorage` overhead. If it is material, the `LockAssert`/`LockExtender` store merge is **deferred to v2** (spec §12) — it is not in scope for this v1.x pass. Record this decision in the benchmarks README.

**Release checklist (spec 23):** add "verify no `workspace:*` in published peerDependencies" (test-support).

### Step 15: Documentation

- **README.md:** note the 1024-byte lock-name limit in relevant sections; integration-test instructions; benchmarks.
- **AGENTS.md:** update the "Review findings to address during implementation" section (mark S3/GCS/Spanner/Firestore/Datastore `updateRecord` throw as addressed); note the new `test:integration` aggregate.
- **Per-provider READMEs** (step 13 list): name-limit + integration-test notes.
- **middleware-core README (spec F4/F5):** explicit notes on (a) the `lockUntil` approximation in the failure response (`now + lockAtMostFor` — the actual holder's expiry is unknown from `lock()` returning `undefined`) and (b) handler-hang semantics (Koa/Hono hold the lock until natural `lockAtMostFor` expiry; Express has a `lockAtMostFor`-based timeout).
- **redis/memcached/etcd READMEs (spec S1 audit note):** document why Memcached/Etcd ownership values have no crypto-random component (their unlock operations are not value-verified; only Redis compares the stored value).
- **`docs/00-vision.md` / `docs/01-architecture.md`:** unchanged (no architectural change; spec/plan/review documents capture the hardening).

### Step 16: Verify & review

```bash
pnpm -r typecheck
pnpm check
pnpm -r lint
pnpm -r test
pnpm -r test:integration   # redis/redis-ioredis/in-memory/mongo/sql at minimum
pnpm -r build
```

Then: independent review per the workflow (review document `docs/reviews/25-architecture-improvements.md`), feedback loop (max 3 rounds), and re-verify.

## Risks & Mitigations

| Risk | Mitigation |
|---|---|
| `LockAssert.TestHelper` removal breaks internal tests | Core tests switch to real `runWithLock`; keep a deprecated shim in core only if a consumer is found (spec M1). |
| `onUnlockError` interface change | Member is **optional** — existing implementations compile unchanged (spec §7). |
| Redis `lockAtLeastFor` unlock behavior change affects `safeUpdate=false` users | Only changes unlock-with-`lockAtLeastFor>0` path; documented in redis README; covered by new integration contract. |
| `updateRecord` throw changes Firestore/Datastore/Spanner callers | Loud failure replaces silent skip — intended per spec C2/F3; verify ShedLock parity during Step 9 and document. |
| Registry clear-on-any-exception causes extra insert attempts | Harmless (insert fails with duplicate → falls through to update); correctness maintained at storage layer. |
| Etcd TTL +1s behavior change | Safe direction (never early-expire); unit tests updated; documented. |
| Middleware route-cache `WeakMap` holds stale resolutions if user mutates route config | Route configs are treated as immutable after registration (documented); `WeakMap` keyed by object identity avoids leaks. |
| Integration tests need Docker | redis/redis-ioredis/in-memory run always-on in CI; container suites scheduled/on-demand; local run documented. |

## Estimation

~30-40 files touched across core (6), redis-core (2), redis adapters (2), providers (10), middleware-core (3), test-support (1), CI/tooling (3), benchmarks (2-3), docs (8+). Roughly 500-800 lines of implementation + 800-1200 lines of tests. Steps 1-6 (core+redis correctness/security) are the highest-value, lowest-risk slice and can land first as one changeset group; Steps 7-12 expand coverage; Steps 13-15 finish with docs/CI.

## Order of Implementation

1. Step 1 (core helpers) → 2 (config/registry/lock-assert) → 3 (TestHelper) → 4 (keep-alive) → 5 (unlock listener)
2. Step 6 (redis correctness/security) → 7 (redis integration tests)
3. Step 8 (config errors) → 9 (updateRecord missing) → 10 (TTL helper)
4. Step 11 (middleware) → 12 (integration coverage, priority 2)
5. Step 13 (docs rollout) → 14 (CI/tooling) → 15 (docs) → 16 (verify + review)

Each group ends with `pnpm -r typecheck && pnpm --filter <affected> test` before moving on.
