# @tslock/aws-lambda

## 2.2.0

### Minor Changes

- shared Painless scripts, field-name presets, HTTP status helpers moved to @tslock/search-core. Provider public exports stay compatible via type aliases

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.2.0
  - @tslock/scheduler-core@2.2.0

## 2.1.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.1.1
  - @tslock/scheduler-core@2.1.1

## 2.1.0

### Minor Changes

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

- [#53](https://github.com/drmaas/tslock/pull/53) [`6e509c8`](https://github.com/drmaas/tslock/commit/6e509c8bfc810ab9a4b3b9ea0d0c6e64b80546a5) Thanks [@drmaas](https://github.com/drmaas)! - Add thin scheduler adapters (`node-cron`, `bree`, AWS Lambda) backed by `@tslock/scheduler-core` so cron and scheduled handlers wrap with `executeWithLock` without putting a scheduler in core.

### Patch Changes

- Updated dependencies [[`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055), [`6e509c8`](https://github.com/drmaas/tslock/commit/6e509c8bfc810ab9a4b3b9ea0d0c6e64b80546a5)]:
  - @tslock/core@2.1.0
  - @tslock/scheduler-core@2.1.0
