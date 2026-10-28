# Review: @tslock/elasticsearch + @tslock/opensearch

**Spec:** `docs/specs/15-elasticsearch-opensearch.md`
**Plan:** `docs/plans/15-elasticsearch-opensearch.md`

## Summary

The Elasticsearch and OpenSearch provider spec describes two DIRECT `LockProvider` packages sharing the same Painless script + `upsert` + `refresh: 'wait_for'` mechanism, differing only in the driver import. `ctx.op = 'none'` produces a `noop` result (lock held), the `upsert` body handles first-lock, and 409 conflicts map to `undefined`. The design mirrors ShedLock's `ElasticsearchLockProvider` and adds extend (which ShedLock's base omits). The locking logic is technically correct and the intentional code duplication (to preserve driver type safety) is well-justified. However, the plan contains a real bug in the OpenSearch integration test setup (HTTPS vs HTTP mismatch that will prevent the container from being reached), and the ES v8 `body` shape is flagged as "verify at implementation time" rather than committed to. Fix the OpenSearch test setup and the spec/plan is ready.

## Vision Alignment

Aligned. Two separate packages, each framework-agnostic, minimal-dependency (`@tslock/core` + driver peer only), async-native, type-safe. Uses core abstractions (`ClockProvider.now()`, `Utils.toIsoString()`, `Utils.getHostname()`). The "two packages, identical mechanism, swap driver" approach mirrors the Redis split (`redis` vs `redis-ioredis`) and the SQL split. No framework coupling. The deliberate avoidance of a shared support package (to preserve driver type safety) is a defensible reading of the "no `any` in public APIs" principle.

## Architecture Alignment

