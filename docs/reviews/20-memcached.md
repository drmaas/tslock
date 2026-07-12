# Review: @tslock/memcached

**Spec:** `docs/specs/20-memcached.md`
**Plan:** `docs/plans/20-memcached.md`

## Summary

The Memcached provider implements a DIRECT `LockProvider` using the atomic `add` command (fails if key exists) for acquisition, and `delete` or `replace` (with shorter TTL) for release. This is a faithful port of ShedLock's `MemcachedLockProvider`. The spec prominently documents the fundamental eviction caveat (memcached is an LRU cache, not a durable store). The algorithm is correct. The primary note is a TTL-calculation discrepancy with ShedLock (missing the +1 second safety buffer) and the `memjs` type-shim risk.

## Vision Alignment

**Aligned.** Vision §6.5 specifies Memcached with "add (fails if exists) + replace" mechanism, `memjs` driver, package `@tslock/memcached`. The spec matches exactly. Vision §6.6 and Architecture §6.7 both document the eviction caveat — the spec elevates this to a prominent warning in the overview. Vision §4 "Minimal dependencies" is honored: peer-dep on `memjs` + `@tslock/core` only.

## Architecture Alignment

**Correct as DIRECT LockProvider.** Architecture §6.7 states: "`add` (fails if key exists). Lock = `add(key, expireSeconds, value)`. Unlock = `delete` (or `replace` with shorter TTL for `lockAtLeastFor`). No extend. **Caveat:** memcached can evict locks early under memory pressure." The spec implements `LockProvider` directly — correct. The `add`/`replace`/`delete` command set does not fit the `StorageAccessor` insert/update/unlock/extend contract (there is no insert-vs-update split; `add` is the only acquisition primitive).

## Spec Completeness

**Complete.** Covers: package metadata, public API (`MemcachedLockProvider` + `createMemcachedLockProvider` factory, options, `MemcachedLock`), key/value format, full `lock()`/`doUnlock()` pseudocode, a dedicated "Memcached Eviction Caveat" section with mitigations, error-handling table (9 scenarios), file structure (including a `memjs-types.d.ts` shim since `memjs` ships no types), dependencies, exports, and non-goals. The factory (`createMemcachedLockProvider`) is a nice usability addition for the common case, with the constructor path available for full control.

## Plan Completeness

**Complete.** 9 steps including the `memjs` type-shim step (Step 2), options, lock, provider + factory, index, unit tests (mocked `memjs.Client` with concrete mock code), integration tests (testcontainer `memcached:1.6`), and a 9-row risk table. The plan correctly notes the `Math.ceil` vs ShedLock's `floor + 1` discrepancy (see Technical Correctness).

## Technical Correctness

**Is add/replace/delete correct?** Yes.
- `add(key, value, { expires })` — atomic, succeeds only if key does NOT exist. On success, sets the value with the given TTL. On failure (`success: false`), the key exists → lock held → return `undefined`. Correct.
- `delete(key)` — for unlock when `keepLockFor <= 0` (minimum hold time elapsed). Correct.
- `replace(key, value, { expires })` — for unlock when `keepLockFor > 0`. `replace` only succeeds if the key exists, confirming the lock is still ours. Overwrites with a shorter TTL = remaining minimum hold time. Correct.
- `keepLockFor = lockAtLeastUntil(config) - now` = remaining time the lock must stay held. Correct derivation, equivalent to ShedLock's `lockAtLeastFor - (now - createdAt)`.

**Is the eviction caveat documented?** Yes, prominently. The spec overview has a warning blockquote, and a dedicated section (§"Memcached Eviction Caveat") explains: (1) locks can be released early via LRU eviction, (2) `lockAtLeastFor` is also affected, (3) no durable guarantee. Mitigations are user-side (size the cluster, use a dedicated instance, prefer a durable backend). This is honest and thorough.

**Issue 1 — TTL calculation: `Math.ceil` vs ShedLock's `floor + 1`.** The spec uses `Math.ceil(config.lockAtMostFor / 1000)` for TTL in seconds. ShedLock uses `lockAtMostFor / 1000 + 1` (integer division + 1). The difference:
- `Math.ceil(30000 / 1000) = 30` seconds
- `30000 / 1000 + 1 = 31` seconds (ShedLock)

ShedLock's +1 is a **safety buffer against clock drift**. Without it, if `lockAtMostFor = 30000ms` (exactly 30 seconds) and the memcached server's clock is slightly behind the client's, the key could expire before `lockAtMostFor` elapses on the client, creating a brief window where another acquirer gets the lock while the first holder still believes it holds it. The +1 buffer ensures the server TTL is strictly greater than the client's `lockAtMostFor`.

