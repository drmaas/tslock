# Plan: @tslock/cloudflare-kv

Follows `docs/specs/31-cloudflare-kv.md`. Issue #63.

## Ordered steps

1. **Package scaffold** — `packages/cloudflare-kv/` with the same dual-format build as `@tslock/cloudflare-do` (`node ../../scripts/tsup.cjs`, `engines.node >= 22`, peer `@tslock/core` only).
2. **TTL helper** — `kvExpirationTtlSeconds` (minimum 60, `floor(remaining/1000)+1`).
3. **Record codec** — JSON `{ lockUntil, lockedAt, lockedBy, token }` with `LockException` on malformed payloads.
4. **Namespace + REST** — structural `CloudflareKvNamespace` and `createCloudflareKvRestNamespace`.
5. **Configuration** — frozen resolver; `acknowledgeAdvisoryLock: true` required; default prefix `tslock:`; default `confirmWrite: true`.
6. **Provider and lock** — acquire / unlock / extend as specified. Token lives on `CloudflareKvLock`.
7. **Unit, contract, and failure-mode tests** — in-memory namespace, shared extensible contract (`timeMode: 'mock'`), `MutableClock` TTL test, stale-read and delayed-delete fakes, 429 propagation. No `fuzzTests`. No Miniflare.
8. **Docs** — package README, root README, vision, architecture Category K, failure-mode guide, Durable Objects README pointer.
9. **Changeset** — minor `@tslock/cloudflare-kv`.
10. **Lockfile** — `pnpm install` so `pnpm-lock.yaml` lists the new workspace package.

## Files to create

| Path | Purpose |
|---|---|
| `packages/cloudflare-kv/package.json` | Manifest |
| `packages/cloudflare-kv/tsconfig.json` | Extends base |
| `packages/cloudflare-kv/tsup.config.ts` | Dual ESM+CJS |
| `packages/cloudflare-kv/src/*.ts` | Implementation |
| `packages/cloudflare-kv/__tests__/*.ts` | Unit, contract, failure modes |
| `packages/cloudflare-kv/README.md` | Advisory user docs |
| `docs/specs/31-cloudflare-kv.md` | Spec |
| `docs/plans/31-cloudflare-kv.md` | This plan |
| `docs/reviews/31-cloudflare-kv.md` | Review after implementation |
| `.changeset/cloudflare-kv.md` | Release note |

## Files to update

| Path | Change |
|---|---|
| `README.md` | Matrix row, caveat, failure-mode blurb |
| `docs/00-vision.md` | Edge / KV row no longer deferred |
| `docs/01-architecture.md` | Category K; Category J wording |
| `docs/failure-modes.md` | Four KV failure modes |
| `packages/cloudflare-do/README.md` | Pointer to the advisory KV package |
| `AGENTS.md` | Category K row |
| `pnpm-lock.yaml` | New workspace package |

## Verification

```bash
pnpm validate:lockfile
pnpm check
pnpm -r build
pnpm -r typecheck
pnpm -r test
pnpm -r test:integration
```

No new integration script. CI integration stays on the existing Docker suites. `pnpm --filter @tslock/cloudflare-kv test` is the targeted package check.

## Risks

- Shared fuzz “exactly one winner” does not apply. Do not wire it; a green fuzz run on a linearizable fake would over-claim.
- `acknowledgeAdvisoryLock` is an extra constructor argument. It is intentional friction.
- Confirm-after-put can false-negative under a stale second read and must not delete.
- REST is optional convenience, not a consistency upgrade.
- Miniflare left out on purpose (heavy native binary; contract would flake on real KV).

## Rollback

Remove `packages/cloudflare-kv`, the changeset, and the doc rows. No core migration.
