import type { LockConfiguration, LockProvider, SimpleLock } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { createNodeCronLock } from '../src/index.js';

function acquiredLock(onUnlock?: () => void): SimpleLock {
  return {
    async unlock() {
      onUnlock?.();
    },
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

describe('createNodeCronLock', () => {
  it('wraps a task with lock acquire and skip', async () => {
    const acquired = createNodeCronLock({
      lockProvider: recordingProvider(true),
      defaultLockAtMostFor: '1m',
    });
    let calls = 0;
    const ok = acquired.wrap(
      async () => {
        calls += 1;
        return 'ran';
      },
      { name: 'cron-job', lockAtMostFor: '1s' },
    );
    await expect(ok()).resolves.toBe('ran');
    expect(calls).toBe(1);

    const skipped = createNodeCronLock({
      lockProvider: recordingProvider(false),
      defaultLockAtMostFor: '1m',
    });
    const miss = skipped.wrap(
      async () => {
        calls += 1;
        return 'ran';
      },
      { name: 'cron-job', lockAtMostFor: '1s' },
    );
    await expect(miss()).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('schedule delegates to cron.schedule with a wrapped callback', async () => {
    const provider = recordingProvider(true);
    const lock = createNodeCronLock({
      lockProvider: provider,
      defaultLockAtMostFor: '1m',
    });
    const scheduled: Array<{ expression: string; options?: Record<string, unknown> }> = [];
    let scheduledFn: ((...args: unknown[]) => unknown) | undefined;
    const cron = {
      schedule(expression: string, func: (...args: unknown[]) => unknown, options?: Record<string, unknown>) {
        scheduled.push({ expression, options });
        scheduledFn = func;
        return { id: 'task-1' };
      },
    };

    const handle = lock.schedule(cron, '* * * * *', async () => 'tick', {
      name: 'tick',
      lockAtMostFor: '10s',
      taskOptions: { name: 'tick', noOverlap: true },
    });

    expect(handle).toEqual({ id: 'task-1' });
    expect(scheduled).toEqual([{ expression: '* * * * *', options: { name: 'tick', noOverlap: true } }]);
    await expect(Promise.resolve(scheduledFn?.())).resolves.toBe('tick');
    expect(provider.configs[0]).toMatchObject({ name: 'tick', lockAtMostFor: 10_000 });
  });

  it('createRunCoordinator acquires, skips, unlocks, and applies keyPrefix', async () => {
    const unlocked: string[] = [];
    const held = new Map<string, boolean>();
    const provider: LockProvider = {
      async lock(config) {
        if (held.get(config.name)) return undefined;
        held.set(config.name, true);
        return acquiredLock(() => {
          unlocked.push(config.name);
          held.set(config.name, false);
        });
      },
    };
    const lock = createNodeCronLock({
      lockProvider: provider,
      defaultLockAtMostFor: '1m',
    });
    const coordinator = lock.createRunCoordinator({ keyPrefix: 'app:', lockAtLeastFor: 0 });

    await expect(coordinator.shouldRun('nightly', 5_000)).resolves.toBe(true);
    await expect(coordinator.shouldRun('nightly', 5_000)).resolves.toBe(false);
    await coordinator.onComplete?.('nightly');
    expect(unlocked).toEqual(['app:nightly']);
    await expect(coordinator.shouldRun('nightly', 5_000)).resolves.toBe(true);
  });

  it('createRunCoordinator onComplete is a no-op when no lock is held', async () => {
    const lock = createNodeCronLock({
      lockProvider: recordingProvider(false),
      defaultLockAtMostFor: '1m',
    });
    const coordinator = lock.createRunCoordinator();
    await expect(coordinator.shouldRun('missing', 1_000)).resolves.toBe(false);
    await expect(coordinator.onComplete?.('missing')).resolves.toBeUndefined();
  });

  it('createRunCoordinator clears the map when unlock rejects', async () => {
    let unlocks = 0;
    const provider: LockProvider = {
      async lock() {
        return {
          async unlock() {
            unlocks += 1;
            throw new Error('unlock failed');
          },
          async extend() {
            return undefined;
          },
        };
      },
    };
    const lock = createNodeCronLock({
      lockProvider: provider,
      defaultLockAtMostFor: '1m',
    });
    const coordinator = lock.createRunCoordinator();
    await expect(coordinator.shouldRun('job', 1_000)).resolves.toBe(true);
    await expect(coordinator.onComplete?.('job')).rejects.toThrow('unlock failed');
    expect(unlocks).toBe(1);
    await expect(coordinator.shouldRun('job', 1_000)).resolves.toBe(true);
    await expect(coordinator.onComplete?.('job')).rejects.toThrow('unlock failed');
    expect(unlocks).toBe(2);
  });
});
