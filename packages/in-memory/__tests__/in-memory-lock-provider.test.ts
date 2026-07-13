import { ClockProvider, LockException, createLockConfig } from '@tslock/core';
import { describe, expect, it } from 'vitest';
import { InMemoryLockProvider } from '../src/in-memory-lock-provider.js';

describe('InMemoryLockProvider', () => {
  it('lock() returns a lock when not held', async () => {
    const provider = new InMemoryLockProvider();
    const lock = await provider.lock(createLockConfig('test', 60_000));
    expect(lock).toBeDefined();
  });

  it('lock() returns undefined when already held', async () => {
    const provider = new InMemoryLockProvider();
    const lock1 = await provider.lock(createLockConfig('test', 60_000));
    const lock2 = await provider.lock(createLockConfig('test', 60_000));
    expect(lock1).toBeDefined();
    expect(lock2).toBeUndefined();
  });

  it('unlock() releases the lock', async () => {
    const provider = new InMemoryLockProvider();
    const lock1 = (await provider.lock(createLockConfig('test', 60_000)))!;
    await lock1.unlock();
    const lock2 = await provider.lock(createLockConfig('test', 60_000));
    expect(lock2).toBeDefined();
  });

  it('lockAtLeastFor: unlock keeps lock until lockAtLeastFor expires', async () => {
    const provider = new InMemoryLockProvider();
    ClockProvider.setClock(() => 1_000_000);
    const lock1 = (await provider.lock(createLockConfig('test', 10_000, 5_000)))!;
    await lock1.unlock();
    ClockProvider.setClock(() => 1_002_000);
    const lock2 = await provider.lock(createLockConfig('test', 10_000));
    expect(lock2).toBeUndefined();
    ClockProvider.setClock(() => 1_007_000);
    const lock3 = await provider.lock(createLockConfig('test', 10_000));
    expect(lock3).toBeDefined();
  });

  it('extend() returns new lock and invalidates original', async () => {
    const provider = new InMemoryLockProvider();
    ClockProvider.setClock(() => 1_000_000);
    const lock = (await provider.lock(createLockConfig('test', 10_000)))!;
    const extended = await lock.extend(20_000, 0);
    expect(extended).toBeDefined();
    await expect(lock.unlock()).rejects.toThrow(LockException);
  });

  it('extend() returns undefined when lock expired', async () => {
    const provider = new InMemoryLockProvider();
    ClockProvider.setClock(() => 1_000_000);
    const lock = (await provider.lock(createLockConfig('test', 1_000)))!;
    ClockProvider.setClock(() => 1_005_000);
    const extended = await lock.extend(10_000, 0);
    expect(extended).toBeUndefined();
  });

  it('isLocked returns false after lock expires', () => {
    const provider = new InMemoryLockProvider();
    ClockProvider.setClock(() => 1_000_000);
    provider.locks.set('test', 1_005_000);
    expect(provider.isLocked('test')).toBe(true);
    ClockProvider.setClock(() => 1_010_000);
    expect(provider.isLocked('test')).toBe(false);
  });
});
