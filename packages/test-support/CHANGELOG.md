# @tslock/test-support

## 2.3.0

### Patch Changes

- [#93](https://github.com/drmaas/tslock/pull/93) [`ba74e3d`](https://github.com/drmaas/tslock/commit/ba74e3da4bd6881e5207dc2c110b27d4354ae92b) Thanks [@drmaas](https://github.com/drmaas)! - Make `storageBasedLockProviderIntegrationTests` include the extensible contract so storage-based providers exercise extend.
- Updated dependencies [[`cb95d37`](https://github.com/drmaas/tslock/commit/cb95d37cea0a82a3621947c92292d6f89a8927d8)]:
  - @tslock/core@2.3.0

## 2.2.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.2.1

## 2.2.0

### Minor Changes

- shared Painless scripts, field-name presets, HTTP status helpers moved to @tslock/search-core. Provider public exports stay compatible via type aliases

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.2.0

## 2.1.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.1.1

## 2.1.0

### Minor Changes

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

### Patch Changes

- [#60](https://github.com/drmaas/tslock/pull/60) [`8c4b8cf`](https://github.com/drmaas/tslock/commit/8c4b8cf1d5b394165f8ea0ed88d12aa5589f8f28) Thanks [@drmaas](https://github.com/drmaas)! - Document clock-skew and related failure modes, and add an in-memory harness (`MutableClock` / `withMutableClock`) that asserts documented double-execution scenarios without claiming stronger guarantees than the time-based lock model.
- Updated dependencies [[`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055)]:
  - @tslock/core@2.1.0

## 2.0.1

### Patch Changes

- - db5f7a8 — test(middleware): bind HTTP integration servers to ephemeral ports — Fixes intermittent EADDRINUSE in Express/Koa suites by using port-0 OS assignment, awaiting close in afterEach, and surfacing listen errors as assertions. Closes [#12](https://github.com/drmaas/tslock/issues/12).
- Updated dependencies [`d51e51c`]:
  - @tslock/core@2.0.1

## 2.0.0

### Minor Changes

- Added framework middleware integrations for Express, Fastify, Koa, and Hono, with improved middleware performance, type safety, route configuration, and failure handling. Core and Redis locking behavior has been hardened with safer lock identity generation, lock-name validation, keep-alive retries, unlock-error hooks, correct minimum lock durations, and improved record-update error handling. Provider reliability has also improved across Firestore, Datastore, Spanner, Memcached, etcd, DynamoDB, Neo4j, and Redis, while extensive container-backed integration and concurrency coverage was added for databases, caches, NATS, and middleware adapters. The release also introduces shared integration contracts, fuzz-test improvements, expanded CI/build verification, packed-peer and native-build checks, tree-shaking metadata, benchmarks, dependency updates, and structured contribution workflow tooling.

### Patch Changes

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Harden core and Redis: memoize `Utils.getHostname()`, add `Utils.toTtlSeconds` and `Utils.validateLockName` (control chars + 1024-byte limit, enforced by `createLockConfig`), scan the full stack in `LockAssert.alreadyLockedBy`, clear the `StorageBasedLockProvider` registry on any `updateRecord` exception, relocate `LockAssert.TestHelper` to `@tslock/test-support`, retry keep-alive extensions once before deactivating with an `onKeepAliveFailure` hook, add the optional `onUnlockError` executor listener, use the real hostname + `crypto.randomUUID()` in Redis lock values, and honor `lockAtLeastFor` on Redis unlock via a new `KEEP_IF_EQUALS_SCRIPT`.

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Document lock-name and middleware failure semantics, add package tree-shaking metadata, and provide CI audit, benchmark, and packed-peer verification tooling.

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Make the workspace install deterministic by explicitly denying optional native install scripts pulled in by testcontainers (`cpu-features` and `ssh2`). Standard local Docker-socket integration tests do not require these builds.

- [`5a69cf3`](https://github.com/drmaas/tslock/commit/5a69cf300f8377a8925d2bd51c5f4039413f00ee) Thanks [@drmaas](https://github.com/drmaas)! - Make the fuzz contract account for the logical end of protected work before awaiting network unlock acknowledgements, avoiding false concurrency failures with pipelined clients.

- Updated dependencies [[`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba), [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba), [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba), [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba)]:
  - @tslock/core@2.0.0

## 1.0.2

### Patch Changes

- Fixing lint warnings

- Updated dependencies []:
  - @tslock/core@1.0.2

## 1.0.1

### Patch Changes

- testing changeset release process

- Updated dependencies []:
  - @tslock/core@1.0.1
