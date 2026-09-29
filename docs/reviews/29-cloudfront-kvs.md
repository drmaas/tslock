# Review: @tslock/cloudfront-kvs

**Spec:** `docs/specs/29-cloudfront-kvs.md`  
**Plan:** `docs/plans/29-cloudfront-kvs.md`  
**Issue:** #47

## Outcome

**needs revision**

## Summary

`@tslock/cloudfront-kvs` is the right architectural shape for issue #47: a Category B direct `ExtensibleLockProvider` over CloudFront KeyValueStore control-plane APIs, not Redis. Spec, plan, package docs, matrix rows, Valkey clarification, and the minor changeset are largely in place. The Describe → GetKey → PutKey `IfMatch` retry loop is a sound CAS model for store-wide ETags.

The slice is not ready to pass. Unit tests currently fail on the held/expired paths because fixtures build invalid ISO timestamps. Opt-in integration wiring also incorrectly invokes the non-extensible contract suite for an extensible provider. Unlock follows the weak S3/DynamoDB “overwrite `lockUntil`” pattern with no ownership/takeover guard, so a late unlock can clobber a new holder—acceptable only if documented and preferably tightened. Spec-required corrupt-value coverage is missing.

## Alignment

| Area | Status |
|---|---|
| Spec / plan | Pass — package surface, JSON value shape, overwrite-only unlock, ETag retry exhaustion → not-acquired, peers, and opt-in AWS integration match |
| Architecture Category B | Pass — direct provider; store-wide ETag does not fit clean `StorageAccessor` insert/update; listed under Category B beside Mongo/DynamoDB/ES/Arango |
| Vision / README / Valkey docs | Pass — matrix rows, Ignite deferred, CloudFront ≠ Redis, redis README Valkey/ElastiCache/MemoryDB + CloudFront pointer |
| S3 / NATS comparison | Partial — value overwrite unlock mirrors S3; no per-object revision like NATS KV, so contention is store-wide (documented). Ownership on unlock is weaker than Redis `safeUpdate` |
| Changeset / package conventions | Pass — `.changeset/cloudfront-kvs.md` minor; dual ESM+CJS tsup; `engines.node >= 22`; peers `@tslock/core` + `@aws-sdk/client-cloudfront-keyvaluestore` |

## Findings

| Severity | Finding | Evidence | Concrete fix |
|---|---|---|---|
| **blocker** | Unit suite fails: “returns undefined when lock is held” and “re-acquires when expired”. Fixtures do `new Date(ms).toISOString().replace(/Z$/, '.000Z')`, which turns already-millisecond ISO strings into `….000.000Z`. `Date.parse` returns `NaN` and `decodeLockRecord` throws `LockException` instead of exercising skip/re-acquire. | `packages/cloudfront-kvs/__tests__/cloudfront-kvs-lock-provider.test.ts` (held/expired cases); `src/lock-record.ts` | Build fixtures with `Utils.toIsoString(ms)` (or plain `toISOString()` without the `.replace`). Re-run `pnpm --filter @tslock/cloudfront-kvs test` until green. |
| **major** | Unlock never checks `lockedBy` (or takeover via a newer `lockUntil`). After A expires and B acquires, A’s delayed unlock Heads/Gets B’s record and overwrites `lockUntil` with `unlockTime(A)`, which can release or shorten B’s hold. Spec cites S3/DynamoDB parity—those providers share the weakness—but this is still a real cross-holder clobber, and store-wide ETag retries do not prevent it. | `CloudFrontKvsLockProvider.unlock`; compare Redis Lua ownership / NATS `lockUntil > lockAtMostUntil` guard | Prefer: no-op unlock when `existing.lockedBy !== Utils.getHostname()`, and/or when stored `lockUntil` indicates another holder took over. At minimum document the late-unlock clobber in the README as a known time-based-lock limitation. |
| **major** | Opt-in integration calls both `lockProviderIntegrationTests(getProvider)` and `extensibleLockProviderIntegrationTests(getProvider)`. The latter already embeds the base suite with `isExtensible: true`. The bare call runs `shouldNotExtendIfNotExtensible`, which fails for this extensible lock (same failure mode observed on `@tslock/cloudflare-do`). | `packages/cloudfront-kvs/__tests__/integration/cloudfront-kvs.integration.test.ts`; in-memory/mongo/redis only call `extensibleLockProviderIntegrationTests` | Drop the standalone `lockProviderIntegrationTests(...)` call; keep `extensibleLockProviderIntegrationTests` + `fuzzTests`. |
| **major** | Spec unit matrix asks for corrupt-value coverage; no test asserts invalid JSON / missing fields throw `LockException`. | Spec “Tests”; `__tests__/cloudfront-kvs-lock-provider.test.ts` | Add unit cases: invalid JSON, non-object, missing fields → `LockException` on acquire (and optionally unlock). |
| **minor** | Spec says reject `keyPrefix` with control characters; resolver only rejects embedded NUL (`\0`), not other Cc controls. | `resolveCloudFrontKvsConfiguration`; spec validation bullets | Reject the same control-character class core uses for lock names, or narrow the spec language to NUL + length (new follow-up doc if changing the immutable spec text is undesired). |
| **minor** | Spec lists unlock conflict-exhaustion → no-op and missing-key unlock no-op; unit coverage is a single unlock happy path without asserting Put payload / retry exhaustion / missing key. | `__tests__/cloudfront-kvs-lock-provider.test.ts` unlock case | Add tests: GetKey 404 → no Put; ConflictException × `maxEtagRetries` → returns without throw; Put Value preserves `lockedBy` / uses `unlockTime`. |
| **nit** | Plan lists `vitest.config.ts`; package relies on the repo root Vitest config only (`vitest.integration.config.ts` exists). | `docs/plans/29-cloudfront-kvs.md`; package tree | Harmless if intentional; add a local config only if package-specific setup is needed. |
| **nit** | Spec/plan/review number `29` collides with other in-tree `29-*` SDD artifacts (scheduler adapters, lock-health snapshot). Descriptive filenames disambiguate; shared `NN` uniqueness is violated. | `docs/specs/29-*.md`, `docs/plans/29-*.md`, `docs/reviews/29-*.md` | Process note for future SDD numbering; do not rewrite immutable prior `29-*` docs. |

