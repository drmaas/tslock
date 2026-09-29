import 'reflect-metadata';
import {
  type DynamicModule,
  type InjectionToken,
  Module,
  type ModuleMetadata,
  type OnModuleDestroy,
  type OptionalFactoryDependency,
  type Provider,
} from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import {
  DefaultLockingTaskExecutor,
  type DurationInput,
  LockException,
  type LockingTaskExecutor,
  type LockingTaskExecutorListener,
  type LockProvider,
  parseDuration,
} from '@tslock/core';
import { SchedulerLockInterceptor } from './scheduler-lock-interceptor.js';
import {
  bindSchedulerLockRuntime,
  type SchedulerLockRuntime,
  unbindSchedulerLockRuntime,
} from './scheduler-lock-runtime.js';
import {
  TSLOCK_LOCK_PROVIDER,
  TSLOCK_LOCKING_TASK_EXECUTOR,
  TSLOCK_MODULE_OPTIONS,
  TSLOCK_SCHEDULER_LOCK_RUNTIME,
} from './tokens.js';

const TSLOCK_SCHEDULER_LOCK_RUNTIME_HOST = Symbol.for('tslock.nestjs.SCHEDULER_LOCK_RUNTIME_HOST');

export interface TslockModuleOptions {
  lockProvider: LockProvider;
  defaultLockAtMostFor: DurationInput;
  defaultLockAtLeastFor?: DurationInput;
  listener?: LockingTaskExecutorListener;
  isGlobal?: boolean;
  registerInterceptor?: boolean;
}

export interface ResolvedTslockModuleOptions {
  readonly lockProvider: LockProvider;
  readonly listener?: LockingTaskExecutorListener;
  readonly defaultLockAtMostFor: number;
  readonly defaultLockAtLeastFor: number;
}

export interface TslockModuleAsyncOptions {
  imports?: ModuleMetadata['imports'];
  useFactory: (...args: unknown[]) => TslockModuleOptions | Promise<TslockModuleOptions>;
  inject?: Array<InjectionToken | OptionalFactoryDependency>;
  isGlobal?: boolean;
  registerInterceptor?: boolean;
}

export class TslockModule {
  static forRoot(options: TslockModuleOptions): DynamicModule {
    return createTslockDynamicModule({
      isGlobal: options.isGlobal ?? true,
      registerInterceptor: options.registerInterceptor ?? false,
      optionsProvider: {
        provide: TSLOCK_MODULE_OPTIONS,
        useValue: resolveTslockModuleOptions(options),
      },
    });
  }

  static forRootAsync(options: TslockModuleAsyncOptions): DynamicModule {
    return createTslockDynamicModule({
      isGlobal: options.isGlobal ?? true,
      registerInterceptor: options.registerInterceptor ?? false,
      imports: options.imports,
      optionsProvider: {
        provide: TSLOCK_MODULE_OPTIONS,
        useFactory: async (...args: unknown[]) => resolveTslockModuleOptions(await options.useFactory(...args)),
        inject: options.inject ?? [],
      },
    });
  }
}

Module({})(TslockModule);

export function resolveTslockModuleOptions(input: TslockModuleOptions): ResolvedTslockModuleOptions {
  if (input === null || typeof input !== 'object' || typeof input.lockProvider?.lock !== 'function') {
    throw new LockException('TslockModule lockProvider is required');
  }
  if (input.defaultLockAtMostFor === undefined) {
    throw new LockException('TslockModule defaultLockAtMostFor is required');
  }
  const defaultLockAtMostFor = parseDuration(input.defaultLockAtMostFor);
  const defaultLockAtLeastFor = parseDuration(input.defaultLockAtLeastFor ?? 0);
  if (defaultLockAtLeastFor > defaultLockAtMostFor) {
    throw new LockException('defaultLockAtLeastFor must be <= defaultLockAtMostFor');
  }
  return {
    lockProvider: input.lockProvider,
    listener: input.listener,
    defaultLockAtMostFor,
    defaultLockAtLeastFor,
  };
}

function createTslockDynamicModule(input: {
  isGlobal: boolean;
  registerInterceptor: boolean;
  optionsProvider: Provider;
  imports?: ModuleMetadata['imports'];
}): DynamicModule {
  const providers: Provider[] = [
    input.optionsProvider,
    {
      provide: TSLOCK_LOCK_PROVIDER,
      useFactory: (options: ResolvedTslockModuleOptions) => options.lockProvider,
      inject: [TSLOCK_MODULE_OPTIONS],
    },
    {
      provide: TSLOCK_LOCKING_TASK_EXECUTOR,
      useFactory: (options: ResolvedTslockModuleOptions) =>
        new DefaultLockingTaskExecutor(options.lockProvider, options.listener),
      inject: [TSLOCK_MODULE_OPTIONS],
    },
    {
      provide: TSLOCK_SCHEDULER_LOCK_RUNTIME,
      useFactory: (executor: LockingTaskExecutor, options: ResolvedTslockModuleOptions) => {
        const runtime: SchedulerLockRuntime = {
          executor,
          defaultLockAtMostFor: options.defaultLockAtMostFor,
          defaultLockAtLeastFor: options.defaultLockAtLeastFor,
        };
        bindSchedulerLockRuntime(runtime);
        return runtime;
      },
      inject: [TSLOCK_LOCKING_TASK_EXECUTOR, TSLOCK_MODULE_OPTIONS],
    },
    {
      provide: TSLOCK_SCHEDULER_LOCK_RUNTIME_HOST,
      useFactory: (runtime: SchedulerLockRuntime): OnModuleDestroy => ({
        onModuleDestroy() {
          unbindSchedulerLockRuntime(runtime);
        },
      }),
      inject: [TSLOCK_SCHEDULER_LOCK_RUNTIME],
    },
    SchedulerLockInterceptor,
  ];
  if (input.registerInterceptor) {
    providers.push({
      provide: APP_INTERCEPTOR,
      useExisting: SchedulerLockInterceptor,
    });
  }
  return {
    module: TslockModule,
    global: input.isGlobal,
    imports: input.imports,
    providers,
    exports: [TSLOCK_LOCK_PROVIDER, TSLOCK_LOCKING_TASK_EXECUTOR, SchedulerLockInterceptor],
  };
}
