# Review: Lock health / admin snapshot

## Scope

Independent review of issue #44 on branch `cursor/lock-health-snapshot-06be` against:

- `docs/specs/29-lock-health-snapshot.md`
- `docs/plans/29-lock-health-snapshot.md`
- `docs/01-architecture.md` (TrackingLockProviderWrapper / health note)
- `packages/core/src/tracking-lock-provider.ts`
- `packages/core/src/lock-health.ts`
- `packages/core/src/index.ts`
- `packages/core/__tests__/lock-health.test.ts`
- `packages/core/__tests__/tracking-lock-provider.test.ts`
- `packages/core/README.md` (health section)
- `.changeset/lock-health-snapshot.md`
- Brief glance at `@tslock/otel` for complementarity

Spec and plan were not edited. No production code changes were made during this review.

## Outcome

**Pass.**

Additive, read-only API in `@tslock/core` matches the spec and issue acceptance criteria. No blockers or correctness defects found. One major test-coverage gap and several minor polish items should be addressed by the implementer as follow-ups (preferably before merge for the KeepAlive composition test).

## Findings

### 1. Major — KeepAlive → Tracking → overdue path untested

**Evidence:** Plan review risks (`docs/plans/29-lock-health-snapshot.md`) explicitly call out that renewals only refresh `updatedAt` when `KeepAliveLockProvider(tracking)` wraps tracking, and that `overdueLocks` false-positives if extend does not refresh. Tracking unit tests cover direct `wrapped.extend(...)` (`packages/core/__tests__/tracking-lock-provider.test.ts`). Monitor tests cover overdue via clock advance after acquire (`packages/core/__tests__/lock-health.test.ts`). Neither exercises KeepAlive calling through a tracked lock so that a successful keep-alive renew clears / prevents overdue, nor asserts that inverted wrap order fails to refresh metadata.

**Why it matters:** `overdueLocks` is the headline “stuck keep-alive / wrong lease” signal for #44. Direct extend coverage is necessary but not sufficient for the documented operator wiring.

**Suggested fix:** Add a focused unit test: `TrackingLockProviderWrapper` under `KeepAliveLockProvider` with a controllable scheduler (or injectable interval), advance time past `lockAtMostFor` without renewal → overdue; run one successful renew → `updatedAt` refreshed and not overdue. Optionally document/assert the inverted wrap pitfall in a short comment-free test name.

### 2. Minor — Architecture sketch only partially updated

**Evidence:** `docs/01-architecture.md` §4.3 adds `getActiveLockRecords()` and a prose pointer to the health monitor, but the TypeScript sketch still constructs `TrackingSimpleLock(lock, this.activeLocks)` with no records map / `ActiveLockRecord` shape.

**Suggested fix:** Align the sketch with the implemented constructor and record fields, or drop the outdated constructor line and keep the prose + method signature.

### 3. Minor — OTel composition documented thinly vs spec

**Evidence:** Spec operator examples require documenting: instrument storage before tracking, compose listener to both otel + health, chain both `onKeepAliveFailure` callbacks. Core README (`packages/core/README.md`) states order (“instrument … before tracking”) and “forward … yourself” in one sentence, without a short composition snippet.

**Suggested fix:** Add a compact dual-forward example (listener + keep-alive) next to the existing HTTP sample. No `composeListeners` helper (correctly out of scope).

### 4. Minor — Optional `safeUpdate` failure path untested

**Evidence:** Spec allows optional coverage of swallowed monitor update failures. `safeUpdate` in `packages/core/src/lock-health.ts` matches executor/`@tslock/otel` empty-catch style. Tests only assert no-op listener methods exist.

**Suggested fix:** Nice-to-have; not required for pass.

### 5. Minor — Overdue boundary equality not asserted

**Evidence:** Spec invariant is `takenAt - updatedAt > lockAtMostFor`. Tests use a clearly overdue zebra (`1000 > 500`) and a clearly fresh alpha. Equality (`=== lockAtMostFor`) is unspecified in tests as non-overdue.

**Suggested fix:** One assertion that equal age is not overdue.

### 6. Note — `@tslock/core` placement is appropriate

Zero new dependencies, builds on existing `TrackingLockProviderWrapper` + listener + keep-alive callback, complementary to `@tslock/otel` continuous metrics. A new package would add surface without need. Matches vision “prefer minimal surface.”

### 7. Note — Read-only / unlock-by-default

`LockHealthSnapshot` and `getActiveLockRecords()` are metadata-only (no `SimpleLock`). `getActiveLocks()` remains for compatibility and still returns handles — intentional per spec, not a new admin unlock API. HTTP example returns `JSON.stringify(monitor.snapshot())` only.

### 8. Note — Concurrency / ownership / time

- Extend remove+add of tracking wrappers is synchronous after `await delegate.extend`, so snapshot cannot observe a gap between delete and insert on the single-threaded event loop.
- Failed extend leaves the original wrapper tracked (`tracking-lock-provider.test.ts`).
- `acquiredAt` preserved across extend; `updatedAt` and durations refreshed.
- Keep-alive failure `errorType` uses `error.name` / `"Error"`; messages omitted from stable shape.
- Ring buffer oldest-first trim matches spec.
- Snapshot sorts a copy; live map is not mutated by sort/freeze.

### 9. Note — Complementarity with `@tslock/otel`

`@tslock/otel` exposes counters/histograms via listener + instrumented unlock/extend + `onKeepAliveFailure`. Health adds process-local point-in-time JSON. No duplicated metric instruments in core. Wiring guidance (instrument storage, then track, then keep-alive) mirrors otel’s own order.

### 10. Note — Package / lint conventions

No comments in new production code. Dual ESM+CJS via existing core `tsup`. Exports from `packages/core/src/index.ts` cover types + factory. Minor changeset for `@tslock/core`. Docs updated: core README, root README row, vision readiness, architecture pointer.

## What matches

| Area | Status |
|---|---|
| Spec API shapes (`ActiveLockRecord`, snapshot, monitor, factory) | Match |
| Tracking acquire / unlock / extend metadata | Match |
| Overdue formula, sort-by-name, freeze + JSON | Match |
| Listener no-ops + `onKeepAliveFailure` | Match |
| Factory rejects `maxKeepAliveFailures < 1` | Match |
| README HTTP + CLI examples; keep-alive wraps tracking | Match |
| Non-goals (no unlock API, no new package, no compose helper, no otel instruments) | Honored |
| Issue #44 acceptance (stable shape, tracking extension, health example, tests, changeset) | Met |

## Verification status

Revieweder ran (this environment):

- `pnpm --filter @tslock/core typecheck` — pass
- `pnpm --filter @tslock/core test` — pass (12 files, 87 tests)
- `pnpm --filter @tslock/core build` — pass (existing package.json `types`-condition tsup warning unchanged)
- `pnpm check` — pass (Biome, 396 files)

Full monorepo `pnpm -r typecheck|test|build` was specified in the plan for the implementer; not re-run exhaustively here. Core-only additive change; no provider/integration surface.

## Decision

**Pass.** Ship-ready for the specified behavior. Prefer landing finding #1 (KeepAlive composition unit test) before or immediately after merge; findings #2–#5 are polish.
