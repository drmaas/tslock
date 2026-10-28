# Spec: Scheduler Adapters (node-cron, bree, AWS Lambda)

## Overview

This spec defines first-party thin scheduler adapters so callers do not copy-paste `DefaultLockingTaskExecutor` / `executeWithLock` glue around cron callbacks. `@tslock/core` stays scheduler-free: no cron parser, no built-in timer, no dependency on `node-cron`, `bree`, or AWS Lambda.

The adapters follow the same lock wrap / skip semantics as `@tslock/nestjs` (`@SchedulerLock`): acquire via `DefaultLockingTaskExecutor`, run the task when the lock is held, return `undefined` and skip the task when the lock is not acquired, propagate storage and task errors, unlock in the executor `finally`.

**Status:** Accepted for implementation from issue #43.

## Problem

README and vision tell users to pair TSLock with `node-cron`, `bree`, Agenda, or EventBridge Scheduler, but only Nest (decorator) and HTTP middleware ship first-party wrappers. Plain Node schedulers still require hand-written `executeWithLock` glue. That glue is easy to get wrong (forgotten unlock, treating lock miss as error, wrong duration defaults).

## Goals

- Publish shared `@tslock/scheduler-core` plus thin packages `@tslock/node-cron`, `@tslock/bree`, and `@tslock/aws-lambda`.
- Each adapter wraps a user callback with `executeWithLock` using the NestJS skip semantics (`undefined` on miss).
- `@tslock/node-cron` also exposes a TSLock-backed `RunCoordinator` for node-cron v4 `distributed: true`.
- Each package has a README example, unit tests for wrap / skip / unlock-on-error, and a changeset.
- Root README lists the new packages under a Scheduler adapters section.
- Core and provider packages remain unchanged in lock semantics.

## Non-goals

- Adding a cron parser, `setInterval` wrapper, or any scheduler into `@tslock/core`.
- Replacing `@nestjs/schedule`, Bree, or EventBridge Scheduler.
- HTTP lock-failure responses (middleware packages).
- Agenda, BullMQ, or other queue adapters in this slice.
- Changing `LockProvider` / `DefaultLockingTaskExecutor` behavior.
- Bundling `node-cron`, `bree`, or the AWS SDK — they are peers or type-only.

## Packaging decision

Match existing integration packages (Express, NestJS, otel): **one package per host library**, plus a shared core when several adapters share non-trivial glue.

| Package | Role | Peers / deps |
|---|---|---|
| `@tslock/scheduler-core` | Shared config resolve + wrap/run lifecycle | `@tslock/core` |
| `@tslock/node-cron` | `createNodeCronLock`, optional `RunCoordinator` | peer `node-cron` ^3 \|\| ^4; dep scheduler-core |
| `@tslock/bree` | `createBreeLock` for Bree job functions | peer `bree` ^9; dep scheduler-core |
| `@tslock/aws-lambda` | `createAwsLambdaLock` for Lambda / EventBridge handlers | dep scheduler-core only (no AWS peer required) |

A single `@tslock/adapters` mega-package with subpath exports was rejected: every other integration is a separate package with its own peer, README, and publish unit; subpaths would force optional peers and weaker discoverability on npm.

## Architecture

```
@tslock/core
   └── @tslock/scheduler-core
         ├── @tslock/node-cron   (peer: node-cron)
         ├── @tslock/bree        (peer: bree)
         └── @tslock/aws-lambda  (types only; no AWS runtime peer)
```

Adapters never call `lockProvider.lock` / `unlock` directly for the wrap path. They always go through `DefaultLockingTaskExecutor` so `LockAssert` and `LockExtender` work inside jobs.

## Public API

### `@tslock/scheduler-core`

