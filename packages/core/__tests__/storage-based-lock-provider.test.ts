import { describe, expect, it, vi } from 'vitest';
import { StorageBasedLockProvider } from '../src/storage-based-lock-provider.js';
import { createLockConfig } from '../src/lock-configuration.js';
import type { StorageAccessor } from '../src/storage-based-lock-provider.js';

function makeAccessor(opts: {
  insertReturn?: boolean;
  updateReturn?: boolean;
  extendReturn?: boolean;
  updateThrows?: boolean;
} = {}): {
  accessor: StorageAccessor;
  insertMock: ReturnType<typeof vi.fn>;
  updateMock: ReturnType<typeof vi.fn>;
  unlockMock: ReturnType<typeof vi.fn>;
  extendMock: ReturnType<typeof vi.fn>;
} {
  const insertMock = vi.fn();
  const updateMock = vi.fn();
  const unlockMock = vi.fn();
  const extendMock = vi.fn();
  insertMock.mockResolvedValue(opts.insertReturn ?? false);
  if (opts.updateThrows) {
    updateMock.mockRejectedValue(new Error('storage-failure'));
  } else {
    updateMock.mockResolvedValue(opts.updateReturn ?? false);
  }
  unlockMock.mockResolvedValue(undefined);
  extendMock.mockResolvedValue(opts.extendReturn ?? false);
  return {
    accessor: {
      insertRecord: insertMock,
      updateRecord: updateMock,
      unlock: unlockMock,
      extend: extendMock,
    },
    insertMock,
    updateMock,
    unlockMock,
    extendMock,
  };
}

describe('StorageBasedLockProvider', () => {
  it('first lock: insertRecord returns true → lock acquired', async () => {
    const { accessor, insertMock, updateMock } = makeAccessor({ insertReturn: true });
    const provider = new StorageBasedLockProvider(accessor);
    const lock = await provider.lock(createLockConfig('t', 1000));
    expect(lock).toBeDefined();
    expect(insertMock).toHaveBeenCalledOnce();
    expect(updateMock).not.toHaveBeenCalled();
  });

  it('second lock: insertRecord false, updateRecord true → acquired', async () => {
    const { accessor, updateMock } = makeAccessor({ updateReturn: true });
    const provider = new StorageBasedLockProvider(accessor);
    const lock = await provider.lock(createLockConfig('t', 1000));
    expect(lock).toBeDefined();
    expect(updateMock).toHaveBeenCalledOnce();
  });

  it('second lock: insertRecord false, updateRecord false → undefined', async () => {
    const { accessor } = makeAccessor({ updateReturn: false });
    const provider = new StorageBasedLockProvider(accessor);
    const lock = await provider.lock(createLockConfig('t', 1000));
    expect(lock).toBeUndefined();
  });

  it('updateRecord throws after fresh insert → cache cleared, throws', async () => {
    const { accessor, insertMock, updateMock } = makeAccessor({ updateThrows: true });
    const provider = new StorageBasedLockProvider(accessor);
    await expect(provider.lock(createLockConfig('t', 1000))).rejects.toThrow('storage-failure');
    expect(insertMock).toHaveBeenCalledOnce();
    expect(updateMock).toHaveBeenCalledOnce();
    provider.clearCache('t');
    await expect(provider.lock(createLockConfig('t', 1000))).rejects.toThrow('storage-failure');
    expect(insertMock).toHaveBeenCalledTimes(2);
  });

  it('StorageLock.unlock calls accessor.unlock', async () => {
    const { accessor, unlockMock } = makeAccessor({ insertReturn: true });
    const provider = new StorageBasedLockProvider(accessor);
    const lock = (await provider.lock(createLockConfig('t', 1000)))!;
    await lock.unlock();
    expect(unlockMock).toHaveBeenCalledOnce();
  });

  it('StorageLock.extend true → new lock; false → undefined', async () => {
    const { accessor, extendMock } = makeAccessor({ insertReturn: true, extendReturn: true });
    const provider = new StorageBasedLockProvider(accessor);
    const lock = (await provider.lock(createLockConfig('t', 1000)))!;
    const extended = await lock.extend(2000, 0);
    expect(extended).toBeDefined();
    expect(extendMock).toHaveBeenCalledOnce();
  });

  it('StorageLock.extend false → undefined', async () => {
    const { accessor } = makeAccessor({ insertReturn: true, extendReturn: false });
    const provider = new StorageBasedLockProvider(accessor);
    const lock = (await provider.lock(createLockConfig('t', 1000)))!;
    const extended = await lock.extend(2000, 0);
    expect(extended).toBeUndefined();
  });
});
