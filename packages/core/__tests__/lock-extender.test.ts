import { describe, expect, it, vi } from 'vitest';
import { LockCanNotBeExtendedException, NoActiveLockException } from '../src/lock-exception.js';
import { LockExtender } from '../src/lock-extender.js';
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
    await expect(LockExtender.runWithLock(lock, () => LockExtender.extendActiveLock('1m', 0))).rejects.toThrow(
      LockCanNotBeExtendedException,
    );
  });

  it('activeLock returns the innermost lock and the successor after extend', async () => {
    expect(LockExtender.activeLock()).toBeUndefined();
    const outer = makeLock();
    const inner = makeLock();
    const successor = makeLock();
    (inner.extend as ReturnType<typeof vi.fn>).mockResolvedValue(successor);
    await LockExtender.runWithLock(outer, async () => {
      expect(LockExtender.activeLock()).toBe(outer);
      await LockExtender.runWithLock(inner, async () => {
        expect(LockExtender.activeLock()).toBe(inner);
        await LockExtender.extendActiveLock('1m', 0);
        expect(LockExtender.activeLock()).toBe(successor);
      });
      expect(LockExtender.activeLock()).toBe(outer);
    });
    expect(LockExtender.activeLock()).toBeUndefined();
  });

  it('activeLock stays on the original handle when extend returns undefined', async () => {
    const lock = makeLock();
    (lock.extend as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);
    await LockExtender.runWithLock(lock, async () => {
      await expect(LockExtender.extendActiveLock('1m', 0)).rejects.toThrow(LockCanNotBeExtendedException);
      expect(LockExtender.activeLock()).toBe(lock);
    });
  });
});
