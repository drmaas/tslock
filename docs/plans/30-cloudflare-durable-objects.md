# Plan: @tslock/cloudflare-do

Follows `docs/specs/30-cloudflare-durable-objects.md`. Issue #47. Workers KV deferred.

## Ordered steps

1. **Package scaffold** — `packages/cloudflare-do/` with standard dual-format tooling.
2. **Protocol + storage types** — `src/protocol.ts`, `src/do-lock-storage.ts`.
3. **Handler** — `src/handle-lock-request.ts` implementing lock/unlock/extend against `DoLockStorage`.
4. **Durable Object class** — `src/tslock-lock-durable-object.ts` thin wrapper using structural storage adapter for Workers `ctx.storage`.
5. **Client provider** — `src/cloudflare-do-lock-provider.ts`, `src/cloudflare-do-lock.ts`, `createCloudflareDoLockProvider`.
6. **Exports** — `src/index.ts`.
7. **Unit tests** — handler + provider.
8. **README** — Worker example, KV deferred, Bun note pointer.
9. **Changeset** — minor.
10. **Matrix / architecture** — Category J in vision + README (shared #47 docs batch).

## Files to create

| Path | Purpose |
|---|---|
| `packages/cloudflare-do/package.json` | Manifest |
| `packages/cloudflare-do/tsconfig.json` | Extends base |
| `packages/cloudflare-do/tsup.config.ts` | Dual ESM+CJS |
| `packages/cloudflare-do/vitest.config.ts` | Unit |
| `packages/cloudflare-do/src/*.ts` | Implementation |
| `packages/cloudflare-do/__tests__/*.ts` | Tests |
| `packages/cloudflare-do/README.md` | User docs |
| `.changeset/cloudflare-do.md` | Release note |

## Verification

```bash
pnpm --filter @tslock/cloudflare-do typecheck
pnpm --filter @tslock/cloudflare-do test
pnpm --filter @tslock/cloudflare-do build
```

## Risks

- Workers types: keep DO class free of hard `cloudflare:workers` imports so Node CI typechecks; use duck-typed storage.
- Clock skew between client `createdAt` and DO `Date.now()` — document NTP requirement (same as rest of TSLock).

## Follow-up

Open or note in PR: Workers KV provider deferred; link from README.
