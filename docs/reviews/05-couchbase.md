# Review: @tslock/couchbase

**Spec:** `docs/specs/05-couchbase.md`
**Plan:** `docs/plans/05-couchbase.md`

## Summary

The Couchbase provider implements `StorageAccessor` over the `couchbase` Node.js SDK and wraps it with `StorageBasedLockProvider`. Locking uses `Collection.insert()` (fails with `DocumentExistsException`) for first-time locks and `Collection.replace()` with CAS (fails with `CasMismatchException`) for updates/unlock/extend. The spec and plan are thorough and technically sound. The asymmetric error handling (propagate `DocumentNotFoundError` from `updateRecord` to trigger cache clear; swallow it in `unlock` and `extend`) is well-reasoned and matches ShedLock's Java provider. One incomplete integration test and the confusing Couchbase SDK versioning are the main notes. Implementation-ready.

## Vision Alignment

**Aligned.** Vision §6.2 specifies Couchbase with "insert + CAS replace" mechanism, `couchbase` driver, package `@tslock/couchbase`, using `StorageBasedLockProvider`. The spec uses exactly this — `insert` for first-time locks, `replace` with CAS for updates. Vision §4 "Provider-pluggable, minimal dependencies" — peer deps on `couchbase` + `@tslock/core` only. Framework-agnostic.

## Architecture Alignment

**Correct as StorageBasedLockProvider.** Architecture §6.1 Category A lists Couchbase among the 11 storage-based providers. The spec implements `StorageAccessor` (insert/update/unlock/extend) and delegates to `StorageBasedLockProvider` — correct. The `CouchbaseLockProvider` class `implements ExtensibleLockProvider` by delegating to `StorageBasedLockProvider` — correct. Types are consistent with core abstractions. Peer dep `couchbase ^4.0.0` matches vision (with the confusing note that npm `couchbase@4.x` = SDK 3.x).

## Spec Completeness

**Complete.** Public API types defined: `CouchbaseLockProvider`, `CouchbaseLockProviderOptions`, `CouchbaseColumnNames`, `buildDocumentId` helper. Locking mechanism (insert/update/unlock/extend) is fully specified with SDK calls, document body structure, parameter values, and result handling for each. Error handling is a 13-row table covering `DocumentExistsException`, `DocumentNotFoundError`, `CasMismatchException`, connection errors, auth errors, timeout, document ID too long. Configuration options with defaults are tabulated. Setup requirements (Couchbase 6.0+, bucket/scope/collection, no TTL) are documented. The `instanceof`-based error detection is preferred over error-code matching with rationale. File structure is clear. Integration test approach (Couchbase container, REST API provisioning) is documented.

The spec clearly explains the asymmetric error handling: `updateRecord` propagates `DocumentNotFoundError` (triggers `StorageBasedLockProvider` cache clear), `unlock` swallows it (best-effort), `extend` returns `false` (lock gone). This is the correct ShedLock pattern.

## Plan Completeness

**Complete.** 9 steps from scaffolding through verification. Steps ordered logically: document-id helper (no SDK dep) → types → accessor (mocked SDK tests) → provider → index → integration tests. Unit tests use a mocked `Collection` — the test list is comprehensive (17 scenarios covering insert/update/unlock/extend success and error paths, custom column names, custom prefix). Integration tests use `CouchbaseContainer('couchbase/server:7.6')` with bucket provisioning and 180s startup timeout. The risk table is thorough (10 rows) covering container flakiness, SDK versioning, CAS mismatch on unlock, `DocumentNotFoundError` cache miss, hostname stability, document body shape, document ID length, column name collisions, concurrent insert race, and `lockedBy` undefined in legacy documents. Estimation (~5 files, ~350-450 lines, one session plus container debugging) is reasonable.

## Technical Correctness

**`Collection.insert()` for first-time locks:** Correct. `insert` fails atomically with `DocumentExistsException` if the document already exists. This is the Couchbase equivalent of a unique-key insert. ✅

**`Collection.replace()` with CAS for updates:** Correct. `replace` with `{ cas: getResult.cas }` fails with `CasMismatchException` if the document was modified concurrently. This is the Couchbase compare-and-swap primitive. ✅

