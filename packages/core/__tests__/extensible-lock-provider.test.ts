import { describe, expect, it, vi } from 'vitest';
import { KeepAliveLockProvider } from '../src/keep-alive-lock-provider.js';
import { LockException } from '../src/lock-exception.js';
import { type ExtensibleLockProvider, extensibleLockProvider, type LockProvider } from '../src/lock-provider.js';
import { type StorageAccessor, StorageBasedLockProvider } from '../src/storage-based-lock-provider.js';
import { TrackingLockProviderWrapper } from '../src/tracking-lock-provider.js';

const accessor: StorageAccessor = {
  insertRecord: async () => false,
  updateRecord: async () => false,
  unlock: async () => {},
  extend: async () => false,
};

describe('ExtensibleLockProvider brand', () => {
  it('rejects a LockProvider-only fake', () => {
    const provider: LockProvider = { lock: async () => undefined };
    const check = () => {
      // @ts-expect-error LockProvider is not an ExtensibleLockProvider
      new KeepAliveLockProvider(provider);
    };
    expect(check).toEqual(expect.any(Function));
  });

  it('accepts StorageBasedLockProvider', () => {
    const provider = new StorageBasedLockProvider(accessor);
    expect(new KeepAliveLockProvider(provider)).toBeInstanceOf(KeepAliveLockProvider);
  });

  it('accepts a TrackingLockProviderWrapper around an extensible provider', () => {
    const delegate: ExtensibleLockProvider = {
      [extensibleLockProvider]: true,
      lock: async () => undefined,
    };
    const tracking = new TrackingLockProviderWrapper(delegate);
    expect(new KeepAliveLockProvider(tracking)).toBeInstanceOf(KeepAliveLockProvider);
  });

  it('rejects a TrackingLockProviderWrapper around a plain LockProvider', () => {
    const delegate: LockProvider = { lock: async () => undefined };
    const tracking = new TrackingLockProviderWrapper(delegate);
    const check = () => {
      // @ts-expect-error TrackingLockProviderWrapper<LockProvider> is not extensible
      new KeepAliveLockProvider(tracking);
    };
    expect(check).toEqual(expect.any(Function));
  });

  it('throws LockException when a non-branded provider is cast', () => {
    const provider = { lock: vi.fn() } as unknown as ExtensibleLockProvider;
    expect(() => new KeepAliveLockProvider(provider)).toThrow(LockException);
    expect(provider.lock).not.toHaveBeenCalled();
  });
});
