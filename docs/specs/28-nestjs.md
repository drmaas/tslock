# Spec: NestJS Module and SchedulerLock

## Overview

This spec defines `@tslock/nestjs`, a NestJS integration that registers a `LockProvider` and `LockingTaskExecutor` and runs methods under `executeWithLock`. The package is the ShedLock-style decorator/interceptor for Nest scheduled tasks. `@tslock/core` stays framework-agnostic and does not depend on Nest.

`docs/00-vision.md` deferred Nest and decorator APIs while core stabilized. HTTP middleware has since shipped in `@tslock/middleware-core` and the Express, Fastify, Koa, and Hono adapters. This spec covers Nest only. It does not change those HTTP adapters or core lock semantics.

**Status:** Accepted for implementation from issue #42.

## Problem

ShedLock users moving to NestJS have HTTP middleware for Express, Fastify, Koa, and Hono, but no first-party Nest module. Scheduled handlers (`@Cron`, `@Interval`, `@Timeout` from `@nestjs/schedule`, or any directly invoked method) need a decorator that acquires a distributed lock around the method body. Controller and RPC handlers need the same behavior through Nest's interceptor pipeline.

## Goals

- Publish `@tslock/nestjs` with `TslockModule.forRoot` and `TslockModule.forRootAsync`.
- Register the caller-supplied `LockProvider` and a `DefaultLockingTaskExecutor` for injection.
- Provide `@SchedulerLock` that wraps a method with `executeWithLock`.
- Provide `SchedulerLockInterceptor` for handlers that carry scheduler-lock metadata but are not already wrapped.
- Skip the method when the lock is not acquired. Propagate storage and task errors.
- Ship unit tests, Nest DI integration tests, a package README with a Nest schedule example, a root package-matrix entry, and a changeset.

## Non-goals

- Importing Nest, `reflect-metadata`, or `rxjs` from `@tslock/core` or any provider package.
- A cron parser, a replacement for `@nestjs/schedule`, or a built-in scheduler.
- HTTP lock-failure responses (status, `Retry-After`, locked body). Those stay in the middleware packages.
- OpenTelemetry or other metrics exporters. Callers can still pass a `LockingTaskExecutorListener`.
- Changing `LockProvider`, `LockConfiguration`, or `DefaultLockingTaskExecutor` behavior.
- Supporting multiple Nest applications in one process as independent lock runtimes. The decorator resolves the most recently bound module runtime.

## Architecture

```
@tslock/core
   └── @tslock/nestjs
         peers: @nestjs/common, @nestjs/core, rxjs
```

`@tslock/nestjs` is a framework integration, not a storage provider. It does not implement `LockProvider`. Lock acquire, skip, unlock, extend, and expiry stay inside `DefaultLockingTaskExecutor` and the injected `LockProvider`.

The decorator replaces the method at class-definition time. `@nestjs/schedule` binds whatever function is on the instance when it explores providers, so the wrapper is already in place regardless of `onModuleInit` order. The wrapper resolves the executor when the method runs, not when the class is decorated.

Nest interceptors do not run for `@Cron` / `@Interval` / `@Timeout`. Those entry points depend on the method wrapper. The interceptor covers controller, microservice, and WebSocket handlers that Nest invokes through `ExecutionContext`.

## Public API

### Module

```typescript
interface TslockModuleOptions {
  lockProvider: LockProvider;
  defaultLockAtMostFor: DurationInput;
  defaultLockAtLeastFor?: DurationInput; // default 0
  listener?: LockingTaskExecutorListener;
  isGlobal?: boolean; // default true
  registerInterceptor?: boolean; // default false
}

interface TslockModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  useFactory: (...args: unknown[]) => TslockModuleOptions | Promise<TslockModuleOptions>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  isGlobal?: boolean; // default true
  registerInterceptor?: boolean; // default false
}

class TslockModule {
  static forRoot(options: TslockModuleOptions): DynamicModule;
  static forRootAsync(options: TslockModuleAsyncOptions): DynamicModule;
}
```

`forRoot` validates options when it is called. `forRootAsync` validates when the factory resolves. Validation uses `parseDuration` and the same least/most relationship as `createLockConfig`.

Invalid options throw `LockException`:

- `lockProvider.lock` is missing.
- `defaultLockAtMostFor` is missing or not a valid duration.
- `defaultLockAtLeastFor` is not a valid duration.
- `defaultLockAtLeastFor` is greater than `defaultLockAtMostFor`.

The dynamic module provides and exports:

| Token | Value |
|---|---|
| `TSLOCK_LOCK_PROVIDER` | The configured `LockProvider` |
| `TSLOCK_LOCKING_TASK_EXECUTOR` | `new DefaultLockingTaskExecutor(lockProvider, listener)` |

`SchedulerLockInterceptor` is also registered and exported. When `registerInterceptor` is true, the module additionally registers that interceptor as `APP_INTERCEPTOR`.

`isGlobal` defaults to true so feature modules can inject the executor without importing `TslockModule` again. The decorator does not use Nest injection. It reads a runtime bound while the dynamic module's providers are constructed, which is before lifecycle hooks and before timer-based schedulers fire.

On module destroy, the runtime is unbound only if it is still the active runtime. A later `forRoot` is left in place.

### Decorator

```typescript
interface SchedulerLockOptions {
  name: string;
  lockAtMostFor?: DurationInput;
  lockAtLeastFor?: DurationInput;
}

function SchedulerLock(options: SchedulerLockOptions): MethodDecorator;
```

`name` is required. It is checked with `Utils.validateLockName` when the decorator is applied. Durations present on the decorator are parsed at decoration time. Omitted durations fall back to the module defaults when the method runs.

