# Review: Scheduler Adapters (29)

**Spec:** `docs/specs/29-scheduler-adapters.md`  
**Plan:** `docs/plans/29-scheduler-adapters.md`  
**Issue:** #43

## Outcome

pass

## Summary

The four packages match the accepted packaging decision (shared `@tslock/scheduler-core` plus thin host adapters) and the NestJS skip contract: wrap/run go through `DefaultLockingTaskExecutor`, miss returns `undefined` without calling the task, and unlock stays in the executor `finally`. `@tslock/core` has no `node-cron` / `bree` / AWS imports; keep-alive’s existing `Scheduler` (setInterval) is unrelated. Docs, AGENTS, README matrix, and the changeset are in place. Remaining notes are nits and small coverage gaps, not correctness blockers.

## Checklist

| Area | Status |
|---|---|
| Spec / plan / architecture alignment | Pass — public API shapes, dependency graph, and non-goals match; core stays free of host schedulers |
| API and NestJS skip-semantics consistency | Pass — same `wasExecuted ? getResult() : undefined` pattern as `runWithSchedulerLock` |
| Core stays scheduler-free | Pass — no new scheduler deps or imports in `@tslock/core` |
| Packaging (separate packages vs mega adapters) | Pass — four packages with peers/deps per matrix; no `@tslock/adapters` mega-package |
| Error / unlock / concurrency edge cases | Pass — wrap unlock-on-throw; RunCoordinator map delete in `finally`; contention skip covered |
| Tests quality | Pass with nits — required acquire/skip/unlock/coordinator cases present; a few matrix edges untested |
| Docs / changeset / README | Pass — package READMEs, root Scheduler adapters table, AGENTS note, minor changeset |
| Dual format / engines / peers conventions | Pass — tsup ESM+CJS, `engines.node >= 22`, version `2.0.1`, workspace deps, host peers as specified |

## Findings

| Severity | Finding | Evidence | Recommendation |
|---|---|---|---|
| nit | `@tslock/bree` exposes `run` on `BreeLock`, which is not in the spec’s published `BreeLock` surface (spec lists `wrap` only). Behavior is the shared lifecycle `run` and is harmless. | `packages/bree/src/bree-lock.ts` | Keep as a convenience or drop in a later polish if the public surface must match the spec literally. No change required for this slice. |
| nit | Spec asks to preserve `null` as well as `0` / `false`. Unit tests cover `0` and `false` only. | `packages/scheduler-core/__tests__/scheduler-lock.unit.test.ts`; `docs/specs/29-scheduler-adapters.md` (behavior / tests) | Add one assertion that a wrapped task returning `null` resolves to `null` (not treated as skip). |
| nit | Plan risk called out map cleanup when `onComplete` unlock throws. Implementation uses `try` / `finally` + `delete`, but there is no failing-unlock test. | `packages/node-cron/src/node-cron-lock.ts` (`onComplete`); `packages/node-cron/__tests__/node-cron-lock.unit.test.ts` | Add a unit test where `unlock` rejects and assert the map entry is removed and the error still propagates. |
| nit | Listener path covers acquire (`onLockAttempt` → finished) but not `onLockNotAcquired` on skip. | `packages/scheduler-core/__tests__/scheduler-lock.unit.test.ts` | Optional: assert miss fires `onLockNotAcquired` and does not call `onTaskStarted`. |
| nit | Combining `wrap` / `schedule` with `createRunCoordinator` + `distributed: true` on the same job would double-lock; READMEs present the paths separately but do not warn. | `packages/node-cron/README.md` | Optional one-line note: use either the wrap path or the RunCoordinator path per job, not both. |

No blocker or major findings. Skip semantics, unlock ownership, packaging, and core isolation match the spec.

## Verification status

Inspected:

- `docs/specs/29-scheduler-adapters.md`, `docs/plans/29-scheduler-adapters.md`
- Skim of `docs/01-architecture.md` (framework/scheduler constraints; keep-alive `Scheduler` vs host adapters)
- `docs/specs/28-nestjs.md` and `packages/nestjs/src/scheduler-lock.ts` (skip / unlock reference)
- Sources and `__tests__/` under `packages/scheduler-core`, `packages/node-cron`, `packages/bree`, `packages/aws-lambda`
- Root `README.md` Scheduler adapters section, `AGENTS.md` Framework integrations row, `.changeset/scheduler-adapters.md`
- Confirmed `@tslock/core` has no `node-cron` / `bree` / `aws-lambda` / `scheduler-core` imports

Ran locally (not full repo CI):

- `pnpm --filter @tslock/scheduler-core --filter @tslock/node-cron --filter @tslock/bree --filter @tslock/aws-lambda test` — 18 tests passed
- Same filter set: `typecheck` and `build` — succeeded

Did not run `pnpm check`, `pnpm -r test`, `pnpm -r typecheck`, or `pnpm -r build` for this review.