```typescript
interface SchedulerLockConfig {
  lockProvider: LockProvider;
  defaultLockAtMostFor: DurationInput; // required
  defaultLockAtLeastFor?: DurationInput; // default 0
  listener?: LockingTaskExecutorListener;
}

interface ResolvedSchedulerLockConfig {
  readonly lockProvider: LockProvider;
  readonly listener?: LockingTaskExecutorListener;
  readonly defaultLockAtMostFor: number;
  readonly defaultLockAtLeastFor: number;
}

interface JobLockOptions {
  name: string;
  lockAtMostFor?: DurationInput;
  lockAtLeastFor?: DurationInput;
}

interface SchedulerLockLifecycle {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrap<TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult | Promise<TResult>,
    job: JobLockOptions,
  ): (...args: TArgs) => Promise<TResult | undefined>;
  run<T>(task: () => Promise<T> | T, job: JobLockOptions): Promise<T | undefined>;
}

function resolveSchedulerLockConfig(input: SchedulerLockConfig): ResolvedSchedulerLockConfig;
function createSchedulerLock(input: SchedulerLockConfig): SchedulerLockLifecycle;
```

`resolveSchedulerLockConfig` / `createSchedulerLock` validate like Nest's `TslockModule`:

- `lockProvider.lock` must be a function.
- `defaultLockAtMostFor` is required and must parse.
- `defaultLockAtLeastFor` defaults to `0` and must be `<= defaultLockAtMostFor`.
- Invalid input throws `LockException`.

`JobLockOptions.name` is required. Present durations are validated when the wrapped function is created (name + parse + least/most when both present). Omitted durations fall back to resolved defaults at invoke time. `createLockConfig` runs on every invoke so `createdAt` is the attempt time.

`wrap` / `run` behavior (NestJS-aligned):

1. `executeWithLock(task, config)`.
2. If `wasExecuted`: return `getResult()` (including `0`, `false`, `null`).
3. If not acquired: return `undefined`; do not call `task`.
4. Provider and task errors propagate; unlock still runs in executor `finally`.

### `@tslock/node-cron`

```typescript
interface NodeCronLock {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrap<TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult | Promise<TResult>,
    job: JobLockOptions,
  ): (...args: TArgs) => Promise<TResult | undefined>;
  schedule(
    cron: typeof import('node-cron'),
    expression: string,
    task: (...args: unknown[]) => unknown,
    job: JobLockOptions & { taskOptions?: Record<string, unknown> },
  ): unknown; // ScheduledTask from node-cron
  createRunCoordinator(options?: {
    lockAtLeastFor?: DurationInput;
    keyPrefix?: string;
  }): import('node-cron').RunCoordinator;
}

function createNodeCronLock(input: SchedulerLockConfig): NodeCronLock;
```

`schedule` is sugar for `cron.schedule(expression, wrap(task, job), taskOptions)`. It does not set `distributed: true` by default; callers who use the wrap path rely on TSLock alone.

`createRunCoordinator` implements node-cron v4's `RunCoordinator`:

