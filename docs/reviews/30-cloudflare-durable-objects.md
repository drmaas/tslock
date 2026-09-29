# Review: @tslock/cloudflare-do

**Spec:** `docs/specs/30-cloudflare-durable-objects.md`  
**Plan:** `docs/plans/30-cloudflare-durable-objects.md`  
**Issue:** #47

## Outcome

**needs revision**

## Summary

`@tslock/cloudflare-do` correctly introduces Category J: a fetch-based `ExtensibleLockProvider` client plus a duck-typed `TslockLockDurableObject` / `handleTslockLockRequest` protocol over strongly consistent DO storage, with Workers KV explicitly deferred. The packaging (peer `@tslock/core` only, no hard `cloudflare:workers` import), README Worker sketch, vision/architecture Category J rows, Bun pointer, and minor changeset match the accepted SDD and issue #47 scope.

The slice fails its own unit/contract run. Shared contracts are wired incorrectly (`lockProviderIntegrationTests` without `isExtensible: true` alongside `extensibleLockProviderIntegrationTests`), so `shouldNotExtendIfNotExtensible` fails when extend succeeds. More importantly, unlock ignores `lockedBy` even though the protocol carries it and extend enforces ownership: after expiry + re-acquire, a late unlock unconditionally rewrites `lockUntil` and can release the new holder. That is a real ownership bug under DO serialization (no ETag race will save you). Fix unlock ownership and the contract wiring before pass.

## Alignment

| Area | Status |
|---|---|
| Spec / plan | Mostly pass — protocol ops, `DoLockStorage`, client `fetch` adapter, per-name `idFromName` guidance, KV deferred, clock-sync note match. Unlock ownership omission in the spec is the weak point the implementation faithfully copies. |
| Architecture Category J | Pass — new specialized category; DO storage + injectable fetch; KV deferred |
| Vision / README / Bun | Pass — matrix, Workers KV deferred note, CONTRIBUTING Bun notes, package README Bun/Node section |
| Comparison to S3 / NATS | DO serialization + revision-free put is closer to a single-threaded map than S3 ETag or NATS revision CAS. That makes an unlock ownership check cheaper and more necessary than on S3. |
| Changeset / conventions | Pass — `.changeset/cloudflare-do.md` minor; dual ESM+CJS; `engines.node >= 22` |

## Findings

| Severity | Finding | Evidence | Concrete fix |
|---|---|---|---|
| **blocker** | Unlock does not enforce ownership. `applyLockOp` for `unlock` loads the record and always puts `lockUntil = max(now, createdAt + lockAtLeastFor)` while preserving the *existing* `lockedBy`. Sequence: A holds → expires → B acquires (`lockedBy: b`) → A’s late unlock overwrites `lockUntil` (often to `now`) → C can acquire while B still believes it holds the lock. Extend correctly rejects `not_owner`; unlock ignores `body.lockedBy`. Under DO request serialization this clobber always succeeds. | `packages/cloudflare-do/src/handle-lock-request.ts` unlock branch; protocol includes `lockedBy` on unlock | Before mutating on unlock: if `existing.lockedBy !== body.lockedBy`, return `{ ok: true }` as a no-op (do not write). Optionally also no-op when the lock is already expired and owned by someone else (same check). Add a unit test for late unlock after foreign re-acquire. Update behavior in a follow-up SDD note if the immutable spec must stay; implementation should still fix the hazard. |
| **blocker** | Contract test wiring is wrong and the suite fails. The file calls `lockProviderIntegrationTests(getProvider, { timeMode: 'mock' })` **and** `extensibleLockProviderIntegrationTests(...)`. Extensible helpers already run the base suite with `isExtensible: true`. The bare call expects extend to throw/`undefined`, but `CloudflareDoLock.doExtend` succeeds → `shouldNotExtendIfNotExtensible` fails (`expected AssertionError … to be an instance of LockException`). | `packages/cloudflare-do/__tests__/cloudflare-do-lock-provider.test.ts`; `packages/test-support/src/integration-tests.ts`; in-memory/mongo/redis call **only** `extensibleLockProviderIntegrationTests` | Remove the standalone `lockProviderIntegrationTests` import/call. Keep `extensibleLockProviderIntegrationTests` + `fuzzTests` with `timeMode: 'mock'`. |
| **major** | No test covers unlock-after-reacquire / foreign unlock no-op. Handler tests cover acquire/skip/expiry, extend not_owner, and `lockAtLeastFor`, but not the clobber scenario above. | `__tests__/handle-lock-request.test.ts` | After adding the ownership no-op, assert: A lock → expire → B lock → A unlock → B still held for a third acquire attempt. |
| **major** | Client `unlock` ignores protocol `ok: false` shapes and only throws on non-2xx. Fine today because unlock always returns `ok: true`, but after an ownership-aware unlock the client should still treat no-op success as void (HTTP 200 + `ok: true`). Do not map unlock failures to thrown errors unless HTTP/storage fails. | `CloudflareDoLockProvider.unlock` | Keep void on `ok: true` no-op; throw only on `!response.ok` / transport errors (current behavior). Document that unlock is best-effort w.r.t. ownership denial. |
| **minor** | Expiry writes use client `createdAt + lockAtMostFor` while “is held?” uses DO `Date.now()`. Large client/DO skew can shorten or lengthen effective hold. Spec documents NTP; README clock note is thin. | Spec assumptions; `applyLockOp` lock/extend; package README | README: one sentence that DO compares stored `lockUntil` to DO time while new deadlines are computed from client `createdAt` + durations—keep clocks synced. Optional hardening (follow-up): compute `lockUntil = now + lockAtMostFor` inside the DO. |
| **minor** | Protocol validation accepts non-finite numbers (`NaN` / `Infinity`) for durations/`createdAt`. | `handleTslockLockRequest` field typeof checks | Reject non-finite numbers with HTTP 400. |
| **minor** | Storage exceptions from `get`/`put` are not turned into HTTP 500 responses inside `handleTslockLockRequest`; they rely on the Workers runtime uncaught-exception path. Spec allows 500. | `handleTslockLockRequest` | Optional try/catch → `Response.json(..., { status: 500 })` for clearer client `LockException` mapping. |
| **nit** | Plan lists `vitest.config.ts`; package uses root Vitest config only. | Plan file list vs package tree | Optional; not required for correctness. |
| **nit** | `TslockLockDurableObject` is duck-typed and does not extend the platform `DurableObject` base. Acceptable for Node CI; README should keep saying callers may wrap/subclass for newer Wrangler typings. | `tslock-lock-durable-object.ts`; README | Already mostly documented; no code change required for v1. |

