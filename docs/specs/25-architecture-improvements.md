# Spec: Architecture Improvements (Performance, Cohesion, Modularity, Security, Resilience, Fault Tolerance)

## Overview

This spec defines a v1.x hardening pass over the entire TSLock monorepo — `@tslock/core`, all provider/infrastructure packages, the middleware packages, and the build/CI tooling. It is **audit-driven**: every improvement below is grounded in a concrete finding from the current implementation, with file references. All changes are **backward-compatible** (v1.x): no breaking changes to public APIs, package structure, or configuration shapes. Items that require breaking changes are explicitly marked as v2 in the Non-Goals and Future Work sections.

**Status:** v1.x — post-initial-release hardening. Follows the full workflow (Spec → Plan → Implement → Verify → Review) in `AGENTS.md`/`CONTRIBUTING.md`.

## Scope

| Area | Included |
|---|---|
| `@tslock/core` | Yes — executor, keep-alive, lock-assert, storage provider, utils |
| Provider packages (all 23 + shared infra) | Yes — config resolvers, accessors, error taxonomy, TTL conventions |
| Middleware (`middleware-core` + 4 adapters) | Yes — per-request config resolution, typing |
| Build & tooling | Yes — Biome, tsup, package.json hygiene |
| CI | Yes — audit step, frozen-lockfile, integration coverage |
| Docs | Yes — README/AGENTS updates as part of implementation |

## Current-State Audit

Repo statistics verified during audit:

| Metric | Value |
|---|---|
| Workspace packages | 33 |
| TS source files (`src/`) | 272 |
| LOC in `src/` | ~5,986 |
| Test files | 73 |
| Packages with `test:integration` script | 2 (datastore, firestore) |
| `any` usage in `src/` | 0 |
| `process.env` usage in `src/` | 0 |
| TODO/FIXME in `src/` | 0 |
| `dist/` tracked in git | No (correctly ignored) |

Findings are organized by the six spec dimensions. Each finding cites `file:line` where applicable and is tagged with a severity.

---

## 1. Performance

### 1.1 Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| P1 | **MEDIUM** | Middleware re-parses durations on **every request**. `createLockMiddlewareLifecycle` builds a shared executor once (good), but `mergeRouteConfig` calls `parseDurationWrapper` per request in the hot path (regex + object allocation) even though global config is fixed and route configs are known at route-registration time. | `packages/middleware-core/src/middleware-config.ts:55-66`, `middleware-lifecycle.ts:38-42` |
| P2 | **LOW** | `Utils.getHostname()` calls `os.hostname()` (a syscall) on **every** lock/unlock/extend operation — 36 call sites across providers. Hostname does not change during process lifetime. | `packages/core/src/utils.ts:4`, grep `getHostname()` |
| P3 | **LOW** | `LockAssert.alreadyLockedBy` and `runWithLock` allocate a new array per nesting level; acceptable at cron scale, but the two nested `AsyncLocalStorage.run()` calls (`LockAssert` + `LockExtender`) double ALS overhead per task execution. | `packages/core/src/lock-assert.ts:22-25`, `locking-task-executor.ts:100-102` |
| P4 | **LOW** | No benchmark harness exists, so performance regressions and improvements cannot be measured. | repo-wide |

### 1.2 Improvements

1. **Pre-resolve durations at factory time (P1).** `createLockMiddlewareLifecycle(config)` resolves global durations once (already-resolved numbers are stored on the frozen config). `mergeRouteConfig` becomes `resolveRouteConfig(globalResolved, routeConfig)` which parses route-level durations only when the route config actually overrides them — and the result is cached per `RouteLockConfig` object identity (a `WeakMap`) so repeated requests through the same route middleware do not re-parse.
2. **Cache hostname (P2).** `Utils.getHostname()` memoizes `os.hostname()` after the first call (with the existing try/catch fallback to `'unknown'`). Pure internal change — zero API impact, 36 call sites benefit.
3. **Merge ALS contexts (P3) — optional, measure first.** If profiling shows ALS overhead matters, merge the `LockAssert` and `LockExtender` stores into a single `AsyncLocalStorage<{ lockStack: string[]; activeLocks: SimpleLock[] }>` inside `DefaultLockingTaskExecutor`'s run path, keeping both public APIs (`LockAssert`, `LockExtender`) unchanged. This is a pure-internal refactor; the public `LockAssert.storage` field stays for compatibility (documented as internal).
4. **Add a benchmark harness (P4).** A `benchmarks/` workspace with a `@tslock/bench` script (or a root `bench` script) measuring: lock/unlock round-trip latency for `InMemoryLockProvider` and mocked providers; `executeWithLock` overhead; middleware per-request overhead before/after P1. Benchmarks run manually and optionally in CI as a non-blocking job.

