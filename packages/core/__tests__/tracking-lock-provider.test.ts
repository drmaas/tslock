import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClockProvider } from '../src/clock-provider.js';
import { createLockConfig } from '../src/lock-configuration.js';
import type { LockProvider } from '../src/lock-provider.js';
import type { SimpleLock } from '../src/simple-lock.js';
import { TrackingLockProviderWrapper } from '../src/tracking-lock-provider.js';

function makeLock(): SimpleLock & { unlock: ReturnType<typeof vi.fn>; extend: ReturnType<typeof vi.fn> } {
  return {
    unlock: vi.fn(),
    extend: vi.fn(),
  } as unknown as SimpleLock & { unlock: ReturnType<typeof vi.fn>; extend: ReturnType<typeof vi.fn> };
}

describe('TrackingLockProviderWrapper', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('tracks active locks', async () => {
    const lock = makeLock();
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const result = await wrapper.lock(createLockConfig('t', 1000));
    expect(wrapper.getActiveLocks().size).toBe(1);
    expect(result).toBeDefined();
  });

  it('records active lock metadata', async () => {
    ClockProvider.setClock(() => 1_000);
    const lock = makeLock();
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    await wrapper.lock(createLockConfig('nightly', 5_000, 1_000));
    expect(wrapper.getActiveLockRecords()).toEqual([
      {
        name: 'nightly',
        lockAtMostFor: 5_000,
        lockAtLeastFor: 1_000,
        acquiredAt: 1_000,
        updatedAt: 1_000,
      },
    ]);
  });

  it('unlock removes from active set', async () => {
    const lock = makeLock();
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const wrapped = (await wrapper.lock(createLockConfig('t', 1000)))!;
    expect(wrapper.getActiveLocks().size).toBe(1);
    await wrapped.unlock();
    expect(wrapper.getActiveLocks().size).toBe(0);
    expect(wrapper.getActiveLockRecords()).toEqual([]);
    expect(lock.unlock).toHaveBeenCalledOnce();
  });

  it('double unlock calls delegate once', async () => {
    const lock = makeLock();
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const wrapped = (await wrapper.lock(createLockConfig('t', 1000)))!;
    await wrapped.unlock();
    await wrapped.unlock();
    expect(lock.unlock).toHaveBeenCalledOnce();
  });

  it('extend preserves acquiredAt and refreshes updatedAt', async () => {
    let now = 1_000;
    ClockProvider.setClock(() => now);
    const next = makeLock();
    const lock = makeLock();
    lock.extend.mockResolvedValue(next);
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const wrapped = (await wrapper.lock(createLockConfig('t', 5_000, 500)))!;
    now = 2_500;
    const extended = await wrapped.extend(8_000, 0);
    expect(extended).toBeDefined();
    expect(wrapper.getActiveLocks().size).toBe(1);
    expect(wrapper.getActiveLocks().has(wrapped)).toBe(false);
    expect(wrapper.getActiveLockRecords()).toEqual([
      {
        name: 't',
        lockAtMostFor: 8_000,
        lockAtLeastFor: 0,
        acquiredAt: 1_000,
        updatedAt: 2_500,
      },
    ]);
  });

  it('failed extend leaves the original lock tracked', async () => {
    const lock = makeLock();
    lock.extend.mockResolvedValue(undefined);
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const wrapped = (await wrapper.lock(createLockConfig('t', 1000)))!;
    await expect(wrapped.extend(1000, 0)).resolves.toBeUndefined();
    expect(wrapper.getActiveLocks().has(wrapped)).toBe(true);
    expect(wrapper.getActiveLockRecords()).toHaveLength(1);
  });
});