## API / concurrency / errors

**Lock:** Serialized DO read → if `lockUntil > now` then `held`; else put new record. Client maps `held` → `undefined`, `acquired` → `CloudflareDoLock`. Correct.

**Extend:** Requires matching `lockedBy` and active lock; returns `not_owner` / `expired` / `missing`. Client maps failure → `undefined`. Correct and tested.

**Unlock:** Missing → ok. Present → unconditional overwrite. **Incorrect for multi-holder safety** (blocker). Spec text omitted ownership; safe edge behavior still requires the no-op.

**HTTP:** 405 non-POST; 400 malformed; 200 for protocol outcomes. Client throws `LockException` on non-OK HTTP. Good.

**Sharding:** `storageKeyForLock` → `lock:${name}` supports shared-DO multi-lock tests; production `idFromName` still passes `name` — matches spec decision.

**KV:** Deferred in README/vision — matches non-goals.

## Test coverage assessment

| Layer | Assessment |
|---|---|
| Protocol unit | Solid for happy acquire/skip/expiry, extend owner/non-owner, lockAtLeastFor, HTTP 400 — **5/5 passing** in isolation |
| Client + shared contracts | Intended strength (in-process serialized fake DO + `lockProvider`/`extensible`/`fuzz`) but **currently red** due to duplicate non-extensible suite |
| Ownership / late unlock | Missing |
| Live Wrangler/miniflare | Correctly deferred per plan; env hook not required for v1 |

## Docs / changeset completeness

- Package README: KV deferred, `idFromName`, Worker + Node client examples, Bun pointer — good.
- Root README Category specialized row + vision Category J + architecture §6.10 — present.
- `.changeset/cloudflare-do.md` — minor, accurate.
- Gap: document unlock ownership once fixed; strengthen clock-sync sentence.

## Verification notes

Ran locally after building `@tslock/core` and `@tslock/test-support`:

- `pnpm --filter @tslock/cloudflare-do typecheck` — pass
- `pnpm --filter @tslock/cloudflare-do build` — pass
- `pnpm --filter @tslock/cloudflare-do test` — **fail** (1/20): `lockProviderIntegrationTests > shouldNotExtendIfNotExtensible`
- Handler file alone: 5 passed
- No live Cloudflare/miniflare integration (out of v1 scope)

## Required fixes before pass

1. **Unlock ownership no-op** when `existing.lockedBy !== body.lockedBy`; add regression test for late unlock after foreign re-acquire.
2. **Remove** standalone `lockProviderIntegrationTests(...)`; keep only `extensibleLockProviderIntegrationTests` + `fuzzTests`.
3. Re-run `pnpm --filter @tslock/cloudflare-do test` green.
4. README note for unlock ownership + clock sync.

No production or spec/plan edits were made in this review.
