# Spec: Lock health / admin snapshot

## Problem

`TrackingLockProviderWrapper` can list currently held lock handles, but operators have no ready-made, documented, JSON-serializable snapshot for ops when `lockAtMostFor` is wrong or a node wedges. Issue #44 asks for a small read-only health surface. Continuous metrics already live in `@tslock/otel`; this work is point-in-time introspection complementary to those series, not a duplicate.

## Goals

- Expose a stable, documented, read-only `LockHealthSnapshot` shape from `@tslock/core`.
- Extend `TrackingLockProviderWrapper` so active locks carry enough metadata for a useful snapshot (name, lease durations, acquire and last-update times) without exposing unlock.
- Provide a small `LockHealthMonitor` that implements `LockingTaskExecutorListener`, records keep-alive failures, and builds snapshots from the tracking wrapper.
- Document an HTTP `/health`-style wiring example and a CLI dump example in the core README. No framework dependency and no new package.
- Tests + changeset.

## Non-goals

- Admin unlock, force-release, or any write API that encourages breaking lock semantics.
- A new `@tslock/*` package, HTTP server, Prometheus scrape endpoint, or OpenTelemetry instruments (those stay in `@tslock/otel`).
- Cluster-wide or cross-process lock discovery. The snapshot is process-local, matching `TrackingLockProviderWrapper`.
- Changing acquire, skip, unlock, extend, or keep-alive behavior beyond recording metadata on the tracking wrapper.
- A general `composeListeners` helper (callers compose `LockHealthMonitor` with `@tslock/otel` or other listeners themselves).

## Architecture fit

| Item | Choice |
|---|---|
| Package | `@tslock/core` |
| Related type | Extends `TrackingLockProviderWrapper`; uses `LockingTaskExecutorListener` and `KeepAliveLockProvider`'s failure callback |
| Complementary package | `@tslock/otel` for continuous metrics |
| Provider category | N/A (core wrapper / ops helper) |
| Compatibility | Additive. Existing `getActiveLocks()` remains. New APIs are additive exports. |

## Public API

### Active lock record (tracking)

```typescript
interface ActiveLockRecord {
  readonly name: string;
  readonly lockAtMostFor: number;
  readonly lockAtLeastFor: number;
  readonly acquiredAt: number; // epoch millis when this process first held the lock
  readonly updatedAt: number;  // epoch millis of acquire or last successful extend
}
```

### TrackingLockProviderWrapper extensions

```typescript
class TrackingLockProviderWrapper implements LockProvider {
  constructor(delegate: LockProvider);
  lock(config: LockConfiguration): Promise<SimpleLock | undefined>;
  getActiveLocks(): ReadonlySet<SimpleLock>;
  getActiveLockRecords(): readonly ActiveLockRecord[];
}
```

Behavior:

- On successful `lock`, store an `ActiveLockRecord` with `acquiredAt = updatedAt = ClockProvider.now()`, using the lock configuration's name and durations. Add a tracking wrapper to the active set as today.
- On successful `extend` of a tracked lock, remove the old wrapper, add a new wrapper, keep the original `acquiredAt`, and set `updatedAt` to `ClockProvider.now()` with the requested `lockAtMostFor` / `lockAtLeastFor`.
- On `unlock`, remove the wrapper and its record.
- Double unlock remains a no-op on the tracking wrapper and does not throw (existing behavior).
- `getActiveLockRecords()` returns a shallow copy of current records. Records are plain frozen objects. The snapshot API must not return `SimpleLock` handles.
- `getActiveLocks()` stays for callers that already use the set of handles.

### Lock health events

```typescript
interface LockHealthEvent {
  readonly name: string;
  readonly at: number;
  readonly lockAtMostFor: number;
  readonly lockAtLeastFor: number;
}

interface KeepAliveFailureRecord extends LockHealthEvent {
  readonly errorType: string;
}
```

`errorType` uses `error.name` when `error` is an `Error` with a non-empty name; otherwise `"Error"`. Error messages are not part of the stable snapshot shape.

### Snapshot

```typescript
interface LockHealthSnapshot {
  readonly takenAt: number;
  readonly activeLocks: readonly ActiveLockRecord[];
  readonly lastAcquired: LockHealthEvent | undefined;
  readonly lastSkipped: LockHealthEvent | undefined;
  readonly recentKeepAliveFailures: readonly KeepAliveFailureRecord[];
  readonly overdueLocks: readonly ActiveLockRecord[];
}
```

Invariants:

- `takenAt` is `ClockProvider.now()` when `snapshot()` runs.
- `activeLocks` is the current `getActiveLockRecords()` result, sorted by `name` ascending (stable, deterministic for dumps).
- `lastAcquired` / `lastSkipped` are the most recent corresponding listener events, or `undefined` if none since construction.
- `recentKeepAliveFailures` is a ring buffer of the most recent failures (oldest first), default capacity 16, configurable.
- `overdueLocks` is the subset of `activeLocks` where `takenAt - updatedAt > lockAtMostFor`. That detects a wedged holder or a lease that should have expired or been renewed. Keep-alive that renews on schedule keeps `updatedAt` fresh and is not overdue.
- The object and nested arrays/records are frozen. The shape is JSON-serializable (`JSON.stringify` safe).

