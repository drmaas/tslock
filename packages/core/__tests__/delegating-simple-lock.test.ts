import { describe, expect, it, vi } from 'vitest';
import { createLockConfig } from '../src/lock-configuration.js';
import { LockException } from '../src/lock-exception.js';
import type { SimpleLock, SimpleLockDelegate } from '../src/simple-lock.js';
import { DelegatingSimpleLock } from '../src/simple-lock.js';

describe('DelegatingSimpleLock', () => {
  it('unlock() forwards the original config to the delegate', async () => {
    const config = createLockConfig('test', 1000);
    const unlock = vi.fn().mockResolvedValue(undefined);
    const delegate: SimpleLockDelegate = { unlock };
    const lock = new DelegatingSimpleLock(config, delegate);

    await lock.unlock();

    expect(unlock).toHaveBeenCalledOnce();
    expect(unlock).toHaveBeenCalledWith(config);
  });

  it('extend() forwards the new config and returns the delegate result', async () => {
    const config = createLockConfig('test', 1000);
    const extended = {} as SimpleLock;
    const unlock = vi.fn().mockResolvedValue(undefined);
    const extend = vi.fn().mockResolvedValue(extended);
    const lock = new DelegatingSimpleLock(config, { unlock, extend });

    const result = await lock.extend(2000, 100);

    expect(result).toBe(extended);
    expect(extend).toHaveBeenCalledOnce();
    expect(extend.mock.calls[0]?.[0]).toMatchObject({
      name: 'test',
      lockAtMostFor: 2000,
      lockAtLeastFor: 100,
    });
  });

  it('extend() with a delegate that has no extend throws LockException', async () => {
    const lock = new DelegatingSimpleLock(createLockConfig('test', 1000), {
      unlock: vi.fn().mockResolvedValue(undefined),
    });

    await expect(lock.extend(2000, 0)).rejects.toThrow(LockException);
    await expect(lock.extend(2000, 0)).rejects.toThrow('Extend not supported by this provider');
  });

  it('is invalidated after unlock', async () => {
    const lock = new DelegatingSimpleLock(createLockConfig('test', 1000), {
      unlock: vi.fn().mockResolvedValue(undefined),
    });

    await lock.unlock();

    await expect(lock.unlock()).rejects.toThrow(LockException);
  });

  it('is invalidated after extend', async () => {
    const lock = new DelegatingSimpleLock(createLockConfig('test', 1000), {
      unlock: vi.fn().mockResolvedValue(undefined),
      extend: vi.fn().mockResolvedValue({} as SimpleLock),
    });

    await lock.extend(2000, 0);

    await expect(lock.unlock()).rejects.toThrow(LockException);
  });
});
