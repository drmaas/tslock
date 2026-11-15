# @tslock/core

## 2.4.0

### Minor Changes

- [#127](https://github.com/drmaas/tslock/pull/127) [`e20e15b`](https://github.com/drmaas/tslock/commit/e20e15b800b11f7e1297a23e9c150559b9124d95) Thanks [@drmaas](https://github.com/drmaas)! - Brand `ExtensibleLockProvider` so `KeepAliveLockProvider` only accepts providers that can extend a lock. `TrackingLockProviderWrapper` and OpenTelemetry `instrument` keep that brand only when the wrapped provider is extensible. Constructing keep-alive around a provider that omits the brand throws `LockException` instead of failing on the first renewal. Custom classes that implement `ExtensibleLockProvider` must set `readonly [extensibleLockProvider]: true`.

- [#171](https://github.com/drmaas/tslock/pull/171) [`76988b1`](https://github.com/drmaas/tslock/commit/76988b168a725fafab6b39d5ee98005ce938c11a) Thanks [@drmaas](https://github.com/drmaas)! - Add shared `validateIdentifier()` in core and use it for SQL table/column names plus Cassandra, Neo4j, and Spanner configuration so unsafe identifiers cannot be interpolated into generated SQL.

### Patch Changes

- [#145](https://github.com/drmaas/tslock/pull/145) [`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7) Thanks [@drmaas](https://github.com/drmaas)! - Publish internal `@tslock/*` dependencies and peer dependencies as caret ranges (`^x.y.z`) instead of exact versions. An app can install a newer patch of `@tslock/core` alongside another `@tslock` package without an `ERESOLVE` failure or a second copy of core. A second copy breaks `LockAssert`, because its lock stack lives on a class-static `AsyncLocalStorage`.

- [#115](https://github.com/drmaas/tslock/pull/115) [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac) Thanks [@drmaas](https://github.com/drmaas)! - Expose CommonJS and ESM type declarations on separate `require` and `import` export conditions so `node16` CommonJS projects can import every package.

- [#138](https://github.com/drmaas/tslock/pull/138) [`fb35207`](https://github.com/drmaas/tslock/commit/fb35207a91a77c4dfb5a35eeda7aef9d2ae91fc8) Thanks [@drmaas](https://github.com/drmaas)! - Keep-alive renewals continue past the original `lockAtMostFor`. The interval stops only after the deadline from the latest successful extend has passed, and that stop reports `Keep-alive lock was lost`.

- [#153](https://github.com/drmaas/tslock/pull/153) [`add6d2e`](https://github.com/drmaas/tslock/commit/add6d2e20be64e7503002782f5fa917cf809b13e) Thanks [@drmaas](https://github.com/drmaas)! - `DefaultLockingTaskExecutor` unlocks the lock `LockExtender.extendActiveLock` installed, so a task that extends its lease does not hold it until the new deadline after `executeWithLock` returns. A failed `extend()` leaves the original handle valid so that unlock still runs. `unlock()` on the original handle still throws after a successful `extend()`.

  `KeepAliveLock` skips the wrapped `unlock()` after a renewal returns no lock or the local deadline has already passed, so a later holder keeps the lease. A thrown `extend()` still unlocks.

- [#163](https://github.com/drmaas/tslock/pull/163) [`b38203b`](https://github.com/drmaas/tslock/commit/b38203be0006bd5bff243da6d8d7193d07db8032) Thanks [@drmaas](https://github.com/drmaas)! - Ignore a stale unlock or extend after another process on the same host reacquires the lock. Search (Elasticsearch and OpenSearch), DynamoDB, and ArangoDB now require the stored deadline to match this acquisition. Delegating locks pass the deadline from the acquisition being extended.

- [#155](https://github.com/drmaas/tslock/pull/155) [`a56e460`](https://github.com/drmaas/tslock/commit/a56e460e5997bbb0a729cd246c75bdff7f2b78d2) Thanks [@drmaas](https://github.com/drmaas)! - Ignore a stale unlock or extend after another process on the same host reacquires the lock. S3, GCS, and CloudFront KeyValueStore now require the stored deadline to match this acquisition. `StorageAccessor.extend` takes an optional previous deadline, and storage locks pass the deadline they acquired.

## 2.3.1

No changes in this release.

## 2.3.0

### Minor Changes

- [#86](https://github.com/drmaas/tslock/pull/86) [`cb95d37`](https://github.com/drmaas/tslock/commit/cb95d37cea0a82a3621947c92292d6f89a8927d8) Thanks [@drmaas](https://github.com/drmaas)! - Replace six copy-pasted provider lock classes with core `DelegatingSimpleLock`.

## 2.2.1

### Patch Changes

- Automated patch release via workflow_dispatch.

## 2.2.0

### Minor Changes

- shared Painless scripts, field-name presets, HTTP status helpers moved to @tslock/search-core. Provider public exports stay compatible via type aliases

## 2.1.1

### Patch Changes

- Automated patch release via workflow_dispatch.

## 2.1.0

### Minor Changes

- [#52](https://github.com/drmaas/tslock/pull/52) [`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055) Thanks [@drmaas](https://github.com/drmaas)! - Add a read-only lock health snapshot (`createLockHealthMonitor`) on top of `TrackingLockProviderWrapper` for ops introspection (active locks, last acquire/skip, keep-alive failures, overdue leases).

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

## 2.0.1

### Patch Changes

- - db5f7a8 — test(middleware): bind HTTP integration servers to ephemeral ports — Fixes intermittent EADDRINUSE in Express/Koa suites by using port-0 OS assignment, awaiting close in afterEach, and surfacing listen errors as assertions. Closes [#12](https://github.com/drmaas/tslock/issues/12).

## 2.0.0

### Minor Changes

- Added framework middleware integrations for Express, Fastify, Koa, and Hono, with improved middleware performance, type safety, route configuration, and failure handling. Core and Redis locking behavior has been hardened with safer lock identity generation, lock-name validation, keep-alive retries, unlock-error hooks, correct minimum lock durations, and improved record-update error handling. Provider reliability has also improved across Firestore, Datastore, Spanner, Memcached, etcd, DynamoDB, Neo4j, and Redis, while extensive container-backed integration and concurrency coverage was added for databases, caches, NATS, and middleware adapters. The release also introduces shared integration contracts, fuzz-test improvements, expanded CI/build verification, packed-peer and native-build checks, tree-shaking metadata, benchmarks, dependency updates, and structured contribution workflow tooling.

### Patch Changes

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Harden core and Redis: memoize `Utils.getHostname()`, add `Utils.toTtlSeconds` and `Utils.validateLockName` (control chars + 1024-byte limit, enforced by `createLockConfig`), scan the full stack in `LockAssert.alreadyLockedBy`, clear the `StorageBasedLockProvider` registry on any `updateRecord` exception, relocate `LockAssert.TestHelper` to `@tslock/test-support`, retry keep-alive extensions once before deactivating with an `onKeepAliveFailure` hook, add the optional `onUnlockError` executor listener, use the real hostname + `crypto.randomUUID()` in Redis lock values, and honor `lockAtLeastFor` on Redis unlock via a new `KEEP_IF_EQUALS_SCRIPT`.

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Harden provider behavior: Redis integration contracts are available through opt-in Redis service tests, missing Firestore/Datastore/Spanner records now raise `LockException` during update, provider configuration errors use `LockException`, and Memcached/etcd TTLs use the shared no-early-expiry helper.

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Document lock-name and middleware failure semantics, add package tree-shaking metadata, and provide CI audit, benchmark, and packed-peer verification tooling.

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Make the workspace install deterministic by explicitly denying optional native install scripts pulled in by testcontainers (`cpu-features` and `ssh2`). Standard local Docker-socket integration tests do not require these builds.

## 1.0.2

### Patch Changes

- Fixing lint warnings

## 1.0.1

### Patch Changes

- testing changeset release process
