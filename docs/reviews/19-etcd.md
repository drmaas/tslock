# Review: @tslock/etcd

**Spec:** `docs/specs/19-etcd.md`
**Plan:** `docs/plans/19-etcd.md`

## Summary

The etcd provider implements a DIRECT `LockProvider` using etcd v3 leases and transactions: a `txn` asserting `key.version == 0` with a `then`-branch `Op.put(key, value, { lease })` atomically creates the lock with a lease whose TTL is `ceil(lockAtMostFor / 1000)` seconds. Unlock revokes the lease (deleting the key) or re-puts with a shorter lease for `lockAtLeastFor > 0`. This is a faithful port of ShedLock's `EtcdLockProvider`. The spec and plan are thorough and technically sound. The primary concern is verifying the `etcd3` client's lease-grant timing in the `unlock()` re-put path and confirming a few API details.

## Vision Alignment

**Aligned.** Vision §6.5 specifies Etcd with "Lease + txn (version == 0)" mechanism, `etcd3` driver, package `@tslock/etcd`. The spec matches exactly — lease + transaction with `Cmp.key(key).version === 0`. Vision §4 "Minimal dependencies" is honored: peer-dep on `etcd3` + `@tslock/core` only.

## Architecture Alignment

**Correct as DIRECT LockProvider.** Architecture §6.6 states: "Lease + transaction. Lock = put key with lease (TTL = `lockAtMostFor`). Unlock = revoke lease (or re-put with shorter lease for `lockAtLeastFor`). No extend." The spec implements `LockProvider` directly — correct. The lease + txn pattern does not fit the `StorageAccessor` insert/update/unlock/extend contract.

## Spec Completeness

**Complete.** Covers: package metadata, public API (`EtcdLockProvider`, options, `EtcdLock` carrying `leaseId`, `EtcdLockAccessor`), key/value formats, full `lock()`/`unlock()` pseudocode with lease lifecycle semantics, error-handling table (12 scenarios including orphan-lease cleanup and sub-second TTL rounding), file structure, dependencies, exports, and non-goals. The `env` namespace segment in the key is well-documented. The lease-orphaning failure mode and its mitigation (catch-block revoke + TTL expiry) are clearly explained.

## Plan Completeness

**Complete.** 9 steps with `package.json`, tsup config, options, accessor, lock (carrying `leaseId`), provider, index, unit tests (mocked `Etcd3` with fluent-chain mock code covering `txn`/`put`/`lease` chains), integration tests (etcd testcontainer `quay.io/coreos/etcd:v3.5.0` with explicit `--advertise-client-urls`/`--listen-client-urls`), and a 12-row risk table. The unit test correctly asserts the re-put-then-revoke-old order for `lockAtLeastFor > 0` unlock.

## Technical Correctness

**Is lease + txn (version==0) correct?** Yes. `Cmp.key(key).version === 0` is the canonical etcd "create if absent" pattern — a key's version is 0 iff it does not exist. The `then`-branch `Op.put(key, value, { lease: leaseId })` attaches the lease to the key; when the lease is revoked or expires, etcd auto-deletes the key. The `else`-branch `Op.get(key)` consumes the branch (etcd v3 requires at least one op per branch). On `!succeeded`, the lease is not attached to any key, so it is explicitly revoked to avoid orphaned leases. Correct.

**Is lease revocation for unlock correct?** Yes. `config.lockAtLeastFor <= 0` → revoke the lease → etcd auto-deletes the key. `config.lockAtLeastFor > 0` → re-put with a new lease (TTL = `ceil(lockAtLeastFor / 1000)`), then revoke the OLD lease. Because the key now has the new lease, revoking the old lease does not delete the key. The key persists with the new lease until it expires. The **order matters** (re-put FIRST, then revoke old) and both the spec and plan correctly enforce and test this order.

**Lease-grant timing.** The spec states "`lease.id` is available immediately after `.lease()` — lease is granted on the next await (the txn commit)." This matches the `etcd3` client's behavior: `client.lease(ttl)` creates a `Lease` object, starts a background grant RPC, and `.id` is a client-generated ID available synchronously. Any operation referencing the lease ID internally awaits the grant. In `lock()`, the `txn.commit()` awaits the grant before executing the transaction. Correct.

