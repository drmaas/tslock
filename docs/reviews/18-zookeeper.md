# Review: @tslock/zookeeper

**Spec:** `docs/specs/18-zookeeper.md`
**Plan:** `docs/plans/18-zookeeper.md`

## Summary

The ZooKeeper provider implements a DIRECT `LockProvider` using PERSISTENT znodes with optimistic concurrency: `getData` + `setData(path, data, version)` CAS on existing znodes, or `create` on missing znodes. This is a faithful port of ShedLock's `ZooKeeperLockProvider`. The spec correctly chooses PERSISTENT over EPHEMERAL znodes and correctly handles the three error cases (`NoNodeException`, `BadVersionException`, `NodeExistsException`). One API-shape concern with the `zookeeper` (node-zookeeper) npm package's `getData` return value needs verification before implementation, and the unconditional-unlock-clobbering limitation should be acknowledged more explicitly.

## Vision Alignment

**Aligned.** Vision §6.5 specifies ZooKeeper with "PERSISTENT znode + version check" mechanism, `zk` (node-zookeeper) driver, package `@tslock/zookeeper`. The spec matches exactly — PERSISTENT znodes, version-based CAS, `zookeeper` npm package. Vision §2 "Assumes synchronized clocks" is relevant here since lock validity depends on comparing `lockAtMostUntil` to `now`; the spec relies on this assumption (does not restate it, but it is inherited from core).

## Architecture Alignment

**Correct as DIRECT LockProvider.** Architecture §6.5 states: "PERSISTENT znodes (not ephemeral). Lock = znode whose data is the ISO timestamp of `lockAtMostUntil`. Acquire = create-or-set-version. No extend. Uses optimistic concurrency via `version` check." The spec implements `LockProvider` directly — correct. The optimistic-concurrency pattern (getData/setData/create) does not fit the `StorageAccessor` insert/update/unlock/extend contract.

The spec's Non-Goals section explicitly and correctly explains why PERSISTENT (not EPHEMERAL) and why not the classic sequential-ephemeral lock recipe (which is a *blocking* lock; TSLock is skip-if-held). This is well-reasoned.

## Spec Completeness

**Complete.** Covers: package metadata, public API (`ZooKeeperLockProvider`, options, `ZooKeeperLock`, `ZooKeeperAccessor`), full `lock()`/`unlock()` pseudocode with error-mapping logic, error-handling table (11 scenarios), file structure (6 source files including a dedicated `zookeeper-errors.ts`), dependencies, exports, and non-goals. The `basePath` normalization (trailing-slash stripping) is documented. The `creatingParentsIfNeeded` flag for base-path auto-creation is specified.

## Plan Completeness

**Complete.** 10 steps including a dedicated error-helpers step (Step 3), path normalization, accessor, lock, provider, index, unit tests (mocked `ZooKeeper` with concrete mock code covering all 6 lock-path branches and 2 unlock-path branches), integration tests (ZooKeeper testcontainer `zookeeper:3.9.0`), and an 11-row risk table. The plan correctly uses unique basePaths per test to avoid recursive-delete teardown.

## Technical Correctness

**Are PERSISTENT znodes (not ephemeral) correctly specified?** Yes. The spec is explicit: "locks are time-based, not session-based. A crashed holder's lock remains valid until `lockAtMostUntil` (as written in the znode data), then becomes eligible for takeover by the next acquirer. There is no session-liveness coupling." This is the correct ShedLock semantic. EPHEMERAL would couple lock validity to the ZooKeeper session, which is wrong for time-based locks. The Non-Goals section reinforces this with a clear rationale.

**Is version-based CAS correct?** Yes. `getData(nodePath)` returns `{ data, stat: { version } }`. `setData(nodePath, data, stat.version)` succeeds only if the current version matches. On a concurrent `setData`/`create`, the version bumps and `BadVersionException` is thrown → return `undefined` (lost the race). Correct.

**Is NoNodeException/BadVersionException handling correct?** Yes. The three-way error mapping is correct:
- `getData` → `NoNodeException` → fall through to `create` (first-ever acquisition).
- `create` → `NodeExistsException` → return `undefined` (lost the create race).
- `setData` → `BadVersionException` → return `undefined` (lost the CAS).

The nested try/catch in `lock()` correctly handles the `NoNode` → `create` → `NodeExists` race chain.

