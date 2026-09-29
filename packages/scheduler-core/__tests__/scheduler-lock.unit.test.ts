import type { LockConfiguration, LockingTaskExecutorListener, LockProvider, SimpleLock } from '@tslock/core';
import { LockAssert, LockException } from '@tslock/core';
import { InMemoryLockProvider } from '@tslock/in-memory';
import { describe, expect, it, vi } from 'vitest';
import { createSchedulerLock, resolveSchedulerLockConfig } from '../src/index.js';

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

describe('resolveSchedulerLockConfig', () => {
  it('rejects missing provider and inverted durations', () => {
    expect(() =>
      resolveSchedulerLockConfig({
        lockProvider: {} as LockProvider,
        defaultLockAtMostFor: '1s',
      }),
    ).toThrow(LockException);
    expect(() =>
      resolveSchedulerLockConfig({
        lockProvider: recordingProvider(),
        defaultLockAtMostFor: '1s',
        defaultLockAtLeastFor: '2s',
      }),
    ).toThrow(LockException);
    expect(() =>
      resolveSchedulerLockConfig({
        lockProvider: recordingProvider(),
        defaultLockAtMostFor: undefined as unknown as string,
      }),
    ).toThrow(LockException);
  });

  it('resolves defaults', () => {
    const config = resolveSchedulerLockConfig({
      lockProvider: recordingProvider(),
      defaultLockAtMostFor: '30s',
    });
    expect(config.defaultLockAtMostFor).toBe(30_000);
    expect(config.defaultLockAtLeastFor).toBe(0);
  });
});

describe('createSchedulerLock', () => {
  it('runs the wrapped task under the lock and preserves return values', async () => {
    const lock = createSchedulerLock({
      lockProvider: recordingProvider(),
      defaultLockAtMostFor: '1m',
    });
    const wrapped = lock.wrap(
      async (n: number) => {
        LockAssert.assertLocked();
        return n + 1;
      },
      { name: 'job', lockAtMostFor: '1s' },
    );

    await expect(wrapped(41)).resolves.toBe(42);
    await expect(lock.wrap(() => 0, { name: 'zero', lockAtMostFor: '1s' })()).resolves.toBe(0);
    await expect(lock.wrap(() => false, { name: 'false', lockAtMostFor: '1s' })()).resolves.toBe(false);
    await expect(lock.wrap(() => null, { name: 'null', lockAtMostFor: '1s' })()).resolves.toBeNull();
  });

  it('skips the task and returns undefined when the lock is not acquired', async () => {
    const events: string[] = [];
    const listener: LockingTaskExecutorListener = {
      onLockAttempt: () => events.push('attempt'),
      onLockAcquired: () => events.push('acquired'),
      onLockNotAcquired: () => events.push('miss'),
      onTaskStarted: () => events.push('started'),
      onTaskFinished: () => events.push('finished'),
    };
    const lock = createSchedulerLock({
      lockProvider: recordingProvider(false),
      defaultLockAtMostFor: '1m',
      listener,
    });
    let calls = 0;
    const wrapped = lock.wrap(
      async () => {
        calls += 1;
        return 'ok';
      },
      { name: 'skip', lockAtMostFor: '1s' },
    );

    await expect(wrapped()).resolves.toBeUndefined();
    expect(calls).toBe(0);
    expect(events).toEqual(['attempt', 'miss']);
  });

  it('unlocks after the task throws and propagates provider errors', async () => {
    const events: string[] = [];
    const lock = createSchedulerLock({
      lockProvider: {
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
      },
      defaultLockAtMostFor: '1m',
    });

    await expect(
      lock.wrap(
        async () => {
          throw new Error('task failed');
        },
        { name: 'boom', lockAtMostFor: '1s' },
      )(),
    ).rejects.toThrow('task failed');
    expect(events).toEqual(['lock', 'unlock']);

    const broken = createSchedulerLock({
      lockProvider: {
        async lock() {
          throw new Error('storage down');
        },
      },
      defaultLockAtMostFor: '1m',
    });
    await expect(broken.wrap(async () => 'x', { name: 'storage', lockAtMostFor: '1s' })()).rejects.toThrow(
      'storage down',
    );
  });

  it('uses job durations over defaults and fills omitted least from defaults', async () => {
    const provider = recordingProvider();
    const lock = createSchedulerLock({
      lockProvider: provider,
      defaultLockAtMostFor: '60s',
      defaultLockAtLeastFor: '5s',
    });

    await lock.run(async () => {}, { name: 'durations', lockAtMostFor: '2s', lockAtLeastFor: '1s' });
    expect(provider.configs[0]).toMatchObject({ name: 'durations', lockAtMostFor: 2_000, lockAtLeastFor: 1_000 });

    await lock.run(async () => {}, { name: 'defaults', lockAtMostFor: '20s' });
    expect(provider.configs[1]).toMatchObject({ lockAtMostFor: 20_000, lockAtLeastFor: 5_000 });
  });

  it('runs only one overlapping call for the same lock name', async () => {
    const lock = createSchedulerLock({
      lockProvider: new InMemoryLockProvider(),
      defaultLockAtMostFor: '5s',
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let started = 0;
    const wrapped = lock.wrap(
      async () => {
        started += 1;
        await gate;
        return 'done';
      },
      { name: 'overlap', lockAtMostFor: '5s' },
    );

    const first = wrapped();
    await vi.waitFor(() => expect(started).toBe(1));
    await expect(wrapped()).resolves.toBeUndefined();
    expect(started).toBe(1);
    release?.();
    await expect(first).resolves.toBe('done');
  });

  it('rejects invalid job options when wrapping', () => {
    const lock = createSchedulerLock({
      lockProvider: recordingProvider(),
      defaultLockAtMostFor: '1m',
    });
    expect(() => lock.wrap(async () => {}, { name: '' })).toThrow(LockException);
    expect(() => lock.wrap(async () => {}, { name: 'job', lockAtMostFor: '1s', lockAtLeastFor: '2s' })).toThrow(
      LockException,
    );
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
    const lock = createSchedulerLock({
      lockProvider: recordingProvider(),
      defaultLockAtMostFor: '1m',
      listener,
    });
    await lock.run(async () => {}, { name: 'listened', lockAtMostFor: '1s' });
    expect(events).toEqual(['attempt', 'acquired', 'started', 'finished']);
  });
});