**`Collection.get()` for reading existing documents:** Correct. Returns `getResult.content` (the document body) and `getResult.cas` (the CAS token). ✅

**Error detection via `instanceof`:** The spec uses `instanceof DocumentExistsException`, `instanceof CasMismatchException`, `instanceof DocumentNotFoundError`. The Couchbase Node.js SDK exposes stable class hierarchies for these — `instanceof` is the correct approach (preferred over error-code string matching). ✅

**`updateRecord` logic:**
1. `get(documentId)` → if `DocumentNotFoundError`, propagate (triggers `StorageBasedLockProvider` cache clear).
2. Check `existing.lockUntil > now` → if true, return `false` (lock still held).
3. `replace(documentId, newDocument, { cas })` → if `CasMismatchException`, return `false` (concurrent modification).
4. Success → return `true`.
This is correct. The `DocumentNotFoundError` propagation is the key design choice — it allows the registry to clear and retry with `insertRecord` on the next call. ✅

**`unlock` logic:**
1. `get(documentId)` → if `DocumentNotFoundError`, no-op return (best-effort).
2. `replace(documentId, { ...existing, lockUntil: unlockTime }, { cas })` → if `CasMismatchException`, swallow and log (best-effort).
3. Success → return `void`.
Correct. The `{ ...existing, [lockUntilColumn]: unlockTime }` preserves other fields and only updates `lockUntil`. The `CasMismatchException` swallow is correct — unlock is best-effort, and a stuck lock expires via `lockAtMostFor`. Matches ShedLock Java. ✅

**`extend` logic:**
1. `get(documentId)` → if `DocumentNotFoundError`, return `false` (lock gone).
2. Check `lockedBy !== this.lockedByValue` → if true, return `false` (not our lock).
3. Check `lockUntil <= now` → if true, return `false` (expired).
4. `replace(documentId, { ...existing, lockUntil: lockAtMostUntil }, { cas })` → if `CasMismatchException`, return `false`.
5. Success → return `true`.
Correct. The ownership check (`lockedBy`) and validity check (`lockUntil`) are in the right order. The `DocumentNotFoundError` returns `false` (not propagate) — correct, because extend doesn't need to clear the registry (it's not trying to re-acquire). ✅

**Document body:** Uses configured column names as keys. The `updateRecord` creates a fresh document (not `{...existing}`) — overwrites all fields. This is fine because the lock document only has 4 fields. The `unlock` and `extend` use `{...existing, [field]: value}` to preserve forward-compatible fields. ✅

