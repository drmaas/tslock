import 'reflect-metadata';
import type { CallHandler, ExecutionContext } from '@nestjs/common';
import type { LockConfiguration, LockingTaskExecutorListener, LockProvider, SimpleLock } from '@tslock/core';
import { DefaultLockingTaskExecutor, LockAssert, LockException } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { lastValueFrom, of, throwError } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  getSchedulerLockOptions,
  isSchedulerLockWrapped,
  SCHEDULER_LOCK_METADATA,
  SchedulerLock,
} from '../src/scheduler-lock.js';
import { SchedulerLockInterceptor } from '../src/scheduler-lock-interceptor.js';
import {
  bindSchedulerLockRuntime,
  type SchedulerLockRuntime,
  unbindSchedulerLockRuntime,
} from '../src/scheduler-lock-runtime.js';
import { TslockModule } from '../src/tslock-module.js';

function acquiredLock(): SimpleLock {
  return {
    async unlock() {},
    async extend() {
      return undefined;
    },
  };
}

function recordingProvider(acquire = true): LockProvider & { configs: LockConfiguration[] } {
  const configs: LockConfiguration[] = [];
  return {
    configs,
    async lock(config) {
      configs.push(config);
      return acquire ? acquiredLock() : undefined;
    },
  };
}

function bindRuntime(
  provider: LockProvider,
  overrides?: Partial<SchedulerLockRuntime> & { listener?: LockingTaskExecutorListener },
): SchedulerLockRuntime {
  const runtime: SchedulerLockRuntime = {
    executor: new DefaultLockingTaskExecutor(provider, overrides?.listener),
    defaultLockAtMostFor: overrides?.defaultLockAtMostFor ?? 60_000,
    defaultLockAtLeastFor: overrides?.defaultLockAtLeastFor ?? 0,
  };
  bindSchedulerLockRuntime(runtime);
  return runtime;
}

function contextFor(handler: object): ExecutionContext {
  return {
    getHandler: () => handler,
  } as ExecutionContext;
}

