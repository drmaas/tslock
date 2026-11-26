# @tslock/drizzle

## 2.5.0

### Minor Changes

- [#207](https://github.com/drmaas/tslock/pull/207) [`cd7f9ca`](https://github.com/drmaas/tslock/commit/cd7f9caa76ea799c1bf177ccf09feaebd7cb5859) Thanks [@drmaas](https://github.com/drmaas)! - Raise the documented Node.js engine requirement to `>=24`. Node.js 22 is no longer supported.

### Patch Changes

- Updated dependencies [[`cd7f9ca`](https://github.com/drmaas/tslock/commit/cd7f9caa76ea799c1bf177ccf09feaebd7cb5859)]:
  - @tslock/core@2.5.0
  - @tslock/sql-support@2.5.0

## 2.4.0

### Patch Changes

- [#145](https://github.com/drmaas/tslock/pull/145) [`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7) Thanks [@drmaas](https://github.com/drmaas)! - Publish internal `@tslock/*` dependencies and peer dependencies as caret ranges (`^x.y.z`) instead of exact versions. An app can install a newer patch of `@tslock/core` alongside another `@tslock` package without an `ERESOLVE` failure or a second copy of core. A second copy breaks `LockAssert`, because its lock stack lives on a class-static `AsyncLocalStorage`.

- [#115](https://github.com/drmaas/tslock/pull/115) [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac) Thanks [@drmaas](https://github.com/drmaas)! - Expose CommonJS and ESM type declarations on separate `require` and `import` export conditions so `node16` CommonJS projects can import every package.

- [#151](https://github.com/drmaas/tslock/pull/151) [`0d00c03`](https://github.com/drmaas/tslock/commit/0d00c0344c6e05b0faa2a2f92707498e3864f55f) Thanks [@drmaas](https://github.com/drmaas)! - MySQL locks read `affectedRows` from the mysql2 `db.execute()` tuple `[ResultSetHeader, FieldPacket[]]`. Insert, update, and extend now succeed when that header reports a changed row.

- [#171](https://github.com/drmaas/tslock/pull/171) [`76988b1`](https://github.com/drmaas/tslock/commit/76988b168a725fafab6b39d5ee98005ce938c11a) Thanks [@drmaas](https://github.com/drmaas)! - Add shared `validateIdentifier()` in core and use it for SQL table/column names plus Cassandra, Neo4j, and Spanner configuration so unsafe identifiers cannot be interpolated into generated SQL.

- [#157](https://github.com/drmaas/tslock/pull/157) [`20ac2e0`](https://github.com/drmaas/tslock/commit/20ac2e0738c75e5386a664add7210f7d923ec305) Thanks [@drmaas](https://github.com/drmaas)! - Ignore a stale unlock or extend after another process on the same host reacquires a SQL lock. Unlock and extend now require the stored deadline to match this acquisition. SQL Server date parameters are bound as `datetime2` so that equality matches `datetime2` columns.
- Updated dependencies [[`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7), [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac), [`e20e15b`](https://github.com/drmaas/tslock/commit/e20e15b800b11f7e1297a23e9c150559b9124d95), [`fb35207`](https://github.com/drmaas/tslock/commit/fb35207a91a77c4dfb5a35eeda7aef9d2ae91fc8), [`add6d2e`](https://github.com/drmaas/tslock/commit/add6d2e20be64e7503002782f5fa917cf809b13e), [`76988b1`](https://github.com/drmaas/tslock/commit/76988b168a725fafab6b39d5ee98005ce938c11a), [`20ac2e0`](https://github.com/drmaas/tslock/commit/20ac2e0738c75e5386a664add7210f7d923ec305), [`b38203b`](https://github.com/drmaas/tslock/commit/b38203be0006bd5bff243da6d8d7193d07db8032), [`a56e460`](https://github.com/drmaas/tslock/commit/a56e460e5997bbb0a729cd246c75bdff7f2b78d2)]:
  - @tslock/core@2.4.0
  - @tslock/sql-support@2.4.0

## 2.3.1

### Patch Changes

- [#99](https://github.com/drmaas/tslock/pull/99) [`f257941`](https://github.com/drmaas/tslock/commit/f257941bfadb74039a1628b2de086bed18979795) Thanks [@drmaas](https://github.com/drmaas)! - Recognize duplicate-key errors wrapped in drizzle-orm's `DrizzleQueryError` (driver error on `.cause`) so MySQL/SQLite `lock()` returns false instead of throwing once the shedlock row exists.
- Updated dependencies [[`4af83f7`](https://github.com/drmaas/tslock/commit/4af83f7db8365b0964679d9072e7a04c9a0254c4)]:
  - @tslock/sql-support@2.3.1
  - @tslock/core@2.3.1

## 2.3.0

### Patch Changes

- [#90](https://github.com/drmaas/tslock/pull/90) [`bcf016a`](https://github.com/drmaas/tslock/commit/bcf016abaef67d162419cb3610701ceb43729024) Thanks [@drmaas](https://github.com/drmaas)! - Consolidate named-parameter translation in `@tslock/sql-support` and throw `LockException` for missing params across sql, kysely, and drizzle.
- Updated dependencies [[`cb95d37`](https://github.com/drmaas/tslock/commit/cb95d37cea0a82a3621947c92292d6f89a8927d8), [`bcf016a`](https://github.com/drmaas/tslock/commit/bcf016abaef67d162419cb3610701ceb43729024)]:
  - @tslock/core@2.3.0
  - @tslock/sql-support@2.3.0

## 2.2.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.2.1
  - @tslock/sql-support@2.2.1

## 2.2.0

### Minor Changes

- shared Painless scripts, field-name presets, HTTP status helpers moved to @tslock/search-core. Provider public exports stay compatible via type aliases

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.2.0
  - @tslock/sql-support@2.2.0

## 2.1.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.1.1
  - @tslock/sql-support@2.1.1

## 2.1.0

### Minor Changes

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

### Patch Changes

- Updated dependencies [[`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055)]:
  - @tslock/core@2.1.0
  - @tslock/sql-support@2.1.0

## 2.0.1

### Patch Changes

- - db5f7a8 — test(middleware): bind HTTP integration servers to ephemeral ports — Fixes intermittent EADDRINUSE in Express/Koa suites by using port-0 OS assignment, awaiting close in afterEach, and surfacing listen errors as assertions. Closes [#12](https://github.com/drmaas/tslock/issues/12).
  - Updated dependencies [`d51e51c`]:
    - @tslock/core@2.0.1
    - @tslock/sql-support@2.0.1

## 2.0.0

### Minor Changes

- Added framework middleware integrations for Express, Fastify, Koa, and Hono, with improved middleware performance, type safety, route configuration, and failure handling. Core and Redis locking behavior has been hardened with safer lock identity generation, lock-name validation, keep-alive retries, unlock-error hooks, correct minimum lock durations, and improved record-update error handling. Provider reliability has also improved across Firestore, Datastore, Spanner, Memcached, etcd, DynamoDB, Neo4j, and Redis, while extensive container-backed integration and concurrency coverage was added for databases, caches, NATS, and middleware adapters. The release also introduces shared integration contracts, fuzz-test improvements, expanded CI/build verification, packed-peer and native-build checks, tree-shaking metadata, benchmarks, dependency updates, and structured contribution workflow tooling.

### Patch Changes

- [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba) Thanks [@drmaas](https://github.com/drmaas)! - Document lock-name and middleware failure semantics, add package tree-shaking metadata, and provide CI audit, benchmark, and packed-peer verification tooling.

- [`a14b780`](https://github.com/drmaas/tslock/commit/a14b780522b9c19b1dfc1ed5cf163385e25742ff) Thanks [@drmaas](https://github.com/drmaas)! - Add container-backed PostgreSQL storage and concurrency integration coverage for the Drizzle provider.

- Updated dependencies [[`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba), [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba), [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba), [`fd75a75`](https://github.com/drmaas/tslock/commit/fd75a754a74974a60e2dcf4099cf15c3defa1fba)]:
  - @tslock/core@2.0.0
  - @tslock/sql-support@2.0.0

## 1.0.2

### Patch Changes

- Fixing lint warnings

- Updated dependencies []:
  - @tslock/core@1.0.2
  - @tslock/sql-support@1.0.2

## 1.0.1

### Patch Changes

- testing changeset release process

- Updated dependencies []:
  - @tslock/core@1.0.1
  - @tslock/sql-support@1.0.1