**Document ID length:** `buildDocumentId` throws `LockException` if `prefix + name` exceeds 250 bytes (Couchbase's hard limit). ✅

**`lockedBy` stability:** Same assumption as Neo4j — `extend` uses `this.opts.lockedByValue`, which requires hostname stability. The plan's risk table documents this. ✅

## Gaps and Issues

1. **Incomplete integration test for "rejects extend from a different lockedBy".** Plan Step 8 shows:
   ```typescript
   it('rejects extend from a different lockedBy', async () => {
     const owner = new CouchbaseLockProvider(collection, { lockedByValue: 'node-A' });
     const intruder = new CouchbaseLockProvider(collection, { lockedByValue: 'node-B' });
     const lock = await owner.lock(config('extend-foreign', '1m'));
     const extended = await lock!.extend('1m', 0);
     expect(extended).toBeDefined();
     await extended!.unlock();
   });
   ```
   This test creates an `intruder` provider but never uses it. The `lock!.extend('1m', 0)` is called on the **owner's** lock — which should succeed (same `lockedBy`). The test asserts `extended` is defined — which is the happy path, not the rejection path. The test should either: (a) acquire a lock with `owner`, then attempt to extend it via the `intruder`'s accessor (asserting `false`), or (b) acquire a lock with `owner`, then have `intruder.lock()` return `undefined` (lock held), and separately verify `intruder`'s accessor.extend returns `false`. As written, the test does not verify cross-instance extend rejection. **Should be fixed.**

2. **Couchbase SDK versioning confusion.** The spec says "couchbase ^4.0.0 (SDK 3.x for Node.js is published as couchbase@4.x; the SDK is referred to as 'Couchbase SDK 3.x' in Couchbase documentation despite the npm version being 4.x)." This is confusing but accurate. The plan's risk table says "Peer dep `couchbase: ^4.0.0` (latest). Test against installed version. The SDK's `Collection` API is stable across v4.x." Recommend adding a clarifying note in the README that `couchbase@4.x` on npm = SDK 3.x in Couchbase docs.

3. **`DocumentNotFoundError` propagation behavior.** The spec says `updateRecord` propagates `DocumentNotFoundError`, which "propagates to `StorageBasedLockProvider.lock()`, which clears the registry cache so the next attempt will try `insertRecord` again." This is correct, but the caller of `lock()` will see an **exception** on this attempt (not `undefined`). The task is not executed, and the error propagates to `DefaultLockingTaskExecutor`, which re-throws. On the **next** `lock()` call, the cache is clear, so `insertRecord` is tried. This is a "fail once, retry next" pattern. It's correct (matches ShedLock Java) but could surprise users who expect `lock()` to return `undefined` rather than throw when the record is missing. The spec documents this ("propagate (triggers StorageBasedLockProvider cache clear)") but could be more explicit about the caller-visible behavior (exception, not undefined).

4. **Couchbase container setup complexity.** The plan acknowledges Couchbase testcontainer setup is "more involved than other databases because the container requires cluster initialization via the REST API." The `testcontainers` `CouchbaseContainer` class may or may not handle this fully. The plan's fallback (custom `GenericContainer` with REST init script) is reasonable but adds implementation risk. The 180s startup timeout is generous. This is a practical risk, not a spec issue.

5. **`columnNames` validation.** The spec says "All column names must be non-empty strings." The plan's `resolveOptions` validates this. But there's no validation that column names don't conflict with Couchbase metadata fields or internal fields. Since the document body is a plain JSON object, this is not a real concern. ✅

6. **`lockedBy` undefined in legacy documents.** The plan's risk table notes: "If a legacy document lacks `lockedBy`, `existing[lockedByColumn]` is `undefined`; `undefined !== this.lockedByValue` returns `false` (extend rejected). This is the correct conservative behavior." Good — this handles migration from a non-TSLock document store. ✅

## Recommendations

1. **Fix the "rejects extend from a different lockedBy" integration test.** The test should verify that the `intruder` cannot extend the `owner`'s lock. Approach: acquire lock with `owner`, then call `intruder`'s internal accessor `.extend(config)` directly (or via a `StorageBasedLockProvider` constructed with the intruder's accessor), and assert it returns `false`. The current test calls `lock!.extend()` on the owner's own lock — which succeeds and doesn't test the rejection.

2. **Clarify `DocumentNotFoundError` propagation behavior.** Add a note to the spec's `updateRecord` section: "When `DocumentNotFoundError` propagates, the caller of `lock()` sees an exception on this attempt. The registry cache is cleared, and the next `lock()` call will retry `insertRecord`. This is a 'fail once, retry next' pattern — the task is not executed on the failing attempt."

3. **Add Couchbase SDK versioning note** to the README: "This package peer-depends on `couchbase@^4.0.0` on npm, which corresponds to Couchbase SDK 3.x in Couchbase documentation."

4. **Document the Couchbase container setup risk** in the plan more prominently — the `CouchbaseContainer` from `testcontainers` may require additional configuration. Have the fallback `GenericContainer` + REST init script ready.

## Verdict: APPROVED WITH NOTES

The insert + CAS replace mechanism, the asymmetric error handling (propagate on `updateRecord` 404, swallow on `unlock` 412, return false on `extend` 404), and the `instanceof`-based error detection are all correct and faithful to ShedLock's Java `CouchbaseLockProvider`. The incomplete integration test (#1) should be fixed — it claims to verify cross-instance extend rejection but exercises the happy path instead. The SDK versioning confusion (#2) and the `DocumentNotFoundError` propagation behavior (#3) should be documented. The spec and plan are implementation-ready with these notes addressed.
