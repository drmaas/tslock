import { describe, expect, it, vi } from 'vitest';
import { LockExtender, NoActiveLockException, LockCanNotBeExtendedException } from '../src/lock-extender.js';
import { createLockConfig } from '../src/lock-configuration.js';
import type { SimpleLock } from '../src/simple-lock.js';

function makeLock(): SimpleLock {
  return {
    unlock: vi.fn(),
    extend: vi.fn(),
  };
}

describe('LockExtender', () => {
  it('extendActiveLock throws when no active lock', async () => {
    await expect(LockExtender.extendActiveLock('1m', 0)).rejects.toThrow(NoActiveLockException);
  });

  it('extendActiveLock calls lock.extend inside context', async () => {
    const lock = makeLock();
    const newLock = makeLock();
    (lock.extend as ReturnType<typeof vi.fn>).mockResolvedValue(newLock);
    await LockExtender.runWithLock(lock, () => LockExtender.extendActiveLock('2m', '30s'));
    expect(lock.extend).toHaveBeenCalledWith(120_000, 30_000);
  });

  it('extendActiveLock throws LockCanNotBeExtendedException when extend returns undefined', async () => {
    const lock = makeLock();
    (lock.extend as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await expect(
      LockExtender.runWithLock(lock, () => LockExtender.extendActiveLock('1m', 0)),
    ).rejects.toThrow(LockCanNotBeExtendedException);
  });
});
