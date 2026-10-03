# @tslock/cloudflare-kv

## 2.1.1

### Patch Changes

- Updated dependencies []:
  - @tslock/core@2.1.1

## 2.1.0

### Minor Changes

- [#66](https://github.com/drmaas/tslock/pull/66) [`4b60e8f`](https://github.com/drmaas/tslock/commit/4b60e8fcb783eef1a374c785f19858eddc969bd5) Thanks [@drmaas](https://github.com/drmaas)! - Add `@tslock/cloudflare-kv`, an explicitly best-effort Workers KV lock provider. It uses ownership tokens and a 60-second minimum `expirationTtl`, and it does not provide mutual exclusion. Use `@tslock/cloudflare-do` when locks must not overlap.

- Add @tslock/otel, @tslock/scheduler-core, @tslock/node-cron, @tslock/nestjs, @tslock/bree, @tslock/aws-lambda, @tslock/cloudflare-do, @tslock/cloudflare-kv, and @tslock/cloudfront-kvs, and switch releases to npm trusted publishing.

### Patch Changes

- Updated dependencies [[`41f79fb`](https://github.com/drmaas/tslock/commit/41f79fbdd38e9e7b6e9d00ae5f176798dbacb055)]:
  - @tslock/core@2.1.0