Correctly specified as DIRECT `LockProvider`s (Category B, per `01-architecture.md` §6.2). Painless-script-plus-upsert does not fit the `StorageBasedLockProvider` insert-then-update pattern, so bypassing `StorageAccessor` is correct. Both `ElasticsearchLockProvider` and `OpenSearchLockProvider` declare `implements ExtensibleLockProvider` because TSLock adds extend (ShedLock's base ES provider does not). This is a deliberate, documented divergence and enables `KeepAliveLockProvider` wrapping. Good.

Package dependency rule compliance: each package depends on `@tslock/core` + its driver (peer) only. No dependency on each other or on other providers. The intentional duplication (~80 lines per accessor) is called out and justified. `@tslock/core` does not gain a dependency on either driver.

## Spec Completeness

Complete. The spec covers: package metadata for both packages, public API (provider classes, options, field-names with `DEFAULT`/`SNAKE_CASE` constants), lock classes, accessors, the full locking mechanism (lock/extend/unlock with complete Painless script sources and driver call bodies), driver-difference table, error-handling table, file structure, dependencies, exports, and non-goals. The field-name parameterization (passing names as `params` rather than string-interpolating into the script source) is correctly motivated by ES script caching.

One omission: the spec does not specify the expected index mapping. The non-goals say "the user pre-creates the index with whatever mapping they prefer" and notes the `<=` comparison "works on both" string and `date` mappings "since ES coerces consistently within a single field mapping." This is slightly optimistic — mixing a `date` mapping with ISO-string `params.now` comparison in Painless should work (ES coerces), but the spec should be explicit that the script's `<=` is a string comparison when the field is `keyword`/`text` and a date comparison when the field is `date`, and that the two mappings are NOT interchangeable within a single field. Minor.

## Plan Completeness

Complete and well-ordered for the ES package (steps 1–9), then a copy-and-swap sequence for OpenSearch (steps 10–12). The unit tests cover all four `lock()` outcomes (`updated`, `created`, `noop`, 409-conflict), extend (`updated`/`noop`/`not_found`), unlock (`not_found` swallowed, 404 swallowed, other propagates), and both field-name casings. The integration test uses the `@testcontainers/elasticsearch` module with ES 8.11.0.

The risk table is thorough and addresses the real concern: ES v8 `body` shape drift, Painless noop semantics, 409 detection across driver shapes, `refresh: 'wait_for'` listener limit, OpenSearch security plugin, index mapping strictness, and the intentional duplication.

Two real gaps in the plan (see Gaps): the OpenSearch integration test HTTPS/HTTP bug, and the non-committal stance on the ES v8 `body` shape.

## Technical Correctness

**Painless lock script — CORRECT.**
```
if (ctx._source[params.lockUntilField] <= params.now) {
  ctx._source[params.lockUntilField] = params.lockUntil;
  ctx._source[params.lockedAtField] = params.lockedAt;
  ctx._source[params.lockedByField] = params.lockedBy;
} else {
  ctx.op = 'none';
}
```
- Doc exists, expired (`lockUntil <= now`) → fields updated → `result: 'updated'` → lock acquired. Correct.
- Doc exists, held (`lockUntil > now`) → `ctx.op = 'none'` → `result: 'noop'` → `undefined`. Correct.
- Doc absent → `upsert` body creates the doc → `result: 'created'` → lock acquired. Correct.

Painless `<=` on strings performs lexicographic comparison; ISO-8601 fixed-width strings sort chronologically. The `upsert` path bypasses the script entirely for non-existent docs, so `ctx._source` is never accessed on a missing doc. Correct and matches ShedLock.

**Concurrent upsert → 409 — CORRECT.** ES uses optimistic concurrency control (`_version`/`seq_no`/`primary_term`). Two concurrent `update`+`upsert` calls on the same non-existent `_id`: one indexes successfully, the other detects a version conflict and returns 409. `isConflictError` catches it → `undefined`. Correct.

**Painless extend script — CORRECT.** `if (ctx._source[params.lockedByField] == params.lockedBy && ctx._source[params.lockUntilField] > params.now)` — only the original holder, only while valid. Painless `==` on `String` performs value equality. No `upsert` for extend; a missing doc returns `result: 'not_found'` (or a 404) → `undefined`. Correct. Sound addition over ShedLock's base.

**Painless unlock script — CORRECT.** `ctx._source[params.lockUntilField] = params.unlockTime` — unconditional. `unlockTime(config) = max(now, lockAtLeastUntil(config))` honors `lockAtLeastFor`. Missing doc → `result: 'not_found'` or 404 → swallowed. Correct.

**`refresh: 'wait_for'` — CORRECT and necessary.** Forces the update to be visible to subsequent reads before returning. This is critical for `shouldSkipIfLocked` (a second lock attempt immediately after the first must see the new doc) and for `lockAtLeastFor > 0` unlock (a subsequent lock attempt must see the future `lockUntil` to correctly skip). The spec correctly identifies this. Matches ShedLock.

**`isConflictError` / `isNotFoundError` helpers — CORRECT but slightly redundant.** The plan's logic: `e?.meta?.statusCode === 409 || e?.statusCode === 409 || (e?.name === 'ResponseError' && e?.meta?.statusCode === 409)`. The third clause is subsumed by the first (both check `meta.statusCode === 409`). Not wrong — defensive against driver-shape variation — but the redundancy could be simplified to `e?.meta?.statusCode === 409 || e?.statusCode === 409`. The unit tests should cover each shape (v8 ES driver, OS driver).

## Gaps and Issues

1. **[BUG] OpenSearch integration test uses HTTPS where HTTP is required.** The plan's OpenSearch integration test (Step 11) sets `DISABLE_SECURITY_PLUGIN: 'true'` on the container and then connects with:
   ```typescript
   const client = new Client({
     node: `https://${container.getHost()}:${container.getMappedPort(9200)}`,
     ssl: { rejectUnauthorized: false },
   });
   ```
   `DISABLE_SECURITY_PLUGIN: 'true'` removes the OpenSearch security plugin entirely, which causes the node to serve **plain HTTP** on port 9200 (no TLS). Connecting via `https://` will fail to establish a TLS handshake. The correct setup is either:
   - Keep `DISABLE_SECURITY_PLUGIN: 'true'` and use `http://${host}:${port}` (no `ssl` config), OR
   - Drop `DISABLE_SECURITY_PLUGIN`, keep the security plugin (which serves HTTPS with a self-signed cert), and use `https://` + `ssl: { rejectUnauthorized: false }` + `auth: { username: 'admin', password: 'admin' }`.
   As written, the integration test will fail to connect. This must be fixed before implementation.