## API / concurrency / errors

**Acquire CAS:** Describe ETag → GetKey → decision → PutKey `IfMatch` is correct for store-wide optimistic concurrency. Concurrent Put on any key invalidates the ETag; `ConflictException` / 409 retries then re-read. Exhaustion returns `undefined` (acquire) — matches spec.

**Held path:** Returns `undefined` without writing when `lockUntil > now` — correct. Currently unproven in CI because of the fixture ISO bug (blocker above).

**Expired re-acquire:** Overwrites with new ownership when `lockUntil <= now` — correct algorithm; same fixture bug.

**Describe vs GetKey not-found:** `describeEtag` does not swallow `ResourceNotFoundException` (store missing → throw). `getRecord` maps GetKey not-found → absent. Matches the error taxonomy.

**Corrupt values:** Throw `LockException` — correct; untested.

**Extend:** Requires `lockedBy === hostname` and active `lockUntil`; conflict exhaustion → `undefined`. Ownership rejection is unit-tested.

**Unlock:** Overwrite-only (no DeleteKey) matches the accepted decision for Functions readers. Best-effort conflict exhaustion is correct. Ownership gap is the main semantic risk (major above).

## Test coverage assessment

| Layer | Assessment |
|---|---|
| Unit | Incomplete / currently red — acquire absent, conflict retry success/fail, non-conflict propagate, extend foreign owner, config defaults work; held/expired paths broken by fixtures; corrupt / unlock edge cases thin |
| Integration | Harness present and correctly gated (`TSLOCK_CLOUDFRONT_KVS_INTEGRATION` + `CLOUDFRONT_KVS_ARN`); contract wiring must drop duplicate non-extensible suite before live AWS runs are meaningful |
| Shared contracts | Intended (`lockProvider` + extensible + fuzz) once wiring fixed |
| Emulator | Correctly documented as unavailable / best-effort LocalStack |

## Docs / changeset completeness

- Package README: install, SigV4A note, limits table, Functions read-only vs control-plane write, Valkey pointer — good.
- Root README + `docs/00-vision.md` + Category B architecture note + CONTRIBUTING Bun notes + redis Valkey sections — present for #47.
- `.changeset/cloudfront-kvs.md` — minor, accurate.
- Gap: README should state late-unlock / non-owner overwrite behavior if ownership check is not added.

## Verification notes

Ran locally after building `@tslock/core`:

- `pnpm --filter @tslock/cloudfront-kvs typecheck` — pass
- `pnpm --filter @tslock/cloudfront-kvs build` — pass
- `pnpm --filter @tslock/cloudfront-kvs test` — **fail** (2/10): held + expired fixtures → `Corrupted lock record: unparseable timestamps`
- Integration not run (no AWS credentials / ARN in this environment)

## Required fixes before pass

1. Fix ISO fixtures (or use `Utils.toIsoString`) so held/expired unit tests pass.
2. Remove duplicate `lockProviderIntegrationTests` from the integration harness; keep extensible + fuzz only.
3. Add corrupt-value unit coverage; strengthen unlock tests.
4. Either add unlock ownership/takeover no-op **or** document the late-unlock clobber explicitly in the README (prefer code no-op).

No production or spec/plan edits were made in this review.
