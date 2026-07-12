import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ClockProvider, createLockConfig } from '@tslock/core';
import { InMemoryLockProvider } from '../src/in-memory-lock-provider.js';

describe('InMemoryLockProvider integration', () => {
  let provider: InMemoryLockProvider;
  let baseTime: number;

  beforeEach(() => {
    ClockProvider.resetClock();
    baseTime = Date.now();
    provider = new InMemoryLockProvider();
  });

  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('shouldLockOnce', async () => {
    const lock = await provider.lock(createLockConfig('test', 60_000));
    expect(lock).toBeDefined();
    await lock!.unlock();
  });

  it('shouldSkipIfLocked', async () => {
    const lock1 = await provider.lock(createLockConfig('test', 60_000));
    const lock2 = await provider.lock(createLockConfig('test', 60_000));
    expect(lock1).toBeDefined();
    expect(lock2).toBeUndefined();
    await lock1!.unlock();
  });

  it('shouldUnlock', async () => {
    const lock1 = await provider.lock(createLockConfig('test', 60_000));
    await lock1!.unlock();
    const lock2 = await provider.lock(createLockConfig('test', 60_000));
    expect(lock2).toBeDefined();
    await lock2!.unlock();
  });

  it('shouldLockAtLeastFor', async () => {
    ClockProvider.setClock(() => baseTime);
    const lock1 = (await provider.lock(createLockConfig('test', 10_000, 5_000)))!;
    await lock1.unlock();
    ClockProvider.setClock(() => baseTime + 2_000);
    const lock2 = await provider.lock(createLockConfig('test', 10_000));
    expect(lock2).toBeUndefined();
    ClockProvider.setClock(() => baseTime + 7_000);
    const lock3 = await provider.lock(createLockConfig('test', 10_000));
    expect(lock3).toBeDefined();
    await lock3!.unlock();
  });

  it('shouldExtendLock', async () => {
    ClockProvider.setClock(() => baseTime);
    const lock = (await provider.lock(createLockConfig('test', 10_000)))!;
    ClockProvider.setClock(() => baseTime + 6_000);
    const extended = await lock.extend(10_000, 0);
    expect(extended).toBeDefined();
    ClockProvider.setClock(() => baseTime + 14_000);
    const lock2 = await provider.lock(createLockConfig('test', 10_000));
    expect(lock2).toBeUndefined();
    await extended!.unlock();
  });
});
