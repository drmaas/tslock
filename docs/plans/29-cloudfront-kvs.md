# Plan: @tslock/cloudfront-kvs

Follows `docs/specs/29-cloudfront-kvs.md`. Issue #47.

## Ordered steps

1. **Package scaffold** — `packages/cloudfront-kvs/` with `package.json`, `tsconfig.json`, `tsup.config.ts`, `vitest` configs, Apache-2.0 aligned metadata, `engines.node >= 22`.
2. **Configuration** — `src/cloudfront-kvs-configuration.ts`: options interface, `resolveCloudFrontKvsConfiguration`, frozen defaults (`keyPrefix: 'tslock/'`, `maxEtagRetries: 3`).
3. **Errors / helpers** — `src/cloudfront-kvs-errors.ts`: detect `ConflictException`, `ResourceNotFoundException`; `src/lock-record.ts`: encode/decode JSON lock value.
4. **Accessor / provider** — `src/cloudfront-kvs-lock-provider.ts` + `src/cloudfront-kvs-lock.ts`: Describe → GetKey → PutKey with ETag retry loop; unlock/extend as specified.
5. **Exports** — `src/index.ts`.
6. **Unit tests** — `__tests__/cloudfront-kvs-lock-provider.test.ts` (and config/encode tests as needed).
7. **Integration harness** — `__tests__/integration/cloudfront-kvs.integration.test.ts` gated by env; wire `@tslock/test-support` contracts.
8. **README** — limits, Functions vs control plane, redis-compat note.
9. **Changeset** — minor for `@tslock/cloudfront-kvs`.
10. **Matrix docs** — root README, `docs/00-vision.md`, architecture Category B note (same PR as #47 docs batch).

## Files to create

| Path | Purpose |
|---|---|
| `packages/cloudfront-kvs/package.json` | Package manifest + peers |
| `packages/cloudfront-kvs/tsconfig.json` | Extends base |
| `packages/cloudfront-kvs/tsup.config.ts` | Dual ESM+CJS |
| `packages/cloudfront-kvs/vitest.config.ts` | Unit |
| `packages/cloudfront-kvs/vitest.integration.config.ts` | Opt-in integration |
| `packages/cloudfront-kvs/src/index.ts` | Public exports |
| `packages/cloudfront-kvs/src/cloudfront-kvs-configuration.ts` | Config |
| `packages/cloudfront-kvs/src/cloudfront-kvs-errors.ts` | Error helpers |
| `packages/cloudfront-kvs/src/lock-record.ts` | Value codec |
| `packages/cloudfront-kvs/src/cloudfront-kvs-lock.ts` | SimpleLock |
| `packages/cloudfront-kvs/src/cloudfront-kvs-lock-provider.ts` | Provider |
| `packages/cloudfront-kvs/__tests__/...` | Unit + integration |
| `packages/cloudfront-kvs/README.md` | User docs |
| `.changeset/cloudfront-kvs.md` | Release note |

## Verification

```bash
pnpm install
pnpm --filter @tslock/cloudfront-kvs typecheck
pnpm --filter @tslock/cloudfront-kvs test
pnpm --filter @tslock/cloudfront-kvs build
pnpm check
```

Integration when credentials available:

```bash
TSLOCK_CLOUDFRONT_KVS_INTEGRATION=1 CLOUDFRONT_KVS_ARN=arn:aws:cloudfront::...:key-value-store/... \
  pnpm --filter @tslock/cloudfront-kvs test:integration
```

## Risks

- Store-wide ETag → false contention under parallel locks on different names; mitigate with retries and README guidance.
- No public emulator; unit tests carry most CI weight.
- SigV4A client misconfiguration surfaces as AWS errors — document in README.

## Rollback

Remove package + changeset + matrix rows; no core API changes.
