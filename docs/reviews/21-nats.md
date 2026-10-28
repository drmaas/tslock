# Review: @tslock/nats

**Spec:** `docs/specs/21-nats.md`
**Plan:** `docs/plans/21-nats.md`

## Summary

The NATS provider implements a DIRECT `LockProvider` using JetStream Key-Value store with revision-based optimistic concurrency: `kv.create` (fails if key exists) for new locks, `kv.update` with revision (fails on mismatch) for expired locks. The lock value is an 8-byte big-endian int64 encoding `lockAtMostUntil` epoch millis. This is a faithful port of ShedLock's `NatsLockProvider`. The algorithm and value encoding are correct. The primary concern is the unconditional `kv.delete` in unlock (can clobber a concurrent acquirer's lock in an overrun scenario) and the need to verify the JetStream conflict error code.

## Vision Alignment

**Aligned.** Vision §6.5 specifies "NATS JetStream" with "KeyValue bucket + create/update with revision" mechanism, `nats` driver, package `@tslock/nats`. The spec matches exactly — KV bucket, `create`/`update` with revision, 8-byte value. Vision §4 "Minimal dependencies" is honored: peer-dep on `nats` + `@tslock/core` only. The default `StorageType.Memory` (ephemeral locks) is a sensible default that matches the time-based lock philosophy.

## Architecture Alignment

**Correct as DIRECT LockProvider.** Architecture §6.8 states: "KeyValue bucket with revision-based optimistic concurrency. Lock = `create` (fails if key exists) or `update` with revision (fails if revision mismatch). Value = 8-byte epoch millis. No extend." The spec implements `LockProvider` directly — correct. The KV `create`/`update`/`delete` with revision does not fit the `StorageAccessor` insert/update/unlock/extend contract.

## Spec Completeness

**Complete.** Covers: package metadata, public API (`NatsLockProvider` + `createNatsLockProvider` factory, options with `StorageType`, `NatsLock`), value format with `longToBytes`/`bytesToLong` code and range analysis, full `lock()`/`doUnlock()` pseudocode, the `isNatsConflictError` helper, the no-extend rationale, error-handling table (12 scenarios), file structure, dependencies, exports, and non-goals. The no-extend rationale ("`kv.update` with a revision only checks the revision number, not the value — a race between two holders of the same revision could clobber") is well-explained.

## Plan Completeness

**Complete.** 9 steps including a standalone `long-utils.ts` step (Step 2, tested immediately), options, lock, provider + factory + conflict helper, index, unit tests (mocked `KV` + dedicated `long-utils.test.ts`), integration tests (testcontainer `nats:2.10` with `-js` flag), and a 9-row risk table. The `long-utils` unit tests cover round-trip, edge values (0, 1, 1e12, 1.7e12), and both `Buffer`/`Uint8Array` inputs — good rigor.

## Technical Correctness

**Is KeyValue + create/update with revision correct?** Yes. The three-path algorithm is correct:
- **Path 1 (key absent):** `kv.get(name)` returns `null` → `kv.create(name, value)` atomically creates only if key does not exist. On conflict → `undefined`. Correct.
- **Path 2 (key present, not expired):** `existingLockUntil > now` → return `undefined`. Correct.
- **Path 3 (key present, expired):** `kv.update(name, value, entry.revision)` atomically updates only if revision matches. On conflict → `undefined`. Correct.

**Is the 8-byte value encoding correct?** Yes. `Buffer.alloc(8); buf.writeBigInt64BE(BigInt(epochMillis), 0)` — 8-byte big-endian signed int64. `Number(Buffer.from(buf).readBigInt64BE(0))` — reads big-endian int64, converts to Number. The range analysis is correct: epoch millis (~1.7e12) are far below 2^53 (~9e15), so `Number()` is safe. The `Buffer.from(buf)` wrapper handles both `Uint8Array` (what `nats` returns) and `Buffer` inputs. Correct.

