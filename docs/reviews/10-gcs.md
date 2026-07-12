# Review: @tslock/gcs

**Spec:** `docs/specs/10-gcs.md`
**Plan:** `docs/plans/10-gcs.md`

## Summary

The GCS provider implements `StorageAccessor` over `@google-cloud/storage` and wraps it with `StorageBasedLockProvider`. Locking uses GCS preconditions: `save({ precondition: { doesNotExist: true } })` for create-if-not-exists and `save({ precondition: { generationMatch } })` / `setMetadata({ precondition: { generationMatch } })` for compare-and-swap. The spec and plan are thorough and well-structured. The decision to ship unit tests only (no integration tests, due to the lack of a first-class GCS emulator) is well-justified and matches the vision. Two issues need attention: (1) `updateRecord` returns `false` on `file.get()` 404 instead of propagating — same registry-cache-stuck issue as the S3 spec; (2) `setMetadata` generation-increment behavior should be verified during manual testing. The GCS metadata casing (unlike S3) is case-sensitive and not an issue. Implementation-ready with the `updateRecord` fix.

## Vision Alignment

**Aligned.** Vision §6.2 specifies GCS with "create with doesNotExist / generationMatch" mechanism, `@google-cloud/storage` driver, package `@tslock/gcs`, using `StorageBasedLockProvider`. The spec uses exactly this — `file.save({ precondition: { doesNotExist: true } })` for insert, `file.save({ precondition: { generationMatch } })` for update, `file.setMetadata({ precondition: { generationMatch } })` for unlock/extend. Vision §4 "Provider-pluggable, minimal dependencies" — peer deps on `@google-cloud/storage` + `@tslock/core` only. Vision §8 "Skip Spanner/GCS (no emulator) — unit tests only" — the spec explicitly ships unit tests only with a manual verification procedure. Framework-agnostic.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists GCS among the 11 storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider` — correct. The `GcsLockProvider` class `implements ExtensibleLockProvider` by delegating to `StorageBasedLockProvider` — correct. Types are consistent with core abstractions. Peer dep `@google-cloud/storage ^7.x` matches vision.

The unit-tests-only approach is consistent with architecture §7.4: "For cloud-only backends (S3, GCS, Spanner, Firestore, Datastore), use LocalStack (S3) / emulator where available, or skip integration tests and rely on unit tests + manual verification. Document this clearly." The spec clearly documents this decision.

## Spec Completeness

**Complete.** Public API types defined: `GcsLockProvider`, `GcsProviderConfig`, `createGcsProviderConfig` factory. Locking mechanism (insert/update/unlock/extend) is fully specified with SDK calls, metadata structure, precondition flags, and step-by-step result handling for each. Error handling is a 11-row table covering 404 in each operation, 412 for preconditions, corrupt metadata, missing bucket, auth errors. The error detection strategy (duck-typed on `code` / `status`, not `instanceof`) is well-documented with rationale (SDK error class identity shifts across versions). Configuration options with defaults are documented. File structure is clear. The test approach section is excellent — it evaluates three options (fake-gcs-server, real GCP bucket, vi.mock) and justifies the unit-tests-only decision. Non-goals are clearly stated.

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification. Steps ordered logically: config → errors → accessor (with helper methods: `getWithMetadata`, `buildMetadata`, `parseLockUntil`) → provider → index → unit tests → manual verification doc. Unit tests use hand-rolled mock `Bucket`/`File` objects (not `vi.mock('@google-cloud/storage')` — the plan correctly notes the SDK's internal coupling makes full module mocking brittle). The unit test list is comprehensive (insert/update/unlock/extend happy paths, error paths, 404/412, wrong owner, expired, corrupt metadata, precondition verification). The manual verification procedure (Step 8) is a 5-step checklist covering first lock, concurrent lock, unlock, re-lock, extend, non-holder extend, metadata inspection, generation increment. The risk table is thorough (9 rows). Estimation (~6 files, ~400-500 lines, one session) is reasonable — faster than S3 because no integration test setup.

## Technical Correctness

**GCS preconditions — correct approach:**
- `file.save('', { precondition: { doesNotExist: true } })` — correct GCS create-if-not-exists. GCS rejects the write if the object exists at any generation. ✅
- `file.save('', { precondition: { generationMatch: <gen> } })` — correct GCS compare-and-swap. The generation number changes on every write, so `generationMatch` ensures the object hasn't been modified since `file.get()`. ✅
- `file.setMetadata(metadata, { precondition: { generationMatch: <gen> } })` — correct GCS metadata-only PATCH with precondition. Smaller operation than `save` (no body upload). Increments generation. ✅
- `file.get()` returns `[File, Metadata]` where `Metadata` has `generation` and `metadata` (custom metadata map). ✅

**`generation` coercion:** The spec and plan correctly note that `generation` may be returned as a string or number depending on SDK version, and coerce via `Number(...)`. Generation numbers fit within `Number.MAX_SAFE_INTEGER`. ✅

**Error detection (duck-typed):** The spec uses `(e as any)?.code === 404` / `412` (also accepting `status`). The plan's `gcs-errors.ts` implements this. The rationale (don't use `instanceof ApiError` — error class identity shifts across SDK versions) is sound. The `@google-cloud/storage` SDK throws `ApiError`, `StorageError`, or wrapped `GaxiosError` depending on the code path — duck-typing on `code`/`status` is the robust approach. ✅

**`insertRecord` logic:**
1. `file.exists()` → if `true`, return `false`.
2. `file.save('', { metadata, precondition: { doesNotExist: true } })` → if 412, return `false`. Success → `true`.
Correct. The `doesNotExist` precondition handles the TOCTOU race. The `file.exists()` is an optimization. ✅

**`updateRecord` logic:**
1. `file.get()` → if 404, **return `false`**.
2. Parse `lockUntil` → if > now, return `false` (still locked).
3. `file.save('', { metadata, precondition: { generationMatch } })` → if 412, return `false`. Success → `true`.
The conditional put and expiry check are correct. **But the 404 handling is incorrect** — see Issue 1 below.

**`unlock` logic:**
1. `file.get()` → if 404, no-op return.
2. `file.setMetadata({ lockUntil: unlockTime, ...preserved }, { precondition: { generationMatch } })` → if 412, swallow (best-effort). Success → void.
Correct. Best-effort unlock with `lockAtLeastFor` honored via `unlockTime(config)`. Uses `setMetadata` (not `save`) — smaller operation. ✅

**`extend` logic:**
1. `file.get()` → if 404, return `false`.
2. Parse `lockUntil` and `lockedBy` → if `lockedBy !== hostname`, return `false`. If `lockUntil <= now`, return `false`.
3. `file.setMetadata({ lockUntil: lockAtMostUntil, lockedAt: preserved, lockedBy: preserved }, { precondition: { generationMatch } })` → if 412, return `false`. Success → `true`.
Correct. Ownership and validity checks in the right order. `lockedAt` and `lockedBy` preserved from existing metadata. Uses `setMetadata` (not `save`). ✅

**GCS metadata casing — not an issue (unlike S3):** GCS custom metadata keys are stored as-is and returned as-is (case-sensitive). So `lockUntil` stays `lockUntil` on read. The camelCase keys used in the spec/plan are fine for GCS. ✅ (This is the key difference from the S3 spec, where metadata keys are lowercased by the server.)

**`lockName` metadata field:** The spec adds `lockName` to the metadata (the S3 spec doesn't have this). This is "useful for debugging when objects are inspected out-of-band." A nice addition — when you look at a GCS object in the console, you can see which lock name it corresponds to without parsing the object name. ✅

**`gzip: false` in `file.save()`:** Prevents GCS from gzipping the empty body. Correct — unnecessary overhead for an empty body. ✅

## Gaps and Issues

1. **`updateRecord` returns `false` on `file.get()` 404 — prevents registry cache clear.** Same issue as the S3 spec. The spec says:
   > "If `file.get()` throws with code `404` → return `false` (object was deleted externally; the registry is stale)."

   The problem: `StorageBasedLockProvider.lock()` only clears the `LockRecordRegistry` cache on **exception** from `updateRecord`, not on `false` (see core spec §13 algorithm). Returning `false` means "lock held by someone else" — the registry keeps the name, and the next `lock()` call goes to `updateRecord` again → `file.get()` 404 → `false` → `undefined`. The lock is **stuck forever** — it can never be re-acquired via `insertRecord` because the registry never clears.

   Compare with the Couchbase spec (`05-couchbase.md`), which correctly propagates `DocumentNotFoundError` from `updateRecord` to trigger the cache clear. The S3 spec has the same bug as the GCS spec — both should be fixed to match the Couchbase approach.

   **Fix:** `updateRecord` should **throw** when `file.get()` returns 404 (not return `false`). The thrown error triggers `StorageBasedLockProvider` to clear the cache. The error propagates to the caller on this attempt (the task doesn't execute), but the next `lock()` call retries `insertRecord`. This matches the Couchbase spec's approach and is the correct ShedLock pattern.

2. **`setMetadata` generation increment — needs verification.** The plan's risk table notes: "`setMetadata` on some GCS configurations does not increment generation — Tested manually — if a real bucket shows this, document as a known incompatibility and recommend `save` with `generationMatch` instead." This is a valid concern. The `unlock` and `extend` operations rely on `setMetadata` incrementing the generation (so that a subsequent `updateRecord` with `generationMatch` fails if the object was modified). If `setMetadata` does NOT increment generation, the compare-and-swap semantics break: a concurrent `setMetadata` from another instance could succeed with the same generation, and our `setMetadata` with the old generation would also succeed — both writes would "succeed" but only one would be reflected.

   In standard GCS, `setMetadata` (PATCH object metadata) does increment the generation. But this should be verified during the manual verification step (Step 8). The plan correctly flags this as a risk. If it turns out to be an issue, the fix is to use `file.save('', { metadata, precondition: { generationMatch } })` instead of `setMetadata` for unlock/extend — slightly larger operation but guaranteed generation increment.

   **Recommend:** Add an explicit verification step in the manual verification procedure: "Verify that `setMetadata` increments the object's generation number (check generation before and after a `setMetadata` call)."

3. **No integration tests — reliance on manual verification.** The spec and plan correctly justify the unit-tests-only approach (no GCS emulator with correct precondition semantics). However, this means the provider has less automated test coverage than other providers. The manual verification procedure (Step 8) is the release gate, but manual procedures risk being skipped. Consider:
   - Adding a CI workflow (manually triggered, using GCP credentials stored as CI secrets) that runs the manual verification procedure against a real GCS bucket. This automates the release gate.
   - Using `fake-gcs-server` for a *smoke* test (not the canonical contract) — at least verifies that the SDK calls are well-formed and the provider doesn't crash against a GCS-like API. The spec correctly notes fake-gcs-server's precondition semantics differ, but a smoke test would catch gross errors.

4. **`objectPrefix` trailing slash convention.** The default is `'shedlock/'` (with trailing slash). If a user sets `objectPrefix: 'shedlock'` (no trailing slash), the object key would be `'shedlockmy-task'` — no separator. This could be surprising. The plan says "Keep as user-specified." The spec doesn't mention this. Recommend documenting: "If you want a separator between the prefix and the lock name, include the trailing `/` in `objectPrefix`."

5. **`createGcsProviderConfig` factory is redundant.** Same as the S3 spec — the factory validates `bucket` non-empty and defaults `objectPrefix`. The `GcsLockProvider` constructor could do this inline. Minor — not a blocker.

6. **`Utils.getHostname()` returns `'unknown'` in some environments.** The plan's risk table notes: "Acceptable — `lockedBy` is an opaque identifier. Document that callers wanting strict ownership can override via a subclass of `GcsStorageAccessor` if needed (not in v1 public API)." This is fine for v1 — `lockedBy` is used for extend ownership, and if all instances return `'unknown'`, they all share ownership (which is a problem for multi-instance locking). Recommend documenting: "If `Utils.getHostname()` returns the same value on all instances (e.g., containers without hostname), set `lockedByValue` explicitly per instance." Wait — the GCS spec doesn't have a `lockedByValue` config option (unlike Neo4j and Couchbase). The `lockedBy` is hardcoded to `this.getHostname()` from `AbstractStorageAccessor`. This means the GCS provider **cannot** override `lockedByValue` — all instances with the same hostname share extend ownership. This is a gap vs the Neo4j and Couchbase specs, which expose `lockedByValue` in their options. **Fix:** Add `lockedByValue?: string` to `GcsProviderConfig` (default `Utils.getHostname()`), matching the Neo4j and Couchbase specs. This is important for multi-instance deployments where hostnames may be identical (e.g., containers with the same hostname, or `unknown`).

## Recommendations

1. **Fix `updateRecord` 404 handling.** Change `updateRecord` to **throw** when `file.get()` returns 404, instead of returning `false`. This triggers `StorageBasedLockProvider` to clear the `LockRecordRegistry` cache, allowing the next `lock()` call to retry `insertRecord`. This matches the Couchbase spec's approach. Update the spec's error handling table, the plan's `updateRecord` implementation, and the unit test (the unit test "Missing record: `get()` throws 404 → returns `false`" should become "Missing record: `get()` throws 404 → throws").

2. **Add `lockedByValue` to `GcsProviderConfig`.** Match the Neo4j and Couchbase specs — expose `lockedByValue?: string` (default `Utils.getHostname()`) in the provider options. This is critical for multi-instance deployments where hostnames may be identical or `'unknown'`. Without this, the GCS provider's extend ownership is unreliable.

3. **Verify `setMetadata` generation increment** during the manual verification procedure. Add an explicit step: "Verify that `setMetadata` increments the object's generation number." If it doesn't, switch `unlock`/`extend` to `file.save('', { metadata, precondition: { generationMatch } })`.

4. **Consider automating the manual verification** with a CI workflow (manually triggered, using GCP credentials) so the release gate isn't purely manual.

5. **Document `objectPrefix` trailing slash convention** — users should include the trailing `/` if they want a separator.

## Verdict: APPROVED WITH NOTES

The GCS precondition approach (`doesNotExist` / `generationMatch`) is correct, the duck-typed error detection is robust, and the unit-tests-only decision is well-justified. The `updateRecord` 404 issue (#1) is the same bug as the S3 spec — it should be fixed to throw on 404 (matching the Couchbase spec) to prevent stuck locks when objects are externally deleted. The missing `lockedByValue` config option (#6) is a gap vs the Neo4j and Couchbase specs — it should be added for multi-instance extend ownership. The `setMetadata` generation increment (#2) should be verified during manual testing. With these notes addressed, the spec and plan are implementation-ready.
