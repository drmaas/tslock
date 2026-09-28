# @tslock/nestjs

> NestJS module and `@SchedulerLock` decorator for TSLock.

`TslockModule` registers a `LockProvider` and `LockingTaskExecutor`. `@SchedulerLock` wraps a method with `executeWithLock`, which is the same shape ShedLock uses for scheduled tasks. `@tslock/core` stays free of Nest imports.

## Installation

```bash
pnpm add @tslock/core @tslock/nestjs @tslock/in-memory @nestjs/common @nestjs/core @nestjs/schedule
```

Use any TSLock provider in place of `@tslock/in-memory`. `@nestjs/schedule` is only required when you schedule with `@Cron`, `@Interval`, or `@Timeout`.

## Scheduled task

```typescript
import { Injectable, Module } from '@nestjs/common';
import { Cron, CronExpression, ScheduleModule } from '@nestjs/schedule';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { SchedulerLock, TslockModule } from '@tslock/nestjs';

@Injectable()
export class ReportTask {
  @Cron(CronExpression.EVERY_MINUTE)
  @SchedulerLock({ name: 'report-task', lockAtMostFor: '50s', lockAtLeastFor: '10s' })
  async createReport(): Promise<void> {
    // Runs on one instance. Other instances skip this tick.
  }
}

@Module({
  imports: [
    TslockModule.forRoot({
      lockProvider: new InMemoryLockProvider(),
      defaultLockAtMostFor: '10m',
    }),
    ScheduleModule.forRoot(),
  ],
  providers: [ReportTask],
})
export class AppModule {}
```

Import `TslockModule` before `ScheduleModule` when a job uses `runOnInit`. The decorator resolves the executor when the method runs. If the module has not been constructed yet, the call throws `LockException`.

`lockAtMostFor` and `lockAtLeastFor` accept the same duration values as `parseDuration()` (`'30s'`, `30000`, `{ minutes: 5 }`). Values on `@SchedulerLock` override `defaultLockAtMostFor` and `defaultLockAtLeastFor`. When the lock is already held, the method does not run and the wrapper resolves `undefined`.

Decorated methods are asynchronous at runtime. `LockAssert` and `LockExtender` work inside the method because execution goes through `DefaultLockingTaskExecutor`.

## Async registration

```typescript
import { Module } from '@nestjs/common';
import { TslockModule } from '@tslock/nestjs';
import { DatabaseModule, LOCK_PROVIDER } from './database.module';

@Module({
  imports: [
    TslockModule.forRootAsync({
      imports: [DatabaseModule],
      inject: [LOCK_PROVIDER],
      useFactory: (lockProvider) => ({
        lockProvider,
        defaultLockAtMostFor: '10m',
      }),
    }),
  ],
})
export class AppModule {}
```

Inject the registered objects with `TSLOCK_LOCK_PROVIDER` and `TSLOCK_LOCKING_TASK_EXECUTOR`. The module is global by default. Set `isGlobal: false` to keep those tokens in the importing module. The decorator uses the latest runtime bound in the process; closing the Nest module unbinds it.

Pass `listener` to receive `LockingTaskExecutorListener` events.

## Interceptor

`@SchedulerLock` already locks direct calls, including scheduler calls. `SchedulerLockInterceptor` locks a controller or RPC handler that carries the same metadata but was not wrapped by the decorator. A wrapped handler is left to the decorator so the lock is acquired once.

```typescript
import { Controller, Post, UseInterceptors } from '@nestjs/common';
import { SchedulerLock, SchedulerLockInterceptor } from '@tslock/nestjs';

@Controller('reports')
@UseInterceptors(SchedulerLockInterceptor)
export class ReportsController {
  @Post()
  @SchedulerLock({ name: 'create-report', lockAtMostFor: '1m' })
  async create(): Promise<{ ok: true }> {
    return { ok: true };
  }
}
```

`registerInterceptor: true` on `forRoot` / `forRootAsync` registers that interceptor as `APP_INTERCEPTOR`.

## Requirements

- Node.js >= 22
- Peers: `@nestjs/common` and `@nestjs/core` 10 or 11, `rxjs` 7

## License

Apache 2.0 — see [LICENSE](../../LICENSE) for details.
