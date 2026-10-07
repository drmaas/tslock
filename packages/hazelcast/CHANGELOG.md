# @tslock/hazelcast

## 2.3.0

### Patch Changes

- [#86](https://github.com/drmaas/tslock/pull/86) [`cb95d37`](https://github.com/drmaas/tslock/commit/cb95d37cea0a82a3621947c92292d6f89a8927d8) Thanks [@drmaas](https://github.com/drmaas)! - Replace six copy-pasted provider lock classes with core `DelegatingSimpleLock`.
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

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Document lock-name and middleware failure semantics, add package tree-shaking metadata, and provide CI audit, benchmark, and packed-peer verification tooling.

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