2. **[UNCERTAINTY] ES v8 `body` shape is non-committal.** The spec uses `client.update({ id, index, refresh, body: { script, upsert } })`. The `@elastic/elasticsearch` v8 client still accepts the `body` wrapper for `update` (it emits a deprecation warning in some v8 minors in favor of flat top-level params). The plan's risk table flags this ("verify with installed version; if not, switch to flat-params shape") but doesn't commit. Since the integration test pins ES 8.11.0, the spec should commit to whichever shape 8.11 supports and remove the ambiguity. The flat-params shape (`script`, `upsert` as top-level args alongside `id`, `index`, `refresh`) is the v8-idiomatic form and avoids deprecation warnings. Recommend committing to the flat shape.

3. **Index mapping not specified.** The spec's non-goals hand-wave the mapping ("the user pre-creates the index with whatever mapping they prefer"). The script's `<=` comparison behaves differently on `keyword`/`text` (string lexicographic) vs `date` (numeric epoch) mappings. The spec should state: (a) the default/dynamic mapping stores the ISO strings as `text`/`keyword` (string comparison — correct); (b) if the user maps the fields as `date`, ES coerces the ISO string to epoch-millis for comparison (also correct); (c) the two mappings are NOT interchangeable within a single field — the user must pick one and use it consistently. Add a README note.

4. **Redundant `isConflictError` clause.** See Technical Correctness. Minor simplification.

5. **Maintenance burden of duplication is acknowledged but lightly mitigated.** The two accessors are ~80 lines each and "kept in sync via a code-review checklist." There's no automated drift-detection (e.g., a shared test that asserts both accessors produce identical request bodies). Consider extracting the script sources and the `is*Error` helpers into a shared `@tslock/search-support` package that depends only on `@tslock/core` (zero driver deps) and exposes the pure-string constants + pure-function helpers. The accessors stay duplicated (driver-typed), but the script sources and error helpers would have a single source of truth. This is a recommendation, not a requirement — the current approach is defensible.

6. **`refresh: 'wait_for'` listener limit not in the README guidance.** The plan's risk table notes the `index.max_refresh_listeners` default of 1000 and that the fuzz test (50 concurrent) is fine, but this should be carried into the README so users running high-concurrency lock workloads understand the throttle. Minor.

7. **No fuzz-test reference.** Same as Mongo/DynamoDB — the plan calls `lockProviderIntegrationTests` and `extensibleLockProviderIntegrationTests` but doesn't explicitly name the fuzz contract. Confirm it's bundled or add it.

## Recommendations

1. **Fix the OpenSearch integration test HTTP/HTTPS setup** (Gap 1) — this is a blocking test bug.
2. Commit to the flat-params request shape for ES v8 (Gap 2) and remove the "verify at implementation time" hedge.
3. Document the index mapping expectations (Gap 3) in the spec and README.
4. Simplify the `isConflictError` helper (Gap 4).
5. Consider a zero-driver-dep `@tslock/search-support` package for the script sources and error helpers to give the duplicated accessors a single source of truth (Gap 5) — optional.
6. Carry the `refresh: 'wait_for'` listener-limit note into the README (Gap 6).

## Verdict: APPROVED WITH NOTES

The Painless scripts, `upsert`+`refresh: 'wait_for'` mechanism, 409/noop handling, and `not_found` swallowing are all technically correct and match ShedLock. The OpenSearch integration-test HTTPS bug (Gap 1) must be fixed before implementation but is isolated to test setup, not the locking logic. The ES v8 `body`-shape uncertainty (Gap 2) should be resolved by committing to the flat-params form. With those two items addressed, the spec+plan are ready to implement.