`createLockConfig` runs on each invocation so `createdAt` is the attempt time. A decorator duration that is incompatible with the module default (for example a shorter `lockAtMostFor` than the module `defaultLockAtLeastFor`) throws `LockException` from that attempt.

The wrapper:

1. Resolves the active runtime. If none is bound, throws `LockException`.
2. Calls `executor.executeWithLock`.
3. Returns `TaskResult.getResult()` when `wasExecuted` is true.
4. Returns `undefined` when the lock was not acquired, and does not call the original method.
5. Propagates provider and task errors after the executor's `finally` unlock.
6. Preserves `this` and arguments.

Decorated methods return a `Promise` at runtime, including when the original method was synchronous.

If another decorator stored `reflect-metadata` on the original function before `@SchedulerLock` runs, those keys are copied onto the wrapper. If `@SchedulerLock` runs first, later decorators (including `@Cron`) see the wrapper. Both source orders work:

```typescript
@Cron(CronExpression.EVERY_MINUTE)
@SchedulerLock({ name: 'report', lockAtMostFor: '50s' })
async createReport(): Promise<void> {}
```

### Interceptor

`SchedulerLockInterceptor` implements `NestInterceptor`.

- No `@SchedulerLock` metadata on the handler: delegate to `next.handle()`.
- Handler already wrapped by `@SchedulerLock`: delegate to `next.handle()`. The wrapper performs the single acquire. Listener hooks for that invocation fire once.
- Metadata present on an unwrapped handler: run `next.handle()` inside `executeWithLock`. On success, emit the handler value. When the lock is not acquired, emit `undefined` and do not subscribe to the handler. Errors propagate on the observable.

Metadata is stored on the wrapped function. `SCHEDULER_LOCK_METADATA` is the `reflect-metadata` key. A `WeakMap` is the lookup used when `reflect-metadata` is not loaded.

### Injection tokens

`TSLOCK_LOCK_PROVIDER` and `TSLOCK_LOCKING_TASK_EXECUTOR` are `Symbol.for` tokens exported by the package.

## Behavior

| Situation | Result |
|---|---|
| Lock acquired | Original method runs inside `LockAssert` / `LockExtender` context. Return value is passed through. Lock unlocks afterward. |
| Same lock name already held on this async stack | Executor reenters and runs the method. |
| Lock not acquired | Method does not run. Decorator and interceptor resolve `undefined`. No throw. |
| Provider or task throws | Error propagates. Successful lock is unlocked by the executor. |
| Module not initialized | Decorator throws `LockException`. |
| Module destroyed and it owns the runtime | Later decorated calls throw `LockException` until a module binds a runtime again. |
| `registerInterceptor` with a wrapped handler | Interceptor does not acquire a second lock. |

`lockAtLeastFor` and expiry are entirely the executor and provider's behavior. The Nest package does not unlock early and does not implement its own TTL.

## Package

`packages/nestjs` follows the existing framework-adapter layout: dual ESM/CJS via tsup, `engines.node >= 22`, `Apache-2.0`, public `publishConfig`, and `workspace:*` dependency on `@tslock/core`.

Peer dependencies (required):

- `@nestjs/common` `^10.0.0 || ^11.0.0`
- `@nestjs/core` `^10.0.0 || ^11.0.0`
- `rxjs` `^7.1.0`

`@nestjs/schedule` is not a dependency. The README shows it as the caller's scheduler. `@tslock/core` is a normal dependency, matching `@tslock/express`.

## Tests

Unit tests, without a Nest application:

- Acquired lock runs the method, preserves `this`, and returns the value.
- Lock held by another caller skips the method and returns `undefined`.
- Provider errors and task errors propagate; the lock unlocks after a task error.
- Module defaults fill omitted durations; decorator durations override them.
- Invalid name or duration throws at decoration time.
- Calling a decorated method with no bound runtime throws `LockException`.
- `LockAssert.assertLocked()` succeeds inside the method.
- Metadata remains visible when `@SchedulerLock` is either inside or outside another method decorator.
- Interceptor pass-through for missing metadata and for an already wrapped handler.
- Interceptor executes an unwrapped metadata handler under the lock, skips it when the lock is not acquired, and propagates task errors.

Integration tests use `@nestjs/testing` and `InMemoryLockProvider`:

- `forRoot` resolves `TSLOCK_LOCK_PROVIDER` and `TSLOCK_LOCKING_TASK_EXECUTOR`, and a decorated provider method runs under that module.
- Overlapping calls on the same name execute the method once.
- `forRootAsync` injects a lock provider from an imported module.
- `registerInterceptor: true` exposes the interceptor as `APP_INTERCEPTOR`.
- Closing the testing module unbinds the runtime.

No shared storage-provider contract and no container tests. This package does not talk to a storage engine.

## Documentation

- `packages/nestjs/README.md` with installation, `TslockModule.forRoot`, a `@Cron` + `@SchedulerLock` example, `forRootAsync`, and interceptor registration.
- Root `README.md` package matrix links the new package.
- Changeset describing the new package as a minor addition.
- `AGENTS.md` framework-integration row names `@tslock/nestjs`.

## Assumptions

- One active Nest application per process is the supported decorator runtime. The latest module to construct its providers wins.
- `@nestjs/schedule` invokes the method on the instance, so a prototype wrapper is sufficient. `runOnInit` tasks that call a decorated method before `TslockModule` is constructed can observe a missing runtime; import `TslockModule` before `ScheduleModule` when using `runOnInit`.
- Timer-based cron, interval, and timeout callbacks fire after module construction, so the runtime is bound before those callbacks.
- Returning `undefined` on contention matches ShedLock's "skip the task" behavior more closely than throwing or returning `TaskResult`.
- Nest 10 and Nest 11 are both in the peer range. Development tests install Nest 11.
