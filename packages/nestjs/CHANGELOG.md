# @tslock/nestjs

## 2.1.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.1.1

## 2.1.0

### Minor Changes

- [#51](https://github.com/drmaas/tslock/pull/51) [`1038249`](https://github.com/drmaas/tslock/commit/1038249994372509a1826a0aa4287c445e033b1f) Thanks [@drmaas](https://github.com/drmaas)! - Add `@tslock/nestjs` with `TslockModule`, a `@SchedulerLock` decorator, and `SchedulerLockInterceptor` so Nest scheduled methods run through `executeWithLock`.

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

### Patch Changes

- [#68](https://github.com/drmaas/tslock/pull/68) [`7e6f1db`](https://github.com/drmaas/tslock/commit/7e6f1db724319c3191daf4eef25733ea81880e6d) Thanks [@dependabot](https://github.com/apps/dependabot)! - Widen NestJS peer dependency ranges to include v12 and test against matching `@nestjs/common`, `@nestjs/core`, and `@nestjs/testing` 12.x.
- Updated dependencies [[`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055)]:
  - @tslock/core@2.1.0
