# @tslock/cloudflare-do

## 2.4.0

### Patch Changes

- [#145](https://github.com/drmaas/tslock/pull/145) [`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7) Thanks [@drmaas](https://github.com/drmaas)! - Publish internal `@tslock/*` dependencies and peer dependencies as caret ranges (`^x.y.z`) instead of exact versions. An app can install a newer patch of `@tslock/core` alongside another `@tslock` package without an `ERESOLVE` failure or a second copy of core. A second copy breaks `LockAssert`, because its lock stack lives on a class-static `AsyncLocalStorage`.

- [#115](https://github.com/drmaas/tslock/pull/115) [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac) Thanks [@drmaas](https://github.com/drmaas)! - Expose CommonJS and ESM type declarations on separate `require` and `import` export conditions so `node16` CommonJS projects can import every package.

- [#134](https://github.com/drmaas/tslock/pull/134) [`ef5ba1f`](https://github.com/drmaas/tslock/commit/ef5ba1f3d9404f434a872fcfa1ee9f9b9c82a443) Thanks [@drmaas](https://github.com/drmaas)! - Unlock and extend a Durable Object lock only when the caller sends the token from that acquire. `lockedBy` is stored as a hostname label. A record with no token is left unchanged until it expires. Deploy the Durable Object class and the client together.

- [#147](https://github.com/drmaas/tslock/pull/147) [`7ce64fc`](https://github.com/drmaas/tslock/commit/7ce64fc2da599385a3ac75398e068a29334a23e1) Thanks [@drmaas](https://github.com/drmaas)! - Derive Durable Object lock deadlines from the object clock. Acquire and extend set `lockUntil` from `Date.now()` plus `lockAtMostFor`. Acquire stores `lockAtLeastUntil` from that clock plus `lockAtLeastFor`, and extend only moves that minimum forward. Unlock uses the stored minimum instead of the request clock. Non-finite durations, negative durations, and a minimum hold longer than the maximum are rejected with HTTP 400. A `lockAtMostFor` that does not place `lockUntil` strictly after that clock is not acquired and is not stored. The request body shape is unchanged.
- Updated dependencies [[`b47b809`](https://github.com/drmaas/tslock/commit/b47b80932c8ecec7b235bc7d59402cb825c961c7), [`9f8aabf`](https://github.com/drmaas/tslock/commit/9f8aabf356b04c87ad2524d0c387b75acdfff4ac), [`e20e15b`](https://github.com/drmaas/tslock/commit/e20e15b800b11f7e1297a23e9c150559b9124d95), [`fb35207`](https://github.com/drmaas/tslock/commit/fb35207a91a77c4dfb5a35eeda7aef9d2ae91fc8), [`add6d2e`](https://github.com/drmaas/tslock/commit/add6d2e20be64e7503002782f5fa917cf809b13e), [`76988b1`](https://github.com/drmaas/tslock/commit/76988b168a725fafab6b39d5ee98005ce938c11a), [`b38203b`](https://github.com/drmaas/tslock/commit/b38203be0006bd5bff243da6d8d7193d07db8032), [`a56e460`](https://github.com/drmaas/tslock/commit/a56e460e5997bbb0a729cd246c75bdff7f2b78d2)]:
  - @tslock/core@2.4.0

## 2.3.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.3.1

## 2.3.0

### Patch Changes

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

- [#62](https://github.com/drmaas/tslock/pull/62) [`ae78fc0`](https://github.com/drmaas/tslock/commit/ae78fc092cc0c350a1bf1d0a25b39241c69af5f2) Thanks [@drmaas](https://github.com/drmaas)! - Add `@tslock/cloudflare-do`, a Cloudflare Durable Objects lock provider with a deployable DO handler and fetch-based client (Workers KV deferred).

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

### Patch Changes

- Updated dependencies [[`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055)]:
  - @tslock/core@2.1.0