- `shouldRun(key, ttlMs)` → `lockProvider.lock(createLockConfig(prefixedKey, ttlMs, lockAtLeastFor))`; store the `SimpleLock`; return `true`/`false`.
- `onComplete(key)` → unlock the stored lock if present; ignore missing entries.
- Storage errors from `shouldRun` propagate (node-cron maps them to skip with `coordinator-error`).
- Unlock errors from `onComplete` propagate to the caller of `onComplete` (node-cron's contract).

`keyPrefix` defaults to `''`. When set, keys become `${keyPrefix}${key}`.

Compatibility: peer `node-cron` `^3.0.0 || ^4.0.0`. `createRunCoordinator` is documented as v4-only; wrap/schedule work on v3 and v4.

### `@tslock/bree`

```typescript
interface BreeLock {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrap<TArgs extends unknown[], TResult>(
    task: (...args: TArgs) => TResult | Promise<TResult>,
    job: JobLockOptions,
  ): (...args: TArgs) => Promise<TResult | undefined>;
}

function createBreeLock(input: SchedulerLockConfig): BreeLock;
```

Bree jobs usually live in worker files. The adapter does not construct a `Bree` instance. Callers wrap the job body (or export a wrapped function) and keep their own `Bree` configuration. `bree` is a peer so users install the version they need; the package does not import bree at runtime for the wrap path (peer is for install/docs contract and optional typing).

### `@tslock/aws-lambda`

```typescript
type AwsLambdaHandler<TEvent = unknown, TResult = unknown> = (
  event: TEvent,
  context: unknown,
  callback?: unknown,
) => TResult | Promise<TResult>;

interface AwsLambdaLock {
  readonly config: ResolvedSchedulerLockConfig;
  readonly executor: LockingTaskExecutor;
  wrapHandler<TEvent = unknown, TResult = unknown>(
    handler: AwsLambdaHandler<TEvent, TResult>,
    job: JobLockOptions,
  ): AwsLambdaHandler<TEvent, TResult | undefined>;
}

function createAwsLambdaLock(input: SchedulerLockConfig): AwsLambdaLock;
```

No AWS SDK peer. Suitable for EventBridge Scheduler → Lambda and other scheduled invocations. On lock miss the wrapped handler resolves `undefined` (Lambda success with empty payload unless the caller adds an `onSkip` later — out of scope).

## Behavior matrix

| Situation | Result |
|---|---|
| Lock acquired | Task runs under `LockAssert` / `LockExtender`. Return value passed through. Unlock afterward. |
| Lock not acquired | Task not called. Wrapper resolves `undefined`. Listener `onLockNotAcquired` may fire. |
| Task throws | Error propagates. Unlock still runs. |
| `lock()` throws | Error propagates. Task not called. |
| Nested same lock name | Executor reentrancy: run without re-acquire. |
| Invalid config / job name | `LockException` at factory or wrap time (or invoke time if default/job duration conflict). |

## Invariants

1. Core stays free of scheduler imports.
2. Wrap path never unlocks outside `DefaultLockingTaskExecutor`.
3. Skip is not an error.
4. Adapters are optional; installing a provider alone never pulls them in.
5. Packages are dual ESM+CJS, `engines.node >= 22`, lockstep version with other `@tslock/*`.

## Test expectations

### `@tslock/scheduler-core`

- Resolves defaults; rejects missing provider / inverted durations.
- `wrap` runs task and returns value when lock acquired.
- `wrap` skips and returns `undefined` when not acquired.
- Unlocks after task throw; propagates provider errors.
- Job durations override defaults; omitted durations use defaults.
- Preserves `0` / `false` return values.

### `@tslock/node-cron`

- `wrap` / `schedule` lock wrap and skip (mocked provider; schedule may mock `cron.schedule`).
- `createRunCoordinator`: acquire → true; miss → false; `onComplete` unlocks; prefix applied.

### `@tslock/bree`

- `wrap` lock wrap and skip with mocked provider (same contract as scheduler-core, adapter factory smoke).

### `@tslock/aws-lambda`

- `wrapHandler` runs handler with event/context when acquired; skips when not; unlocks on throw.

No Docker/integration requirement for this slice; in-memory or mock providers suffice.

## Documentation

- Package READMEs with install + example for each adapter.
- Root README: new "Scheduler adapters" table after Middleware integrations.
- `AGENTS.md`: note scheduler adapters alongside middleware / Nest.
- Changeset minor for the new packages.

## Compatibility

Additive only. No changes to published core APIs. NestJS and HTTP middleware unchanged.

## Assumptions

- Separate packages (not `@tslock/adapters` subpaths) match repo norms.
- NestJS skip semantics (`undefined`) are the user-facing wrap return contract; adapters do not expose raw `TaskResult` unless needed later.
- EventBridge helper ships as `@tslock/aws-lambda` (nice-to-have from the issue).
- Docs NN is `29` (`28` is already used by NestJS and otel).
