import type { LockProvider, SimpleLock } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { createBreeLock } from '../src/index.js';

function acquiredLock(): SimpleLock {
  return {
    async unlock() {},
    async extend() {
      return undefined;
    },
  };
}

function provider(acquire = true): LockProvider {
  return {
    async lock() {
      return acquire ? acquiredLock() : undefined;
    },
  };
}

describe('createBreeLock', () => {
  it('wraps a bree job with lock acquire and skip', async () => {
    const lock = createBreeLock({
      lockProvider: provider(true),
      defaultLockAtMostFor: '5m',
    });
    expect(lock.config.defaultLockAtMostFor).toBe(300_000);
    expect(lock.executor).toBeDefined();

    let calls = 0;
    const job = lock.wrap(
      async () => {
        calls += 1;
        return 'done';
      },
      { name: 'bree-job', lockAtMostFor: '1s' },
    );

    await expect(job()).resolves.toBe('done');
    expect(calls).toBe(1);

    const skipped = createBreeLock({
      lockProvider: provider(false),
      defaultLockAtMostFor: '5m',
    });
    await expect(
      skipped.wrap(
        async () => {
          calls += 1;
          return 'done';
        },
        { name: 'bree-job', lockAtMostFor: '1s' },
      )(),
    ).resolves.toBeUndefined();
    expect(calls).toBe(1);
  });

  it('run skips when the lock is not acquired', async () => {
    const lock = createBreeLock({
      lockProvider: provider(false),
      defaultLockAtMostFor: '1m',
    });
    await expect(lock.run(async () => 'x', { name: 'run', lockAtMostFor: '1s' })).resolves.toBeUndefined();
  });
});