**Issue 1 — Lease-grant timing in `unlock()` re-put.** In the `unlock()` path with `lockAtLeastFor > 0`:
```typescript
const newLease = this.client.lease(newTtlSeconds);
const newLeaseId = newLease.id;
await this.client.put(key).value(value).lease(newLeaseId).exec();
```
Here `put().lease(newLeaseId)` takes a **raw lease ID** (a number/bigint), not the `Lease` object. Unlike the `lock()` path (where `Op.put(key, value, { lease: leaseId })` is inside a txn managed by the `etcd3` client), the `put().lease(id)` call sends the raw ID to etcd. If the `etcd3` client does not internally await the pending grant for this raw ID, the put may fail with "lease not found" (etcd requires the lease to exist before attaching it to a key). The spec's comment ("lease is granted on the next await") suggests lazy grant-on-first-use, but it is unclear whether `put().lease(rawId)` triggers this. **This needs integration-test verification.** If it fails, the fix is to explicitly `await newLease.grant()` before the put, or to use a lease-scoped put if the `etcd3` API supports one.

**Issue 2 — `client.lease(0, { id: leaseId }).revoke()` API.** The spec uses `this.client.lease(0, { id: leaseId }).revoke()` to wrap an existing lease ID for revocation. Both the spec and plan flag this as "confirm against the installed `etcd3` version" with an alternative (`client.leaseClient.revoke(leaseId)`). This API detail is central to both unlock paths — if `lease(0, { id })` does not work as expected, unlock breaks. The uncertainty should be resolved before implementation.

**Issue 3 — `Op.put` option key name.** The spec uses `Op.put(key, value, { lease: leaseId })`. The plan's risk table notes: "The `etcd3` `Op.put` options use `lease` (or `leaseId`) as the key. Confirm against the installed version." If the option key is `leaseId` not `lease`, the lease would not be attached and the key would persist forever (no auto-expiry). This is a critical detail to verify.

**Sub-second TTL rounding.** `Math.ceil(config.lockAtMostFor / 1000)` — for `lockAtMostFor = 500ms`, TTL = 1 second. Documented in the error-handling table and the plan's risk table. Correct and matches ShedLock's ceiling behavior.

**No fencing tokens.** The spec's Non-Goals correctly documents: "No fencing tokens: the ShedLock algorithm does not use fencing tokens. The lock is a hint to skip work, not a guarantee of exclusive access to a downstream resource." This is accurate and important for users to understand.

## Gaps and Issues

1. **Lease-grant timing in `unlock()` re-put** — `put().lease(rawId)` may fail if the lease is not yet granted. Needs integration-test verification. Fix: explicitly `await newLease.grant()` before the put if the lazy-grant does not cover this path.
2. **`client.lease(0, { id })` API for revocation** — both spec and plan flag this as unconfirmed. Central to both unlock paths. Resolve before implementation.
3. **`Op.put` option key (`lease` vs `leaseId`)** — critical for lease attachment. If wrong, keys never auto-expire. Verify against `etcd3` source.
4. **No `lockAtMostFor` upper-bound validation** — etcd max TTL is ~5,400 days. The plan mentions documenting this, but no validation is performed. Acceptable (user error is unlikely).
5. **Keepalive behavior** — the spec's Non-Goals mentions `etcd3` auto-keeps-alive active leases. This is correct and desirable (lease should not expire while holder is alive; on crash, keepalive stops → lease expires). Documented.

## Recommendations

1. **Verify the `etcd3` lease-grant timing** for `put().lease(rawId)` in the `unlock()` re-put path. If the put fails with "lease not found", add an explicit `await newLease.grant()` before the put. The integration test should exercise the `lockAtLeastFor > 0` unlock path against a real etcd.
2. **Confirm `client.lease(0, { id })` revoke API** against the installed `etcd3` v1 source. Remove the "alternative" hedge once confirmed.
3. **Confirm `Op.put` option key name** (`lease` vs `leaseId`) against the `etcd3` source.
4. **Add an integration test** that verifies lease expiry: acquire a lock with a short `lockAtMostFor`, crash (don't unlock), wait for TTL, verify another instance can acquire.

## Verdict: APPROVED WITH NOTES

The algorithm is correct and faithfully matches ShedLock's etcd provider. The lease + txn (version==0) pattern, lease revocation for unlock, and the re-put-then-revoke-old ordering are all right. The primary risk is the `etcd3` API details (lease-grant timing for raw-ID puts, `lease(0, { id })` revocation, `Op.put` option key) — all flagged by the spec and plan but not yet confirmed. These are verification tasks, not design flaws. No structural or architectural issues.