**Issue 1 — Unconditional `kv.delete(name)` in unlock can clobber a concurrent acquirer.** The spec's `doUnlock()`:
```typescript
if (lockAtLeastUntil(this.config) > now) {
  await this.kv.update(this.config.name, longToBytes(lockAtLeastUntil(this.config)), entry.revision);
} else {
  await this.kv.delete(this.config.name);  // UNCONDITIONAL — no revision check
}
```
The `lockUntil > lockAtMostUntil(config)` guard (step 2 of `doUnlock`) is meant to detect if someone else has taken over. But it only triggers if the stored `lockUntil` is **greater** than what we set. If the holder **overruns** `lockAtMostFor` and another acquirer takes over with a **shorter** `lockAtMostFor`, the new acquirer's `lockAtMostUntil` could be less than or equal to ours:
1. Holder A acquires with `lockAtMostFor = 60s` → writes `lockAtMostUntil_A = createdAt_A + 60s`.
2. A's lock expires (60s passes).
3. Acquirer B acquires with `lockAtMostFor = 10s` → `kv.update(name, lockAtMostUntil_B, revision)` succeeds. `lockAtMostUntil_B = now + 10s`, which is less than `lockAtMostUntil_A`.
4. Holder A calls `unlock()` (late): `kv.get` → entry with `lockAtMostUntil_B`. The guard `lockAtMostUntil_B > lockAtMostUntil_A` is **false** (B's value is smaller) → guard does not trigger.
5. If `lockAtLeastUntil_A <= now` → `kv.delete(name)` → **deletes B's lock**. Another acquirer C can now acquire while B still holds the lock.

This is the same inherent limitation as ZooKeeper's unconditional `setData` unlock — if you overrun `lockAtMostFor`, your late unlock can clobber the new holder. It matches ShedLock's behavior (time-based locks are hints, not fencing tokens). **But the spec's guard (`lockUntil > lockAtMostUntil`) is presented as a complete clobbering prevention, and it is not** — it only covers the case where the new holder used a longer or equal `lockAtMostFor`. The limitation should be documented honestly.

The fix (if stronger safety is desired) would be a revision-checked `kv.delete(name, entry.revision)`, but the NATS KV API may not expose revision-checked delete. The spec does not attempt this. Given that this matches ShedLock's design and time-based locks are hints, the unconditional delete is acceptable **if documented as a known limitation**.

**Issue 2 — `isNatsConflictError` error code 10071.** The helper checks `e.code === 10071` for KV create/update conflict. The plan's risk table says "Verify the exact error code (10071 for 'KV update conflict' / key-exists) against the `nats` client source." If the code is wrong, conflicts will **propagate as errors** instead of returning `undefined` — breaking the skip-if-held semantic. This is a critical detail to verify. The helper also checks `e.message.includes('stream name already in use')` — but this message is for bucket-creation conflicts (in `createNatsLockProvider`), not for `kv.create`/`kv.update` conflicts. `isNatsConflictError` is only called in `lock()`, so the message check is **dead code** in this context. It is harmless but misleading — it suggests the helper handles bucket-creation conflicts, but `createNatsLockProvider` does not use it.

**Issue 3 — `kv.update` in unlock does not catch conflict errors.** In the `lockAtLeastFor > 0` branch, `kv.update(name, value, entry.revision)` can throw a conflict error if the revision mismatched (lock taken over between our `kv.get` and `kv.update`). The spec does not catch this — the error propagates. `DefaultLockingTaskExecutor` catches unlock errors in `finally` and logs them. This is acceptable (the lock was already taken over, so the error is informational), but a silent no-op (catch conflict → return) would be cleaner. Minor.

**Unlock skip-guard is good.** The `entry === null` check (key already deleted) and the `lockUntil > lockAtMostUntil(config)` check (lock taken/extended) are both sensible guards. The former prevents errors on double-unlock or unlock-after-expiry-with-delete. The latter prevents clobbering in the common case. Good defensive design.

## Gaps and Issues

1. **Unconditional `kv.delete` clobbering** — the `lockUntil > lockAtMostUntil` guard does not cover the overrun-with-shorter-`lockAtMostFor` scenario. The unconditional delete can clobber a concurrent acquirer's lock. This is inherent to time-based locks (matches ShedLock) but should be documented as a known limitation, not presented as fully prevented.
2. **Error code 10071** — needs verification against the `nats` client source. If wrong, the skip-if-held semantic breaks (conflicts propagate as errors).
3. **`isNatsConflictError` message check is dead code** — the 'stream name already in use' check is never triggered in `lock()` (only relevant for bucket creation, which doesn't use this helper). Remove or clarify.
4. **`kv.update` in unlock propagates conflicts** — acceptable (logged by executor) but a silent no-op would be cleaner. Minor.
5. **Bucket auto-create requires JetStream** — documented in the spec and plan. The integration test starts NATS with `-js`. Good.
6. **`NatsConnection` lifecycle** — the factory (`createNatsLockProvider`) holds the connection via the `KV` handle but does not store it separately. The user is responsible for closing it. The plan documents this. Acceptable, but the user has no handle to close — they must either keep their own reference or rely on process exit. Worth a README note.

## Recommendations

1. **Document the unconditional-delete clobbering limitation** honestly. The `lockUntil > lockAtMostUntil` guard mitigates the common case but does not prevent all clobbering scenarios (overrun with shorter `lockAtMostFor`). State this as inherent to time-based locks.
2. **Verify error code 10071** against the `nats` client source before implementation. If different, update `isNatsConflictError`.
3. **Remove or relocate the 'stream name already in use' message check** from `isNatsConflictError` — it is dead code in the `lock()` path. If bucket-creation conflict handling is needed, add it to `createNatsLockProvider` separately.
4. **Consider catching conflict errors in unlock's `kv.update`** path and silently returning (the lock was taken over; no-op is correct).
5. **Clarify `NatsConnection` lifecycle** in the README — the factory does not return the connection handle; users who need to close it should construct `NatsLockProvider` directly with their own `KV`.

## Verdict: APPROVED WITH NOTES

The algorithm is correct and faithfully matches ShedLock's NATS provider. The KV `create`/`update` with revision pattern and the 8-byte big-endian value encoding are both sound. The unconditional `kv.delete` clobbering risk is the main concern — it is inherent to time-based locks but should be documented honestly rather than presented as fully prevented by the `lockUntil > lockAtMostUntil` guard. The error code 10071 needs verification. No structural or architectural issues.