### 1.3 Acceptance Criteria

- Middleware hot path performs **zero** `parseDuration` calls when global defaults apply (asserted by unit test with a counting spy).
- `os.hostname()` is invoked at most once per process after `Utils.getHostname()` is first called (unit test with spy on `node:os`).
- Benchmark script exists and documents baseline numbers in its README.

---

## 2. Cohesion

### 2.1 Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| C1 | **MEDIUM** | Configuration-validation errors are **inconsistent**: some providers throw `LockException`, others throw plain `Error`. Users cannot catch config errors uniformly. | Throws `LockException`: `s3-provider-config.ts:10`, `gcs-provider-config.ts:15`, `cassandra/validation.ts:10`, `sql-support/sql-configuration.ts:50`. Throws plain `Error`: `spanner-configuration.ts:36,41,53`, `datastore-configuration.ts:34,39,49`, `firestore-configuration.ts:34,39,49`, `dynamodb-lock-provider-options.ts:17`, `memcached-lock-provider.ts:35`, `neo4j-lock-provider.ts:37`. |
| C2 | **HIGH** | `updateRecord` semantics for "record missing" are **inconsistent** across Category A providers. S3/GCS/Couchbase throw (loud — callers see an error; the registry clears only on the just-inserted path); Firestore/Datastore/Spanner return `false` (silent — indistinguishable from "lock held"). Consequences: if a lock record is deleted externally (TTL policy, manual cleanup), the Firestore/Datastore/Spanner provider returns `undefined` **forever** for that lock name with no error, and the `LockRecordRegistry` cache never clears. | Throw on missing: `s3-storage-accessor.ts:89`, `gcs-storage-accessor.ts:89`, `couchbase-storage-accessor.ts:52`. Return false on missing: `firestore-storage-accessor.ts:75`, `datastore-storage-accessor.ts:100`, `spanner-storage-accessor.ts:51`. |
| C3 | **MEDIUM** | `LockAssert.alreadyLockedBy` checks **only the top of the stack** (`stack[LOCK_NAME_INDEX] === name`), diverging from ShedLock's `contains` and from this repo's own architecture doc (§3.5 shows `stack.includes(name)`). Nested different-name locks then re-attempt acquisition of a name already held lower in the stack, skipping the task instead of running reentrantly. | `packages/core/src/lock-assert.ts:17-20` vs `docs/01-architecture.md` §3.5 |
| C4 | **LOW** | Redis lock value hardcodes hostname `'tslock'` instead of the real hostname, diverging from ShedLock (`ADDED:<iso>@<hostname>`) and from every other provider, which use `Utils.getHostname()`. | `packages/redis-core/src/internal-redis-lock-provider.ts:77-79` |
| C5 | **LOW** | TTL rounding conventions differ: Memcached uses `Math.floor(ms/1000) + 1` (review-20 adopted buffer), Etcd uses `Math.ceil(ms/1000)`. Both are safe (never early-expire), but the convention should be uniform and documented in `@tslock/core` as a shared helper. | `memcached-lock-provider.ts:24`, `etcd-accessor.ts:17,53` |
| C6 | **LOW** | Duplicated error-classification helpers `s3-errors.ts` and `gcs-errors.ts` (both classify "not found" / "precondition failed"). S3 uses `name` + `$metadata.httpStatusCode`; GCS uses `code`. Candidates for a shared helper in core, but see "no unrequested abstractions" — only extract if a single type-safe helper covers both shapes cleanly. | `packages/s3/src/s3-errors.ts`, `packages/gcs/src/gcs-errors.ts` |
| C7 | **LOW** | Middleware `lockedBody` typing is loose: config fields are typed `unknown`, but `buildLockFailureResponse` supports function bodies and `defaultLockedBody` is a function. Note: `unknown \| ((meta) => unknown)` collapses to `unknown` in TypeScript, so a plain union adds no narrowing — the type must be an explicit union of JSON-serializable values plus the function form. | `middleware-config.ts:10,19,27`, `lock-metadata.ts:34`, `middleware-lifecycle.ts:49-52` |
| C8 | **LOW** | `ResolvedRouteConfig.lockName` is redundant: it duplicates `routeConfig.name` and is re-read at `middleware-lifecycle.ts` (`routeConfig?.name ?? resolved.lockName`) before `deriveLockName` overrides it. Remove the field and simplify the call site. | `middleware-config.ts:23,52`, `middleware-lifecycle.ts:44-49` |
| C9 | **LOW** | `middleware-config.ts` imports `parseDuration` mid-file (after declarations) — stylistic inconsistency with the rest of the codebase. | `middleware-config.ts:66-70` |

