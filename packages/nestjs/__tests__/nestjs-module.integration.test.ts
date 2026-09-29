import 'reflect-metadata';
import { Injectable, Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { Test, type TestingModule } from '@nestjs/testing';
import { DefaultLockingTaskExecutor, LockException, type LockProvider } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedulerLock } from '../src/scheduler-lock.js';
import { SchedulerLockInterceptor } from '../src/scheduler-lock-interceptor.js';
import { TSLOCK_LOCK_PROVIDER, TSLOCK_LOCKING_TASK_EXECUTOR } from '../src/tokens.js';
import { TslockModule } from '../src/tslock-module.js';

const TEST_LOCK_PROVIDER = Symbol('TEST_LOCK_PROVIDER');

describe('TslockModule', () => {
  let moduleRef: TestingModule | undefined;

  afterEach(async () => {
    if (moduleRef) await moduleRef.close();
    moduleRef = undefined;
  });

  it('registers the provider and executor and runs a decorated method', async () => {
    const lockProvider = new InMemoryLockProvider();

    @Injectable()
    class Jobs {
      @SchedulerLock({ name: 'nest-job', lockAtMostFor: '5s' })
      async run(): Promise<string> {
        return 'done';
      }
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        TslockModule.forRoot({
          lockProvider,
          defaultLockAtMostFor: '1m',
        }),
      ],
      providers: [Jobs],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(TSLOCK_LOCK_PROVIDER)).toBe(lockProvider);
    expect(moduleRef.get(TSLOCK_LOCKING_TASK_EXECUTOR)).toBeInstanceOf(DefaultLockingTaskExecutor);
    await expect(moduleRef.get(Jobs).run()).resolves.toBe('done');
  });

  it('skips an overlapping decorated call from a Nest provider', async () => {
    @Injectable()
    class Jobs {
      started = 0;
      gate: Promise<void> = Promise.resolve();

      @SchedulerLock({ name: 'nest-overlap', lockAtMostFor: '10s' })
      async run(): Promise<string> {
        this.started += 1;
        await this.gate;
        return 'done';
      }
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        TslockModule.forRoot({
          lockProvider: new InMemoryLockProvider(),
          defaultLockAtMostFor: '1m',
        }),
      ],
      providers: [Jobs],
    }).compile();
    await moduleRef.init();

    const jobs = moduleRef.get(Jobs);
    let release: (() => void) | undefined;
    jobs.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = jobs.run();
    await vi.waitFor(() => expect(jobs.started).toBe(1));
    await expect(jobs.run()).resolves.toBeUndefined();
    expect(jobs.started).toBe(1);
    release?.();
    await expect(first).resolves.toBe('done');
  });

  it('resolves forRootAsync from an imported module', async () => {
    const lockProvider = new InMemoryLockProvider();

    @Module({
      providers: [{ provide: TEST_LOCK_PROVIDER, useValue: lockProvider }],
      exports: [TEST_LOCK_PROVIDER],
    })
    class LockSourceModule {}

    @Injectable()
    class Jobs {
      @SchedulerLock({ name: 'async-job' })
      async run(): Promise<string> {
        return 'async';
      }
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        TslockModule.forRootAsync({
          imports: [LockSourceModule],
          inject: [TEST_LOCK_PROVIDER],
          useFactory: (provider: unknown) => ({
            lockProvider: provider as LockProvider,
            defaultLockAtMostFor: '15s',
            defaultLockAtLeastFor: '1s',
          }),
        }),
      ],
      providers: [Jobs],
    }).compile();
    await moduleRef.init();

    expect(moduleRef.get(TSLOCK_LOCK_PROVIDER)).toBe(lockProvider);
    await expect(moduleRef.get(Jobs).run()).resolves.toBe('async');
  });

  it('registers the interceptor globally when asked', async () => {
    const dynamicModule = TslockModule.forRoot({
      lockProvider: new InMemoryLockProvider(),
      defaultLockAtMostFor: '30s',
      registerInterceptor: true,
    });
    const registration = dynamicModule.providers?.find(
      (provider) =>
        typeof provider === 'object' &&
        provider !== null &&
        'provide' in provider &&
        provider.provide === APP_INTERCEPTOR,
    );

    expect(registration).toMatchObject({
      provide: APP_INTERCEPTOR,
      useExisting: SchedulerLockInterceptor,
    });

    moduleRef = await Test.createTestingModule({
      imports: [dynamicModule],
    }).compile();

    expect(moduleRef.get(SchedulerLockInterceptor)).toBeInstanceOf(SchedulerLockInterceptor);
  });

  it('unbinds the runtime when the module is closed', async () => {
    @Injectable()
    class Jobs {
      @SchedulerLock({ name: 'closed', lockAtMostFor: '1s' })
      async run(): Promise<string> {
        return 'done';
      }
    }

    moduleRef = await Test.createTestingModule({
      imports: [
        TslockModule.forRoot({
          lockProvider: new InMemoryLockProvider(),
          defaultLockAtMostFor: '1m',
        }),
      ],
      providers: [Jobs],
    }).compile();
    await moduleRef.init();
    const jobs = moduleRef.get(Jobs);
    await expect(jobs.run()).resolves.toBe('done');
    await moduleRef.close();
    moduleRef = undefined;
    await expect(jobs.run()).rejects.toBeInstanceOf(LockException);
  });
});