describe('@SchedulerLock', () => {
  let runtime: SchedulerLockRuntime | undefined;

  afterEach(() => {
    if (runtime) unbindSchedulerLockRuntime(runtime);
    runtime = undefined;
  });

  it('runs the method under the lock and preserves this and the return value', async () => {
    runtime = bindRuntime(recordingProvider());

    class Job {
      readonly value = 2;

      @SchedulerLock({ name: 'self', lockAtMostFor: '1s' })
      async run(extra: number): Promise<number> {
        LockAssert.assertLocked();
        return this.value + extra;
      }
    }

    await expect(new Job().run(3)).resolves.toBe(5);
  });

  it('returns zero when the locked method returns zero', async () => {
    runtime = bindRuntime(recordingProvider());

    class Job {
      @SchedulerLock({ name: 'zero', lockAtMostFor: '1s' })
      run(): number {
        return 0;
      }
    }

    await expect(new Job().run()).resolves.toBe(0);
  });

  it('skips the method and returns undefined when the lock is not acquired', async () => {
    runtime = bindRuntime(recordingProvider(false));
    let calls = 0;

    class Job {
      @SchedulerLock({ name: 'skip', lockAtMostFor: '1s' })
      async run(): Promise<string> {
        calls += 1;
        return 'ok';
      }
    }

    await expect(new Job().run()).resolves.toBeUndefined();
    expect(calls).toBe(0);
  });

  it('runs only one overlapping call for the same lock name', async () => {
    runtime = bindRuntime(new InMemoryLockProvider());
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    class Job {
      started = 0;

      @SchedulerLock({ name: 'overlap', lockAtMostFor: '5s' })
      async run(): Promise<string> {
        this.started += 1;
        await gate;
        return 'done';
      }
    }

    const job = new Job();
    const first = job.run();
    await vi.waitFor(() => expect(job.started).toBe(1));
    await expect(job.run()).resolves.toBeUndefined();
    expect(job.started).toBe(1);
    release?.();
    await expect(first).resolves.toBe('done');
    await expect(job.run()).resolves.toBe('done');
    expect(job.started).toBe(2);
  });

  it('unlocks after the method throws and propagates provider errors', async () => {
    const events: string[] = [];
    runtime = bindRuntime({
      async lock() {
        events.push('lock');
        return {
          async unlock() {
            events.push('unlock');
          },
          async extend() {
            return undefined;
          },
        };
      },
    });

    class Job {
      @SchedulerLock({ name: 'boom', lockAtMostFor: '1s' })
      async run(): Promise<void> {
        throw new Error('task failed');
      }
    }

    await expect(new Job().run()).rejects.toThrow('task failed');
    expect(events).toEqual(['lock', 'unlock']);

    unbindSchedulerLockRuntime(runtime);
    runtime = bindRuntime({
      async lock() {
        throw new Error('storage down');
      },
    });

    class Broken {
      @SchedulerLock({ name: 'storage', lockAtMostFor: '1s' })
      async run(): Promise<void> {}
    }

    await expect(new Broken().run()).rejects.toThrow('storage down');
  });

  it('uses decorator durations over module defaults', async () => {
    const provider = recordingProvider();
    runtime = bindRuntime(provider, { defaultLockAtMostFor: 60_000, defaultLockAtLeastFor: 5_000 });

    class Job {
      @SchedulerLock({ name: 'durations', lockAtMostFor: '2s', lockAtLeastFor: '1s' })
      async run(): Promise<void> {}
    }

    await new Job().run();
    expect(provider.configs[0]).toMatchObject({ name: 'durations', lockAtMostFor: 2_000, lockAtLeastFor: 1_000 });
  });

  it('fills omitted durations from the module runtime', async () => {
    const provider = recordingProvider();
    runtime = bindRuntime(provider, { defaultLockAtMostFor: 30_000, defaultLockAtLeastFor: 5_000 });

    class Job {
      @SchedulerLock({ name: 'defaults', lockAtMostFor: '20s' })
      async run(): Promise<void> {}
    }

    await new Job().run();
    expect(provider.configs[0]).toMatchObject({ lockAtMostFor: 20_000, lockAtLeastFor: 5_000 });
  });

  it('throws when no module runtime is bound', async () => {
    class Job {
      @SchedulerLock({ name: 'missing', lockAtMostFor: '1s' })
      async run(): Promise<string> {
        return 'ran';
      }
    }

    await expect(new Job().run()).rejects.toBeInstanceOf(LockException);
  });

  it('rejects invalid decorator options when the class is defined', () => {
    expect(() => {
      class EmptyName {
        @SchedulerLock({ name: '' })
        run(): void {}
      }
      return EmptyName;
    }).toThrow(LockException);

    expect(() => {
      class BadDuration {
        @SchedulerLock({ name: 'job', lockAtMostFor: 'nope' })
        run(): void {}
      }
      return BadDuration;
    }).toThrow(LockException);

    expect(() => {
      class Inverted {
        @SchedulerLock({ name: 'job', lockAtMostFor: '1s', lockAtLeastFor: '2s' })
        run(): void {}
      }
      return Inverted;
    }).toThrow(LockException);
  });

  it('keeps metadata from a decorator applied before or after SchedulerLock', () => {
    const mark = (value: string): MethodDecorator => {
      return (_target, _key, descriptor) => {
        Reflect.defineMetadata('mark', value, descriptor.value as object);
        return descriptor;
      };
    };

    class OuterLock {
      @SchedulerLock({ name: 'outer', lockAtMostFor: '1s' })
      @mark('cron')
      run(): void {}
    }

    class InnerLock {
      @mark('cron')
      @SchedulerLock({ name: 'inner', lockAtMostFor: '1s' })
      run(): void {}
    }

    expect(Reflect.getMetadata('mark', OuterLock.prototype.run)).toBe('cron');
    expect(getSchedulerLockOptions(OuterLock.prototype.run)).toMatchObject({ name: 'outer' });
    expect(isSchedulerLockWrapped(OuterLock.prototype.run)).toBe(true);
    expect(Reflect.getMetadata('mark', InnerLock.prototype.run)).toBe('cron');
    expect(getSchedulerLockOptions(InnerLock.prototype.run)).toMatchObject({ name: 'inner' });
  });

  it('emits executor listener events for an acquired lock', async () => {
    const events: string[] = [];
    const listener: LockingTaskExecutorListener = {
      onLockAttempt: () => events.push('attempt'),
      onLockAcquired: () => events.push('acquired'),
      onLockNotAcquired: () => events.push('miss'),
      onTaskStarted: () => events.push('started'),
      onTaskFinished: () => events.push('finished'),
    };
    runtime = bindRuntime(recordingProvider(), { listener });

    class Job {
      @SchedulerLock({ name: 'listened', lockAtMostFor: '1s' })
      async run(): Promise<void> {}
    }

    await new Job().run();
    expect(events).toEqual(['attempt', 'acquired', 'started', 'finished']);
  });

  it('rejects invalid module options', () => {
    expect(() =>
      TslockModule.forRoot({
        lockProvider: {
          async lock() {
            return undefined;
          },
        },
        defaultLockAtMostFor: '1s',
        defaultLockAtLeastFor: '2s',
      }),
    ).toThrow(LockException);
    expect(() =>
      TslockModule.forRoot({
        lockProvider: {} as LockProvider,
        defaultLockAtMostFor: '1s',
      }),
    ).toThrow(LockException);
  });
});

