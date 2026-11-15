# @tslock/opensearch

## 2.4.0

### Patch Changes

- [#145](https://github.com/drmaas/tslock/pull/145) [`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7) Thanks [@drmaas](https://github.com/drmaas)! - Publish internal `@tslock/*` dependencies and peer dependencies as caret ranges (`^x.y.z`) instead of exact versions. An app can install a newer patch of `@tslock/core` alongside another `@tslock` package without an `ERESOLVE` failure or a second copy of core. A second copy breaks `LockAssert`, because its lock stack lives on a class-static `AsyncLocalStorage`.

- [#115](https://github.com/drmaas/tslock/pull/115) [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac) Thanks [@drmaas](https://github.com/drmaas)! - Expose CommonJS and ESM type declarations on separate `require` and `import` export conditions so `node16` CommonJS projects can import every package.

- [#123](https://github.com/drmaas/tslock/pull/123) [`847f671`](https://github.com/drmaas/tslock/commit/847f671728e7c686062f08b5d609fcecadd016c2) Thanks [@drmaas](https://github.com/drmaas)! - Share one Elasticsearch and OpenSearch lock accessor. `SearchLockAccessor` in `@tslock/search-core` owns lock, extend, and unlock. Each provider keeps a thin client adapter for its update envelope.

- [#128](https://github.com/drmaas/tslock/pull/128) [`f3e8951`](https://github.com/drmaas/tslock/commit/f3e895193ed3fb1c7d509305ebfc7f561c04b02c) Thanks [@drmaas](https://github.com/drmaas)! - Unlock updates `lockUntil` only when the stored owner is this caller. Mongo filters the update by `lockedBy`. DynamoDB conditions the update on `lockedBy`. ArangoDB skips a different owner and updates with the document revision. Elasticsearch and OpenSearch unlock scripts set `lockUntil` only when `lockedBy` matches.
- Updated dependencies [[`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7), [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac), [`e20e15b`](https://github.com/drmaas/tslock/commit/e20e15b800b11f7e1297a23e9c150559b9124d95), [`fb35207`](https://github.com/drmaas/tslock/commit/fb35207a91a77c4dfb5a35eeda7aef9d2ae91fc8), [`add6d2e`](https://github.com/drmaas/tslock/commit/add6d2e20be64e7503002782f5fa917cf809b13e), [`847f671`](https://github.com/drmaas/tslock/commit/847f671728e7c686062f08b5d609fcecadd016c2), [`76988b1`](https://github.com/drmaas/tslock/commit/76988b168a725fafab6b39d5ee98005ce938c11a), [`b38203b`](https://github.com/drmaas/tslock/commit/b38203be0006bd5bff243da6d8d7193d07db8032), [`a56e460`](https://github.com/drmaas/tslock/commit/a56e460e5997bbb0a729cd246c75bdff7f2b78d2), [`f3e8951`](https://github.com/drmaas/tslock/commit/f3e895193ed3fb1c7d509305ebfc7f561c04b02c)]:
  - @tslock/core@2.4.0
  - @tslock/search-core@2.4.0

## 2.3.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.3.1
  - @tslock/search-core@2.3.1

## 2.3.0

### Patch Changes

- [#86](https://github.com/drmaas/tslock/pull/86) [`cb95d37`](https://github.com/drmaas/tslock/commit/cb95d37cea0a82a3621947c92292d6f89a8927d8) Thanks [@drmaas](https://github.com/drmaas)! - Replace six copy-pasted provider lock classes with core `DelegatingSimpleLock`.
- Updated dependencies [[`cb95d37`](https://github.com/drmaas/tslock/commit/cb95d37cea0a82a3621947c92292d6f89a8927d8)]:
  - @tslock/core@2.3.0
  - @tslock/search-core@2.3.0

## 2.2.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.2.1
  - @tslock/search-core@2.2.1

## 2.2.0

### Minor Changes

- shared Painless scripts, field-name presets, HTTP status helpers moved to @tslock/search-core. Provider public exports stay compatible via type aliases

### Patch Changes

- [#79](https://github.com/drmaas/tslock/pull/79) [`83b8149`](https://github.com/drmaas/tslock/commit/83b8149596b626742f2a6f71314dcde5d856daf1) Thanks [@drmaas](https://github.com/drmaas)! - Extract shared Elasticsearch/OpenSearch Painless scripts, field-name presets, and HTTP status helpers into `@tslock/search-core`. Provider public exports stay compatible via type aliases.
- Updated dependencies [[`83b8149`](https://github.com/drmaas/tslock/commit/83b8149596b626742f2a6f71314dcde5d856daf1)]:
  - @tslock/search-core@2.2.0
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