**Issue 1 — `getData` return shape.** The spec code:
```typescript
const stat = await this.client.getData(nodePath);
const existingLockUntil = Date.parse(stat.data.toString('utf8'));
// ...
await this.client.setData(nodePath, Buffer.from(isoLockAtMostUntil), stat.version);
```
The variable is named `stat` but accessed as both `.data` and `.version`. The `zookeeper` (node-zookeeper) npm package's promisified `getData` likely resolves to `{ data: Buffer, stat: { version: number, ... } }` — meaning the version is at `result.stat.version`, not `result.version`. If so, `stat.version` (where `stat` is the result object) would be `undefined`, and `setData(path, data, undefined)` would behave as unconditional (version `-1` in ZooKeeper means "any version"), **silently breaking the CAS**. The plan's risk table flags this ("`getData` return shape (`stat.data` vs `data` field) — confirm against the installed version") but the spec presents the code as definitive. **This must be verified and likely corrected to `result.stat.version` before implementation.** The unit test mock should use the real shape.

**Issue 2 — Unconditional `setData` in unlock can clobber a concurrent acquirer.** The spec's `unlock()` uses `setData(nodePath, data)` without a version — unconditional. The plan's risk table states "There is no race" because "a concurrent acquirer's CAS would have failed (the holder's `setData` changed the version), so the concurrent acquirer returned `undefined` and does not write." This is true **while the holder's lock is still valid** (`lockAtMostUntil > now`). But if the holder **overruns** `lockAtMostFor`:
1. Holder A's `lockAtMostUntil` is now in the past.
2. Acquirer B: `getData` → sees past `lockAtMostUntil` → `setData(path, B's lockAtMostUntil, version)` succeeds → B holds the lock.
3. Holder A calls `unlock()` (late): `setData(path, unlockTime_A)` unconditional → **overwrites B's lock** with `unlockTime_A` (which is `now`, in the past from B's perspective).
4. Acquirer C: `getData` → sees past value → CASes in → C acquires while B still thinks it holds the lock.

This is inherent to time-based locks (if you overrun `lockAtMostFor`, your lock is invalid and your unlock can interfere). It matches ShedLock's behavior. But the plan's claim "There is no race" is **too strong** — there IS a race in the overrun scenario. This should be documented as a known limitation rather than dismissed.

**Issue 3 — `create` signature.** The spec calls `client.create(nodePath, data, CreateMode.PERSISTENT, true)` with `creatingParentsIfNeeded` as the 4th arg. The `zookeeper` npm package v6 `create` signature needs confirmation — the argument order and the `creatingParentsIfNeeded` flag name may differ. The plan flags this as a risk with a unit test assertion.

## Gaps and Issues

1. **`getData` return shape** — `stat.version` vs `result.stat.version`. If the `zookeeper` package returns `{ data, stat: { version } }`, the CAS is silently broken (version becomes `undefined` → unconditional setData). Must verify and fix before implementation.
2. **Unconditional-unlock clobbering** — the plan incorrectly states "There is no race." The overrun scenario (holder exceeds `lockAtMostFor`, another acquirer takes over, holder's late unlock clobbers the new lock) is a real limitation. Should be documented as inherent to time-based locks, matching ShedLock.
3. **`create` API signature** — `creatingParentsIfNeeded` as 4th arg needs verification against `zookeeper` v6.
4. **Error code constants** — the plan notes `Exception.NO_NODE`, `Exception.BAD_VERSION`, `Exception.NODE_EXISTS` as numeric constants. The plan's Step 3 hedges ("or the numeric code `Exception.ZNO_NODE` — confirm against the installed driver"). This uncertainty should be resolved by reading the `zookeeper` package source before implementation.
5. **Znode accumulation** — PERSISTENT znodes are never deleted (by design). The spec documents this in Non-Goals. For high-cardinality lock names, this could grow unbounded. Documented, but worth a README note.

## Recommendations

1. **Verify `getData` return shape** against the installed `zookeeper` v6 package before writing the accessor. If the shape is `{ data, stat: { version } }`, fix the code to use `result.stat.version`. Design the unit test mock to match the real shape.
2. **Soften the "no race" claim** in the plan's risk table. Document the overrun-clobbering limitation as inherent to time-based locks (matching ShedLock), not as "no race."
3. **Resolve error-code constant names** by reading the `zookeeper` package source. Remove the hedge ("or the numeric code `Exception.ZNO_NODE`") once confirmed.
4. **Confirm `create` signature** including the `creatingParentsIfNeeded` argument.

## Verdict: APPROVED WITH NOTES

The algorithm is correct and faithfully matches ShedLock's ZooKeeper provider. PERSISTENT znodes, version-based CAS, and the three-way error mapping are all right. The `getData` return-shape issue is the most pressing concern — if `stat.version` should be `result.stat.version`, the CAS silently breaks. This must be verified before implementation. The unconditional-unlock limitation should be documented honestly. No structural or architectural issues.
