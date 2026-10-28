# Review: @tslock/cloudflare-kv

**Spec:** `docs/specs/31-cloudflare-kv.md`  
**Plan:** `docs/plans/31-cloudflare-kv.md`  
**Issue:** #63

## Outcome

**pass**

## Summary

`@tslock/cloudflare-kv` is an advisory `ExtensibleLockProvider` over a structural Workers KV binding, with an optional REST adapter that does not add compare-and-swap. Ownership is the acquire-time token, the lease is `lockUntil`, and `expirationTtl` is `max(60, floor(remainingMs / 1000) + 1)`. A confirm read that misses the token returns `undefined` and does not delete. Held locks return `undefined`; malformed records and HTTP 429 throw.

The suite runs `extensibleLockProviderIntegrationTests` with `timeMode: 'mock'` only. It does not register `fuzzTests`. README, vision, architecture Category K, the failure-mode guide, and the Durable Objects pointer tell strong-consistency users to use `@tslock/cloudflare-do`.

Round 1 listed three minors. They were fixed and confirmed in round 2.

## Alignment

| Area | Status |
|---|---|
| Spec / plan | Pass — advisory acquire/unlock/extend, token ownership, TTL floor, required `acknowledgeAdvisoryLock`, no Miniflare |
| Architecture Category K | Pass — distinct from Category J; §7.1 states KV does not run the exactly-one fuzz contract |
| Vision / README | Pass — matrix row, caveat, failure modes 6–9 |
| Changeset / packaging | Pass — minor changeset; peer `@tslock/core` only; dual ESM+CJS via `scripts/tsup.cjs`; Node >= 22 |

## Findings

| Severity | Finding | Evidence | Resolution |
|---|---|---|---|
| minor | REST 404 and successful PUT/DELETE left the body unread. | `cloudflare-kv-namespace.ts` | `release()` cancels the body on those paths. Error paths still use `httpError()`, which reads `response.text()`. |
| minor | Architecture §7.1 still said every provider must pass the exactly-one fuzz contract. | `docs/01-architecture.md` | Paragraph added: Category K does not run `fuzzTests`. |
| nit | Category I still said in-memory was the only extensible specialized provider. | `AGENTS.md` | Parenthetical removed. |

Round 2 found no remaining issues.

## API / concurrency / errors

**Lock:** Read; skip when `lockUntil` is still ahead; otherwise put a new token and optionally confirm. Mismatch does not delete. A cached miss at two locations can return two locks. Tested.

**Unlock:** Token mismatch is a no-op on a fresh read, so a late unlock does not release a newer holder. A stale cache of the caller’s own token still `DELETE`s unconditionally. Tested as a documented failure.

**Extend:** Requires the same token and an unexpired `lockUntil`.

**TTL:** A 5 second lease is stored with `expirationTtl >= 60`. Advancing a `MutableClock` past `lockUntil` allows another acquire while the key remains.

**Rate limit:** A second write inside one second rejects `unlock()` and leaves the key in place.

## Test coverage assessment

| Layer | Assessment |
|---|---|
| Unit + shared extensible contract | 20 tests passed, including mock-time `extensibleLockProviderIntegrationTests` |
| Failure modes | Stale dual acquire, delayed delete, TTL floor, 429, stale unlock |
| `fuzzTests` | Intentionally not wired |
| Live Miniflare / Wrangler | Out of scope; real KV would not satisfy the shared exactly-one or sub-second unlock assumptions |

## Docs / changeset completeness

- Package README leads with the advisory warning, KV vs Durable Objects, and `acknowledgeAdvisoryLock: true`.
- Root README matrix and caveats, vision edge row, architecture Category K, failure-mode guide sections 6–9.
- `.changeset/cloudflare-kv.md` is a minor bump for `@tslock/cloudflare-kv`.

## Verification notes

- `pnpm --filter @tslock/cloudflare-kv test` — pass (20)
- `pnpm --filter @tslock/cloudflare-kv typecheck` — pass
- `pnpm --filter @tslock/cloudflare-kv build` — pass
- `pnpm exec biome check` on the package and edited docs — pass
- `@cloudflare/workers-types` assignability of `KVNamespace` to the structural binding was checked in round 1