### 2.2 Improvements

1. **Standardize config-validation errors (C1).** All provider `resolve*Configuration` functions and factories throw `LockException` (message prefixed with the provider name, e.g., `SpannerConfiguration: ...`). `LockException` already extends `Error`, so `catch (e)` remains compatible; this is a strict improvement in catchability. Add a shared `assertNonEmpty(value, label)` / `assertIdentifier` helper in `@tslock/core` (or `sql-support` where SQL-specific) to remove the per-provider copy-paste validation.
2. **Unify `updateRecord` "missing" semantics (C2, F3).** Document and enforce the **Couchbase/S3/GCS pattern**: `updateRecord` must propagate "record missing" as an exception (a `LockException('Lock record not found: <name>')` or the driver's native not-found error), so callers can distinguish "missing" from "held" and act (loud failure instead of silent permanent skip). Additionally — **core change, in scope**: `StorageBasedLockProvider.lock()` clears the registry cache on **any** `updateRecord` exception, not only the `justInserted` path, so a warm registry self-heals after external record deletion (today the S3/GCS/Couchbase throw propagates but leaves the cache stuck until manual `clearCache`). Firestore, Datastore, and Spanner accessors change `return false` → `throw` on missing. **Note:** the AGENTS.md review findings flag only S3 (09), GCS (10), and Spanner (06) for this issue; extending it to Firestore (07) and Datastore (08) is a deliberate uniformity decision — the plan must verify ShedLock's own Firestore/Datastore `update` behavior first and document parity. SQL/Cassandra/Neo4j accessors are unaffected (row-count 0 is the correct "not updated" signal for their atomic UPDATE/CQL — missing vs. held are not distinguishable at the storage layer, which matches ShedLock).
3. **Fix reentrancy detection (C3).** `LockAssert.alreadyLockedBy(name)` scans the whole stack (`stack.includes(name)`), matching ShedLock and the architecture doc. Add a unit test for nested different-name reentrancy (`foo` → `bar` → `foo` runs the inner `foo` task without re-acquiring).
4. **Real hostname in Redis value (C4).** `InternalRedisLockProvider.lock()` uses `Utils.getHostname()` instead of the literal `'tslock'`. `buildValue` signature unchanged.
5. **Shared TTL helper (C5).** Add `Utils.toTtlSeconds(ms)` (or a dedicated `duration.ts` helper) implementing `Math.floor(ms / 1000) + 1` with documented rationale (never expire early; matches ShedLock's Memcached convention per review-20, applied uniformly to Etcd). Migrate Memcached and Etcd call sites. `RedisLock`/`middleware` `retryAfterSeconds` keep their existing `Math.ceil` semantics (different meaning: ceiling seconds-until-expiry for a header, not a storage TTL).
6. **Tighten middleware `lockedBody` typing (C7).** Define in `middleware-core`: `type StaticLockedBody = string | number | boolean | null | Record<string, unknown> | unknown[]` and `type LockedBody = StaticLockedBody | ((meta: LockMetadata) => unknown)` — a union that actually narrows (plain `unknown | fn` collapses to `unknown` and provides no type safety). Use `LockedBody` for `MiddlewareConfig.defaultLockedBody`, `RouteLockConfig.lockedBody`, and `ResolvedRouteConfig.lockedBody`. `buildLockFailureResponse` already handles the function case at runtime; the new type makes it compile-time visible. The plan must verify no consumer relies on non-JSON bodies (Date/Map/class instances), which would need a cast and never serialized reliably via `res.json` anyway.
7. **Cleanup (C8, C9).** Remove `ResolvedRouteConfig.lockName` and simplify the `deriveLockName` call site to use `routeConfig?.name` directly; hoist the mid-file import.

### 2.3 Acceptance Criteria

- All config resolvers throw `LockException` (test: assert `instanceof LockException` and message prefix).
- Firestore/Datastore/Spanner integration tests include a case: delete the lock record externally, then `lock()` must either re-create it (self-heal) or throw a clear error — never silently return `undefined` forever. S3/GCS/Couchbase tests already cover the throw path.
- Nested reentrancy unit test passes in `@tslock/core`.
- Redis value contains the real hostname (unit test).

---

## 3. Modularity

### 3.1 Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| M1 | **MEDIUM** | Test-only code lives in the production core package: `LockAssert.TestHelper.makeAllAssertsPass` uses a magic `SENTINEL` and `enterWith` to fake "locked" state for tests. This is a test double shipped inside `@tslock/core`, increasing core's surface area and confusing the boundary between library and test-support. | `packages/core/src/lock-assert.ts:30-40` |
| M2 | **LOW** | `@tslock/core` declares no `sideEffects: false` and no `./package.json` export in `exports` — minor tree-shaking/tooling friction. | `packages/core/package.json` |
| M3 | **LOW** | `LockAssert.storage` is a public static field (implementation detail) while `LockExtender.storage` is private — inconsistent visibility for the same pattern. | `lock-assert.ts:11`, `lock-extender.ts:8` |
| M4 | **INFO** | `s3-errors`/`gcs-errors` duplication (C6) is a modularity question: whether to extract a shared `cloud-error-classifier` module. Kept as a decision point — see §2.2 C6 (extract only if a clean single abstraction exists; otherwise leave as-is and document). | — |

### 3.2 Improvements

1. **Move test double out of core (M1).** Relocate `LockAssert.TestHelper` semantics into `@tslock/test-support` (it already depends on `@tslock/core`). Core's own unit tests either use the real `LockAssert.runWithLock` or keep a minimal local helper. **Backward-compat note:** `LockAssert.TestHelper` was never part of the public API docs (`core/src/index.ts` does not export the namespace explicitly — it is accessible only via the exported `LockAssert` class). Verify no consumers rely on it; if needed, keep a deprecated re-export in core behind a `@deprecated` JSDoc for one minor version. The `SENTINEL` approach should be replaced by a proper helper that pushes a real lock context.
2. **Package.json hygiene (M2).** Add `"sideEffects": false` to `@tslock/core` (all modules are side-effect-free) and to other packages where trivially true. Add `"./package.json": "./package.json"` to the `exports` map of `@tslock/core`. Verify with a tree-shaking smoke test (bundled output of a provider + core should not include unused exports).
3. **Internal visibility (M3).** For v1.x, keep `LockAssert.storage` accessible but document it as `@internal` (deprecated for external use) rather than making it truly private — the test-support helper relocated from M1 still needs a defined access path into the `AsyncLocalStorage` store, and the store is shared with `LockExtender` internals. Full privatization lands with the v2 ALS-store merge (see P3/future work). This deliberately aligns with P3, which keeps the field for compatibility.

### 3.3 Acceptance Criteria

- `@tslock/core` has zero test-only exports in its documented public API; `LockAssert` exposes only `assertLocked`, `alreadyLockedBy`, `runWithLock` (plus `storage`, `@internal`-documented).
- `pnpm -r typecheck`, `pnpm -r test`, `pnpm -r build` pass after the move.
- Tree-shaking smoke test passes.

---

## 4. Security

### 4.1 Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| S1 | **MEDIUM** | Redis lock ownership token uses `Math.random()` — not cryptographically strong. `safeUpdate` Lua compares the stored value; a guessable token weakens ownership verification (an attacker who can read or influence keys could forge a value that passes `DEL_IF_EQUALS`). ShedLock uses `UUID.randomUUID()`. | `packages/redis-core/src/internal-redis-lock-provider.ts:79` |
| S2 | **MEDIUM** | Lock names are validated only for non-empty in `createLockConfig`. Names flow into Redis keys, S3 object keys, znode paths, document IDs, and SQL columns with **no length or charset limit** — potential for oversized keys (Redis 512MB key limit, S3 1024-byte key limit), pathological znode paths, or control characters. | `packages/core/src/lock-configuration.ts:29-31` |
| S3 | **LOW** | CI does not run `pnpm audit` — no dependency vulnerability scanning. | `.github/workflows/ci.yml` |
| S4 | **LOW** | CI uses `pnpm install` without `--frozen-lockfile` — lockfile drift can silently change dependency resolution. | `.github/workflows/ci.yml` |
| S5 | **INFO** | `pnpm-workspace.yaml` already restricts build scripts via `allowBuilds` (supply-chain hardening) — good. `zookeeper: false` means the `zk` driver's postinstall is blocked; verify the zookeeper package still functions with the pure-JS fallback or document why it's disabled. | `pnpm-workspace.yaml` |
| S6 | **INFO** | No secrets/env in `src/` (0 `process.env` matches) — config is explicit-only. This is a strength; preserve it. | repo-wide grep |

### 4.2 Improvements

1. **Crypto-strength ownership token (S1).** Use `crypto.randomUUID()` (or `randomBytes`) for the Redis value's `randomId` part in `InternalRedisLockProvider.lock()`. Zero API change. Optionally extend to any other provider that builds an ownership value (audit: Memcached/Etcd values embed hostname + timestamp only, no random component — acceptable since their unlock operations are not value-verified; document this reasoning).
2. **Lock-name validation in core (S2).** Add to `createLockConfig` (and document): reject control characters (`/[\p{Cc}\p{Cf}]/u`) and enforce a **max length of 1024 bytes (UTF-8)** — chosen because it is below the tightest common backend constraint (S3 object-key limit 1024 bytes) while far above any realistic cron-task name. Throw `LockException` with a clear message. Note: names exceeding 1024 bytes were never usable in S3; other backends accept longer names, so document the new limit in each affected provider README. Keep the check in one shared function so providers can reuse it (`Utils.validateLockName(name)`).
3. **CI: `pnpm audit` (S3).** Add `pnpm audit --prod` as a step (non-blocking `continue-on-error: true` at first, or blocking once the baseline is clean — decide in plan). Add `pnpm install --frozen-lockfile` in CI (S4).
4. **Verify `allowBuilds` (S5).** Confirm the zookeeper package installs and its unit tests pass under `allowBuilds: { zookeeper: false }`; if the driver requires postinstall, either add a `zk` allow entry with a documented reason or document the limitation.
5. **Verify publish-time peer rewrite (INFO).** `@tslock/test-support` declares `"peerDependencies": { "@tslock/core": "workspace:*" }` — confirm pnpm rewrites `workspace:*` to a real range at publish time (or change to `^1.x`) so consumers can install the published package. Add a check to the release checklist in spec 23.

### 4.3 Acceptance Criteria

- Redis value random segment matches a UUID format in unit tests (or `crypto.randomUUID` is spied).
- `createLockConfig('x'.repeat(2000), ...)` throws; control-char name throws; normal names pass. Tests in `@tslock/core`.
- CI runs `pnpm audit --prod` and `pnpm install --frozen-lockfile`.
- Zookeeper install + unit tests verified (documented in plan).

---

## 5. Resilience

### 5.1 Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| R1 | **CRITICAL** | **Unhandled rejection in `KeepAliveLock` can crash the process.** The keep-alive interval callback calls the async `extendForNextPeriod()` with no try/catch. If the backing store errors during `extend()` (transient Redis/SQL outage), the returned promise rejects, nothing handles it, and under Node 22's default `--unhandled-rejections=throw` the process terminates — taking down the whole application, not just the lock. | `packages/core/src/keep-alive-lock-provider.ts:26-29,35-47` |
| R2 | **HIGH** | Unlock errors are **silently swallowed** in `DefaultLockingTaskExecutor` (`catch {}`) and listener errors are swallowed by `safeEmit` (`catch {}`). The task result is preserved (correct), but there is zero observability: operators cannot tell that a lock was not released (which means the task may not run next cycle until `lockAtMostFor` expires). | `packages/core/src/locking-task-executor.ts:36-40,91-93` |
| R3 | **MEDIUM** | On keep-alive extend failure or `extend()` returning `undefined`, `KeepAliveLock` deactivates **silently** (no notification). The running task continues without lock protection; the user has no signal that the lock was lost mid-task. | `packages/core/src/keep-alive-lock-provider.ts:37-47` |
| R4 | **INFO** | `DefaultScheduler` correctly `unref()`s the interval (does not hold the process open) — strength; preserve. | `packages/core/src/scheduler.ts:10-18` |

### 5.2 Improvements

1. **Harden the keep-alive loop (R1, R3).** Wrap `extendForNextPeriod`'s body in try/catch. On error: (a) stop the interval (deactivate) or retry with bounded backoff (decide in plan — recommendation: stop on repeated failure, keep a single retry for transient errors); (b) surface the failure through a new optional hook. Add an optional `onKeepAliveFailure?: (config, error) => void` constructor option to `KeepAliveLockProvider` (default no-op) — backward-compatible, mirrors `LockingTaskExecutorListener` philosophy. Also deactivate-and-notify when `extend()` returns `undefined` (lock lost).
2. **Unlock/observer errors observability (R2).** Add an optional method to `LockingTaskExecutorListener`: `onUnlockError?(config: LockConfiguration, error: unknown): void` — **optional**, so existing listener implementations remain source-compatible (this is the one place a new optional member is acceptable; adding a required member would break implementors, so it must be optional). `DefaultLockingTaskExecutor` calls it from the `finally` block when `lock.unlock()` throws. Keep swallowing the error (task result preserved) but now it is observable. Update `NO_OP_LISTENER` (no-op) and document in core README.
3. **Listeners are best-effort (R2 cont.).** Keep `safeEmit` semantics but log nothing in core (zero-dependency policy); the listener hook from #2 is the observability path. Document this clearly.

### 5.3 Acceptance Criteria

- Unit test: keep-alive interval callback throws (fake scheduler + mock provider that rejects `extend()`) → no unhandled rejection, interval stopped, `onKeepAliveFailure` called, task's `unlock()` still works.
- Unit test: `lock.unlock()` rejects → executor still returns the task result and `listener.onUnlockError` was invoked with the error.
- No new runtime dependencies in `@tslock/core`.

---

## 6. Fault Tolerance

### 6.1 Findings

| # | Severity | Finding | Evidence |
|---|---|---|---|
| F1 | **HIGH** | **Redis unlock ignores `lockAtLeastFor`.** `RedisLock.doUnlock` deletes the key unconditionally (via `DEL_IF_EQUALS_SCRIPT` or `deleteKey`). ShedLock keeps the key with a `PEXPIRE` for the remaining `lockAtLeastFor` when the lock must be held at least until `lockAtLeastUntil`. The shared integration contract `shouldLockAtLeastFor` would fail — but **no Redis integration test exists** (redis/redis-ioredis have no `test:integration` script), so this is undetected. Review 16 flagged the `safeUpdate` variant; the missing-`lockAtLeastFor` behavior is the same class of bug. | `packages/redis-core/src/internal-redis-lock-provider.ts:69-73`, `scripts.ts`, `redis/package.json` (no integration script) |
| F2 | **MEDIUM** | Integration-test coverage is nearly absent: only **2 of 33** packages define `test:integration` (datastore, firestore). The shared contract in `@tslock/test-support` is not exercised for 31 packages. CI runs only unit tests. Core fault-tolerance behavior (self-heal, `lockAtLeastFor`, extension races) is unverified against real backends. | package.json grep, `.github/workflows/ci.yml` |
| F3 | **HIGH** | `updateRecord` "missing" inconsistency (C2) is a fault-tolerance defect: Firestore/Datastore/Spanner silently return `undefined` forever after external record deletion (registry cache never clears, no error). See C2. | firestore/datastore/spanner accessors |
| F4 | **INFO** | Middleware failure path computes `lockUntil = now + lockAtMostFor` — an approximation (the actual holder's expiry is unknown from `lock()` returning `undefined`). Acceptable and documented; revisit only if a future API returns lock metadata. | `middleware-lifecycle.ts:53-57` |
| F5 | **INFO** | Express adapter has a `lockAtMostFor`-based handler timeout (good); Koa/Hono rely on `await next()` — a never-resolving handler holds the lock until natural expiry (acceptable, matches ShedLock). | `packages/express/src/express-lock-factory.ts:42-50` |

### 6.2 Improvements

1. **Fix Redis unlock `lockAtLeastFor` (F1).** `RedisLock.doUnlock`: if `lockAtLeastUntil(config) > now`, keep the key for the remaining time — with `safeUpdate=true` use a new Lua script `KEEP_IF_EQUALS_SCRIPT` (get == value → pexpire remaining); with `safeUpdate=false` use `setIfPresent(key, value, remainingMs)` (or `SET XX PX`). Add the missing Redis integration tests: wire `lockProviderIntegrationTests` from `@tslock/test-support` into both `@tslock/redis` and `@tslock/redis-ioredis` (a real Redis container in CI or a documented local run), which covers `shouldLockAtLeastFor` and the fuzz contract.
2. **Expand integration coverage (F2).** Priority order (plan decides based on Docker/emulator availability): (1) Redis + redis-ioredis (real Redis container — highest value, F1 depends on it), (2) in-memory (trivial, zero infra), (3) mongo, (4) sql (postgres via testcontainers), (5) dynamodb/s3 via LocalStack, (6) memcached/etcd/nats/hazelcast/zookeeper/couchbase/arangodb/neo4j/cassandra/elasticsearch/opensearch via containers where drivers permit. Middleware integration tests (already present for express/fastify/koa/hono) stay as-is. Add a `pnpm -r test:integration` aggregate script and a CI job (can be `workflow_dispatch`/scheduled if Docker cost is a concern — decide in plan).
3. **Fix `updateRecord` missing semantics (F3).** See C2 — the same change resolves F3.
4. **Document approximations (F4, F5).** Keep current behavior; add explicit notes in middleware README about `lockUntil` approximation and handler-hang semantics.

### 6.3 Acceptance Criteria

- `shouldLockAtLeastFor` passes against a real Redis for both `@tslock/redis` and `@tslock/redis-ioredis` (integration test added).
- `pnpm -r test:integration` runs the shared contract for at least the priority-1 packages, documented in README.
- Firestore/Datastore/Spanner: externally-deleted record → `lock()` self-heals (re-inserts) or throws clearly; never silent permanent `undefined` (integration test).

---

## 7. Compatibility Guarantees

All changes in this spec are backward-compatible v1.x:

| Change | Compat reason |
|---|---|
| Config resolvers throw `LockException` instead of `Error` | `LockException extends Error`; catch sites unchanged |
| `alreadyLockedBy` scans full stack | Only changes nested reentrancy outcomes (runs instead of skips); documented as a fix toward ShedLock parity |
| Redis `randomId` uses `crypto.randomUUID` | Format of stored value unchanged |
| Lock-name validation (max 1024 bytes, no control chars) | Names that previously worked in all backends remain valid; oversized/control-char names were already broken or unsupported (document per-provider) |
| `LockingTaskExecutorListener.onUnlockError?` | Optional member — existing implementations compile unchanged |
| `KeepAliveLockProvider` gets optional `onKeepAliveFailure` option | New optional constructor parameter with default |
| `LockAssert.storage` documented `@internal` (stays accessible in v1.x) | No behavior change; full privatization deferred to v2 (see M3) |
| `Utils.getHostname()` memoized | Same return value semantics |
| `lockedBody` type narrows to `StaticLockedBody \| ((meta) => unknown)` (JSON values + function form) | Static JSON bodies still assignable; exotic non-JSON values (Date/Map/class instances) require a cast — they never serialized reliably via `res.json` anyway; verify in plan |
| TTL helper migration (memcached/etcd) | Memcached unchanged (already floor+1). Etcd moves `ceil` → `floor+1`: lease TTL grows by up to +1s for exact-second durations (e.g., `30s` → 31s) — safe direction (never early-expire); documented in README |

Each change ships with a changeset (lockstep versioning per spec 23). Breaking items (e.g., merging ALS stores if it changes public `storage` semantics, moving `TestHelper` without a deprecated shim) are explicitly deferred to v2.

## 8. File Structure Impact

| File(s) | Change |
|---|---|
| `packages/core/src/utils.ts` | Memoize hostname; add `toTtlSeconds`, `validateLockName` |
| `packages/core/src/lock-assert.ts` | Full-stack `alreadyLockedBy`; `@internal`-document `storage`; remove/relocate `TestHelper` |
| `packages/core/src/keep-alive-lock-provider.ts` | try/catch + retry/deactivate + `onKeepAliveFailure` |
| `packages/core/src/locking-task-executor.ts` | `onUnlockError` listener hook |
| `packages/core/src/locking-task-executor-listener.ts` | optional `onUnlockError` |
| `packages/core/src/lock-configuration.ts` | name validation (length/charset) |
| `packages/core/package.json` | `sideEffects: false`, `./package.json` export |
| `packages/redis-core/src/internal-redis-lock-provider.ts` | real hostname, `crypto.randomUUID`, `lockAtLeastFor`-aware unlock + `KEEP_IF_EQUALS_SCRIPT` |
| `packages/redis/`, `packages/redis-ioredis/` | integration tests wiring the shared contract |
| `packages/{firestore,datastore,spanner}/src/*-storage-accessor.ts` | `updateRecord` throws on missing |
| `packages/{s3,gcs,cassandra,sql-support,spanner,datastore,firestore,dynamodb,memcached,neo4j}/src/*-configuration.ts` | `LockException` for validation; shared validation helpers |
| `packages/memcached/src/*`, `packages/etcd/src/etcd-accessor.ts` | `Utils.toTtlSeconds` migration |
| `packages/middleware-core/src/*` | pre-resolved durations + per-route cache; `LockedBody` type; remove dead `lockName`; hoist import |
| `benchmarks/` (new) | benchmark script + README; excluded from `pnpm -r build/test/typecheck` aggregates (see Non-Goals) |
| `.github/workflows/ci.yml` | `--frozen-lockfile`, `pnpm audit`, optional integration job |
| READMEs | per-package notes for name-length limit, integration-test instructions |

## 9. Test Plan

### Unit tests

1. **core:** keep-alive failure path (no unhandled rejection, hook called, interval stopped); `onUnlockError` invoked on unlock failure while task result preserved; `alreadyLockedBy` full-stack nested case; name validation (control chars, 1024-byte boundary, normal); `Utils.toTtlSeconds`; memoized hostname.
2. **redis-core:** unlock keeps key with remaining `lockAtLeastFor` (mock `RedisTemplate`, assert `eval`/`setIfPresent` args); value contains hostname + UUID.
3. **config resolvers:** every provider's resolver throws `LockException` (assert message prefix).
4. **middleware-core:** zero `parseDuration` calls on hot path when defaults apply; `LockedBody` function typing; route-config cache hit/miss.
5. **providers (accessors):** firestore/datastore/spanner `updateRecord` throws on missing (mocked driver).

### Integration tests

- Redis + redis-ioredis: full shared contract `lockProviderIntegrationTests` (includes `shouldLockAtLeastFor`, fuzz) against a real container.
- Firestore/Datastore/Spanner: external-delete self-heal case added to their integration suites (firestore/datastore already have scripts; spanner gains one or documents emulator-less limitation).
- Verify existing suites (all 73 test files) still pass unchanged.

### Verification commands

```bash
pnpm -r typecheck
pnpm -r lint
pnpm -r test
pnpm -r test:integration   # priority-1 packages at minimum
pnpm -r build
```

## 10. Dependencies

- **No new runtime dependencies.** `crypto.randomUUID` is built-in Node.
- Dev-only additions as needed for integration tests (e.g., Redis container wiring via `testcontainers` in the redis packages' devDependencies, matching existing datastore/firestore setup).
- `@tslock/core` remains zero-dependency.

## 11. Non-Goals (v1.x)

- **No breaking API changes** — see §7 for what is deliberately deferred to v2.
- **No new providers or middleware frameworks.**
- **No metrics framework** — the `onUnlockError`/`onKeepAliveFailure` hooks and existing listener are the extension points; official metrics packages stay v2.
- **No retry/backoff library** — keep-alive retry is a bounded, hand-rolled loop; no `p-retry`-style dependency.
- **No operation-level timeouts on storage calls** — drivers own their timeouts; adding library-level timeouts is a v2 design question.
- **No changes to the SQL statement contracts** (`SqlStatementsSource`) or provider driver choices.
- **No benchmark gating in CI** — benchmarks are a measurement tool, not a gate, in v1.x.
- **No aggregate-script breakage from benchmarks** — the `benchmarks/` workspace is excluded from `pnpm -r build/test/typecheck` (or shaped to pass them) so the new harness never blocks CI.

## 12. Future Work (v2 candidates)

- Merge `LockAssert`/`LockExtender` ALS stores into one context (perf) if profiling justifies it.
- Optional lock-acquisition timeouts and storage-call `AbortSignal` support.
- Official metrics packages (Prometheus/OpenTelemetry) on top of the listener hooks.
- Return actual lock metadata from `lock()` (fixes the middleware `lockUntil` approximation, F4) — requires a breaking change to `LockProvider.lock` return type.
- Moving `LockAssert.TestHelper` without a deprecated shim (breaking) and any other removals.

## 13. Open Decisions (for Plan)

| Decision | Options | Recommendation |
|---|---|---|
| Keep-alive failure policy | (a) stop immediately, (b) one retry then stop, (c) retry with backoff | (b) — balances transient-error tolerance with fail-fast |
| `pnpm audit` blocking vs non-blocking | block CI on high/critical vs `continue-on-error` | non-blocking initially; tighten after baseline clean |
| CI integration job | always-on vs `workflow_dispatch`/scheduled | scheduled or on-demand for container-based suites; always-on for redis/in-memory |
| `updateRecord` missing → throw vs self-heal re-insert | throw (Couchbase/S3 pattern) vs auto-reinsert | throw — matches established pattern, keeps single-writer semantics |