### LockHealthMonitor

```typescript
interface LockHealthMonitorOptions {
  readonly tracking: TrackingLockProviderWrapper;
  readonly maxKeepAliveFailures?: number; // default 16, must be >= 1
}

interface LockHealthMonitor extends LockingTaskExecutorListener {
  onKeepAliveFailure(config: LockConfiguration, error: unknown): void;
  snapshot(): LockHealthSnapshot;
  formatSnapshot(snapshot?: LockHealthSnapshot): string;
}

function createLockHealthMonitor(options: LockHealthMonitorOptions): LockHealthMonitor;
```

Behavior:

- `tracking` is required.
- `maxKeepAliveFailures` defaults to 16. Values less than 1 throw `LockException`.
- Listener methods:
  - `onLockAcquired` stores `lastAcquired`.
  - `onLockNotAcquired` stores `lastSkipped`.
  - `onLockAttempt`, `onTaskStarted`, `onTaskFinished`, and `onUnlockError` are no-ops (present so the object is a full listener).
- `onKeepAliveFailure` appends a `KeepAliveFailureRecord` using `ClockProvider.now()` and `errorType`. Trims to capacity.
- Listener and keep-alive recording failures must not throw into the executor: wrap internal updates so a programming error in the monitor does not fail the task path. Prefer a simple try/catch around state updates (same spirit as the executor's `safeEmit`).
- `snapshot()` builds the frozen snapshot described above.
- `formatSnapshot()` returns a multi-line text dump suitable for CLI or a plain-text health response. When `snapshot` is omitted, it calls `snapshot()` first. Format is documented in the README; exact whitespace is not a public contract beyond being stable enough for humans (tests assert key fields appear).

Returned monitor methods do not depend on `this` binding (arrow methods or bound functions). The returned object may be frozen.

## Operator examples (documentation only)

Core README documents:

1. **HTTP health** — Node `http.createServer` (or Express one-liner) that returns `JSON.stringify(monitor.snapshot())` on `GET /health/locks` with status 200. Read-only.
2. **CLI dump** — `console.log(monitor.formatSnapshot())` for an operator script.

Wiring order with keep-alive and optional otel:

```typescript
const tracking = new TrackingLockProviderWrapper(storage);
const health = createLockHealthMonitor({ tracking });
const provider = new KeepAliveLockProvider(tracking, undefined, health.onKeepAliveFailure);
const executor = new DefaultLockingTaskExecutor(provider, health);
```

When also using `@tslock/otel`, instrument the storage provider before tracking, pass a manually composed listener that forwards to both `otel.listener` and `health`, and chain `onKeepAliveFailure` to both. Document this composition; do not add a compose helper in this change.

## Errors

| Condition | Behavior |
|---|---|
| `maxKeepAliveFailures < 1` | Throw `LockException` at factory time |
| Missing `tracking` | TypeScript-required; no runtime default |
| Monitor internal update throws | Swallowed; task / keep-alive path continues |
| Lock not acquired | Unchanged (`undefined` / skip); monitor records via listener only when the executor emits |

## Compatibility

- Additive public exports from `@tslock/core`.
- Existing `TrackingLockProviderWrapper` / `getActiveLocks` behavior preserved.
- No change to `@tslock/otel` APIs.
- Snapshot field names and nesting are stable for this package version once shipped.

## Tests

Unit tests in `packages/core/__tests__/`:

- Tracking: acquire records metadata; unlock removes record; extend preserves `acquiredAt`, updates `updatedAt` and durations; double unlock safe.
- Monitor: last acquired / last skipped; ring buffer capacity and order; overdue when `updatedAt` is stale relative to `lockAtMostFor`; keep-alive failure records `errorType`; `snapshot()` is frozen and `JSON.stringify`-able; `formatSnapshot` includes active lock names.
- Monitor listener methods do not throw into the caller when state update is forced to fail (optional if awkward; at least verify no-op listener methods exist).
- Factory rejects `maxKeepAliveFailures: 0`.

No container tests.

## Documentation

- `packages/core/README.md` — health snapshot section with HTTP and CLI examples, stable shape table, otel complementarity note.
- Root `README.md` — mention under core features if a natural row exists.
- `docs/00-vision.md` / `docs/01-architecture.md` — short pointer that core exposes a read-only lock health snapshot (optional one-line; do not rewrite history).
- Changeset for `@tslock/core` (minor).

## Assumptions

- Process-local introspection is sufficient for the issue; storage-side admin browsing is out of scope.
- Putting the API in core (not a new package) matches “prefer minimal surface” and zero new dependencies.
- `overdueLocks` based on `updatedAt` + `lockAtMostFor` is the feasible “stuck keep-alive / wrong lease” signal without requiring keep-alive to expose internal timer state.
- Error messages are omitted from the snapshot for a stable, low-cardinality ops shape.