describe('SchedulerLockInterceptor', () => {
  let runtime: SchedulerLockRuntime | undefined;
  const interceptor = new SchedulerLockInterceptor();

  afterEach(() => {
    if (runtime) unbindSchedulerLockRuntime(runtime);
    runtime = undefined;
  });

  it('delegates when the handler has no scheduler metadata', async () => {
    const handle = vi.fn(() => of('open'));
    await expect(
      lastValueFrom(
        interceptor.intercept(
          contextFor(function plain() {}),
          { handle },
        ),
      ),
    ).resolves.toBe('open');
    expect(handle).toHaveBeenCalledOnce();
  });

  it('delegates when the handler is already wrapped', async () => {
    const lock = vi.fn(async () => {
      throw new Error('should not lock');
    });
    runtime = bindRuntime({ lock });

    class Sample {
      @SchedulerLock({ name: 'wrapped', lockAtMostFor: '1s' })
      run(): string {
        return 'direct';
      }
    }

    const handle = vi.fn(() => of('passed'));
    await expect(lastValueFrom(interceptor.intercept(contextFor(Sample.prototype.run), { handle }))).resolves.toBe(
      'passed',
    );
    expect(lock).not.toHaveBeenCalled();
  });

  it('runs an unwrapped metadata handler under the lock', async () => {
    runtime = bindRuntime(recordingProvider());
    const handler = function handler() {
      return 'value';
    };
    Reflect.defineMetadata(SCHEDULER_LOCK_METADATA, { name: 'http', lockAtMostFor: '1s' }, handler);
    const handle = vi.fn(() => of('value'));

    await expect(lastValueFrom(interceptor.intercept(contextFor(handler), { handle }))).resolves.toBe('value');
    expect(handle).toHaveBeenCalledOnce();
  });

  it('does not call the handler when the lock is not acquired', async () => {
    runtime = bindRuntime(recordingProvider(false));
    const handler = function handler() {
      return 'secret';
    };
    Reflect.defineMetadata(SCHEDULER_LOCK_METADATA, { name: 'http', lockAtMostFor: '1s' }, handler);
    const handle = vi.fn(() => of('secret'));

    await expect(lastValueFrom(interceptor.intercept(contextFor(handler), { handle }))).resolves.toBeUndefined();
    expect(handle).not.toHaveBeenCalled();
  });

  it('propagates handler errors and unlocks', async () => {
    const events: string[] = [];
    runtime = bindRuntime({
      async lock() {
        events.push('lock');
        return {
          async unlock() {
            events.push('unlock');
          },
          async extend() {
            return undefined;
          },
        };
      },
    });
    const handler = function handler() {
      return undefined;
    };
    Reflect.defineMetadata(SCHEDULER_LOCK_METADATA, { name: 'http', lockAtMostFor: '1s' }, handler);
    const next: CallHandler = { handle: () => throwError(() => new Error('handler failed')) };

    await expect(lastValueFrom(interceptor.intercept(contextFor(handler), next))).rejects.toThrow('handler failed');
    expect(events).toEqual(['lock', 'unlock']);
  });

  it('passes through a non-function handler', async () => {
    const handle = vi.fn(() => of('still'));
    const context = { getHandler: () => 'nope' } as unknown as ExecutionContext;
    await expect(lastValueFrom(interceptor.intercept(context, { handle }))).resolves.toBe('still');
  });
});
