# @tslock/core

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
