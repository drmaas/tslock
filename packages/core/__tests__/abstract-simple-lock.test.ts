import { describe, expect, it, vi } from 'vitest';
import { AbstractSimpleLock } from '../src/simple-lock.js';
import { createLockConfig } from '../src/lock-configuration.js';
import { LockException } from '../src/lock-exception.js';
import type { SimpleLock } from '../src/simple-lock.js';

class TestLock extends AbstractSimpleLock {
  doUnlockMock = vi.fn();
  doExtendMock = vi.fn();

  protected async doUnlock(): Promise<void> {
    this.doUnlockMock();
  }

  protected async doExtend(): Promise<SimpleLock | undefined> {
    return this.doExtendMock();
  }
}

class NonExtensibleLock extends AbstractSimpleLock {
  protected async doUnlock(): Promise<void> {}
}

describe('AbstractSimpleLock', () => {
  it('unlock() calls doUnlock and invalidates', async () => {
    const lock = new TestLock(createLockConfig('test', 1000));
    await lock.unlock();
    expect(lock.doUnlockMock).toHaveBeenCalledOnce();
  });

  it('second unlock() throws', async () => {
    const lock = new TestLock(createLockConfig('test', 1000));
    await lock.unlock();
    await expect(lock.unlock()).rejects.toThrow(LockException);
  });

  it('extend() calls doExtend and returns new lock', async () => {
    const newLock = new TestLock(createLockConfig('test', 2000));
    const lock = new TestLock(createLockConfig('test', 1000));
    lock.doExtendMock.mockResolvedValue(newLock);
    const result = await lock.extend(2000, 0);
    expect(result).toBe(newLock);
    expect(lock.doExtendMock).toHaveBeenCalledOnce();
  });

  it('extend() invalidates original', async () => {
    const newLock = new TestLock(createLockConfig('test', 2000));
    const lock = new TestLock(createLockConfig('test', 1000));
    lock.doExtendMock.mockResolvedValue(newLock);
    await lock.extend(2000, 0);
    await expect(lock.unlock()).rejects.toThrow(LockException);
  });

  it('default doExtend throws', async () => {
    const lock = new NonExtensibleLock(createLockConfig('test', 1000));
    await expect(lock.extend(2000, 0)).rejects.toThrow(LockException);
  });
});