The plan's risk table acknowledges this: "Consider `Math.floor(ttl/1000) + 1` to match ShedLock's 1s safety buffer against clock drift. Document the choice in the spec; either is acceptable." **"Either is acceptable" is too lenient** — the +1 buffer is a correctness improvement that protects the `lockAtMostFor` upper-bound guarantee under clock drift. Since vision §2 states "Assumes synchronized clocks," the risk is mitigated, but the +1 buffer is cheap insurance and matches ShedLock exactly. **Recommend adopting `Math.floor(ttl / 1000) + 1` for both `lockAtMostFor` and `lockAtLeastFor` TTL calculations.**

**Issue 2 — `memjs` type shim.** `memjs` ships no TypeScript types and there is no `@types/memjs`. The plan creates a minimal `src/memjs-types.d.ts` ambient module declaration covering `add`, `replace`, `delete` returning `Promise<{ success: boolean }>`. This is pragmatic but risky:
- If the real `memjs` return shape differs (e.g., `{ success: boolean, value?: Buffer }` or a different structure), the shim masks the type mismatch — TypeScript will not catch it because the ambient declaration overrides the real types.
- If `memjs` v1.5.x does not natively return promises (requires callbacks), the `await client.add(...)` pattern breaks silently (awaiting a non-thenable returns the value immediately, not a Promise).

The plan says "Keep the surface minimal so it does not drift from the real `memjs` API" — but a minimal shim that is **wrong** is worse than no shim. **The integration test is the safety net here** — it will catch shape mismatches against the real `memjs`. The unit tests (using the shim) verify the provider's logic but not the `memjs` API contract. This is acceptable as long as the integration test runs.

**Issue 3 — `memjs` promise support.** The spec uses `await this.client.add(...)` throughout. The `memjs` package v1.5.x supports promises if no callback is provided (confirmed in the `memjs` README). The plan pins `^1.5.0`. This is correct, but the type shim should declare promise returns (which it does). OK.

**Issue 4 — `expires` option name.** The spec uses `{ expires: expireTimeSeconds }`. The `memjs` `add`/`replace` options use `expires` (in seconds). This appears correct based on the `memjs` API, but the plan's risk table flags "memjs `expires` unit (seconds vs millis)" — confirmed seconds. The unit test asserts `{ expires: 60 }` not `{ expires: 60000 }`. Good.

**No extend — correct.** The spec correctly explains: "Memcached has no atomic check-and-extend primitive that verifies ownership, so we cannot safely extend a lock we may no longer hold." `KeepAliveLockProvider` must NOT wrap this provider. Documented in Non-Goals.

## Gaps and Issues

1. **TTL safety buffer** — `Math.ceil` should be `Math.floor(ttl / 1000) + 1` to match ShedLock's 1-second buffer against clock drift. Cheap correctness improvement.
2. **`memjs` type shim risk** — minimal ambient declaration may not match real `memjs` API. Integration tests are the safety net. If the real `memjs` return shape differs from `{ success: boolean }`, the shim hides it.
3. **`delete`/`replace` failure throws `LockException`** — the spec throws on `!result.success` (key evicted/expired before unlock). This matches ShedLock. `DefaultLockingTaskExecutor` catches unlock errors in `finally`. Correct, but worth noting that a `LockException` from unlock is informational (the lock is already gone).
4. **No `lockAtLeastFor` validation against `lockAtMostFor`** — core handles this. Minor.
5. **`clientOptions` type** — the plan uses `Record<string, unknown>` for `clientOptions` (Step 3) while the spec references `MemjsClientOptions`. Since `memjs` has no types, `Record<string, unknown>` is the pragmatic choice. Acceptable.

## Recommendations

1. **Adopt `Math.floor(ttl / 1000) + 1`** for TTL calculations (both `lockAtMostFor` and `lockAtLeastFor` paths) to match ShedLock's safety buffer against clock drift.
2. **Verify `memjs` v1.5.x return shape** via the integration test. If the shape differs from the shim, update the shim or drop it in favor of a more accurate declaration.
3. **Document in the README** that `LockException` from `unlock()` (evicted key) is expected behavior, not a bug — the lock is already gone.
4. **Consider a dedicated memcached instance** recommendation in the README (already in the spec's eviction section, but worth repeating in setup docs).

## Verdict: APPROVED WITH NOTES

The algorithm is correct and faithfully matches ShedLock's Memcached provider. The `add`/`replace`/`delete` command usage is right, and the eviction caveat is prominently and honestly documented. The TTL safety buffer (`Math.ceil` → `Math.floor + 1`) is a recommended correctness improvement that aligns with ShedLock. The `memjs` type-shim risk is mitigated by integration tests. No structural or architectural issues.
