# Implementation Plan: Lock health / admin snapshot

## Overview

Implement `docs/specs/29-lock-health-snapshot.md` in `@tslock/core`: extend `TrackingLockProviderWrapper` with metadata records, add `createLockHealthMonitor` + stable `LockHealthSnapshot`, document HTTP/CLI wiring, tests, and a minor changeset. Complementary to `@tslock/otel`; no new package.

## Files

Create:

- `packages/core/src/lock-health.ts` — types, `createLockHealthMonitor`, `formatSnapshot` helper
- `packages/core/__tests__/lock-health.test.ts`
- `.changeset/lock-health-snapshot.md`

Update:

- `packages/core/src/tracking-lock-provider.ts` — `ActiveLockRecord`, `getActiveLockRecords()`, acquire/extend/unlock metadata
- `packages/core/src/index.ts` — export new types and factory
- `packages/core/__tests__/tracking-lock-provider.test.ts` — record / extend metadata cases
- `packages/core/README.md` — health section with HTTP + CLI examples
- `README.md` — core feature row / brief mention if appropriate
- `docs/00-vision.md` — one-line readiness for lock health snapshot
- `docs/01-architecture.md` — short note under TrackingLockProviderWrapper

Do not edit existing specs, plans, or reviews (including `00-core` and `28-otel`).

## Steps

1. Extend `TrackingLockProviderWrapper`:
   - Internal map from tracking wrapper instance → `ActiveLockRecord` (or store record on the wrapper).
   - On lock success: create frozen record with `acquiredAt`/`updatedAt` from `ClockProvider.now()`.
   - On extend success: new wrapper; copy `acquiredAt`; refresh `updatedAt` and durations from the extend arguments.
   - On unlock: delete record.
   - Add `getActiveLockRecords(): readonly ActiveLockRecord[]`.
   - Keep `getActiveLocks()` unchanged in contract.

2. Implement `packages/core/src/lock-health.ts`:
   - Export `ActiveLockRecord` from tracking (or re-export from lock-health if co-located — prefer defining the record type next to tracking and re-exporting from index).
   - `createLockHealthMonitor({ tracking, maxKeepAliveFailures? })`.
   - Validate `maxKeepAliveFailures >= 1`.
   - Listener + `onKeepAliveFailure` + `snapshot` + `formatSnapshot` as specified.
   - Sort `activeLocks` by name; compute `overdueLocks`; freeze snapshot graph.
   - Swallow errors inside monitor state updates.

3. Export from `packages/core/src/index.ts`.

4. Tests:
   - Tracking metadata lifecycle (acquire / unlock / extend / double unlock).
   - Monitor last acquire/skip, keep-alive ring buffer, overdue detection (advance `ClockProvider`), freeze + JSON, format contains names, factory validation.

5. Docs + changeset (`@tslock/core` minor). Include otel complementarity and composition note.

## Verification

```bash
pnpm --filter @tslock/core typecheck
pnpm --filter @tslock/core test
pnpm --filter @tslock/core build
pnpm check
pnpm -r typecheck
pnpm -r test
pnpm -r build
```

Integration and packed-peers are unchanged by this core-only additive API; run when practical.

## Rollback

Revert the listed files. No persistence and no migration.

## Review risks

- Exposing `SimpleLock` on the snapshot would invite admin unlock — keep metadata-only.
- `overdueLocks` false positives if `updatedAt` is not refreshed on extend — extend path must update.
- Keep-alive renews through the tracking wrapper only when tracking wraps the storage provider *inside* keep-alive, or when keep-alive's inner extend goes through tracking. Document wiring: `KeepAliveLockProvider(tracking)` so renewals update tracking; if tracking wraps keep-alive instead, renewals on the inner handle are invisible to tracking (same pitfall as otel instrumentation order). Spec README must show `KeepAliveLockProvider(tracking, …)`.
- Sorting and freeze must not mutate the live tracking store.
