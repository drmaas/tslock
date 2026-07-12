import { describe, expect, it, vi } from 'vitest';
import { TrackingLockProviderWrapper } from '../src/tracking-lock-provider.js';
import { createLockConfig } from '../src/lock-configuration.js';
import type { LockProvider } from '../src/lock-provider.js';
import type { SimpleLock } from '../src/simple-lock.js';

function makeLock(): SimpleLock & { unlock: ReturnType<typeof vi.fn>; extend: ReturnType<typeof vi.fn> } {
  return {
    unlock: vi.fn(),
    extend: vi.fn(),
  } as unknown as SimpleLock & { unlock: ReturnType<typeof vi.fn>; extend: ReturnType<typeof vi.fn> };
}

describe('TrackingLockProviderWrapper', () => {
  it('tracks active locks', async () => {
    const lock = makeLock();
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const result = await wrapper.lock(createLockConfig('t', 1000));
    expect(wrapper.getActiveLocks().size).toBe(1);
    expect(result).toBeDefined();
  });

  it('unlock removes from active set', async () => {
    const lock = makeLock();
    const provider: LockProvider = { lock: vi.fn().mockResolvedValue(lock) };
    const wrapper = new TrackingLockProviderWrapper(provider);
    const wrapped = (await wrapper.lock(createLockConfig('t', 1000)))!;
    expect(wrapper.getActiveLocks().size).toBe(1);
    await wrapped.unlock();
    expect(wrapper.getActiveLocks().size).toBe(0);
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
});
