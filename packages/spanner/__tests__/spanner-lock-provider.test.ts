import { ClockProvider, StorageBasedLockProvider, createLockConfig } from '@tslock/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SpannerColumnNames } from '../src/spanner-configuration.js';

const NOW = 1_000_000;

function _cols(overrides?: Partial<SpannerColumnNames>): SpannerColumnNames {
  return { name: 'name', lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy', ...overrides };
}

function cfg(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => NOW);
  return createLockConfig(name, most, least);
}

interface MockStorageAccessor {
  insertRecord: ReturnType<typeof vi.fn>;
  updateRecord: ReturnType<typeof vi.fn>;
  unlock: ReturnType<typeof vi.fn>;
  extend: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

function makeAccessor(overrides?: Record<string, unknown>): MockStorageAccessor {
  const insertRecord = vi.fn();
  const updateRecord = vi.fn();
  const unlock = vi.fn();
  const extend = vi.fn();
  return { insertRecord, updateRecord, unlock, extend, ...overrides } as MockStorageAccessor;
}

describe('SpannerLockProvider', () => {
  let accessor: MockStorageAccessor;
  let provider: StorageBasedLockProvider;

  beforeEach(() => {
    accessor = makeAccessor();
    provider = new StorageBasedLockProvider(accessor);
  });

  it('acquires lock on first insert', async () => {
    accessor.insertRecord.mockResolvedValue(true);
    const lock = await provider.lock(cfg());
    expect(lock).toBeDefined();
    expect(accessor.insertRecord).toHaveBeenCalledOnce();
    expect(accessor.updateRecord).not.toHaveBeenCalled();
  });

  it('calls updateRecord when insertRecord returns false', async () => {
    accessor.insertRecord.mockResolvedValue(false);
    accessor.updateRecord.mockResolvedValue(true);
    const lock = await provider.lock(cfg());
    expect(lock).toBeDefined();
    expect(accessor.insertRecord).toHaveBeenCalledOnce();
    expect(accessor.updateRecord).toHaveBeenCalledOnce();
  });

  it('returns undefined when both insert and update fail', async () => {
    accessor.insertRecord.mockResolvedValue(false);
    accessor.updateRecord.mockResolvedValue(false);
    const lock = await provider.lock(cfg());
    expect(lock).toBeUndefined();
  });

  it('clears cache when updateRecord throws after fresh insert', async () => {
    ClockProvider.setClock(() => NOW);
    const insertSpy = vi.fn().mockResolvedValueOnce(false).mockResolvedValue(true);
    const updateSpy = vi.fn().mockRejectedValueOnce(new Error('db error'));
    accessor.insertRecord = insertSpy;
    accessor.updateRecord = updateSpy;

    await expect(provider.lock(cfg())).rejects.toThrow('db error');
    expect(insertSpy).toHaveBeenCalledTimes(1);
    expect(updateSpy).toHaveBeenCalledTimes(1);

    const lock2 = await provider.lock(cfg());
    expect(lock2).toBeDefined();
    expect(insertSpy).toHaveBeenCalledTimes(2);
  });

  it('unlock delegates to accessor', async () => {
    accessor.insertRecord.mockResolvedValue(true);
    accessor.unlock.mockResolvedValue(undefined);
    const lock = await provider.lock(cfg());
    await lock?.unlock();
    expect(accessor.unlock).toHaveBeenCalledOnce();
  });

  it('extend returns new lock on success', async () => {
    accessor.insertRecord.mockResolvedValue(true);
    accessor.extend.mockResolvedValue(true);
    const lock = await provider.lock(cfg());
    const extended = await lock?.extend(30_000, 0);
    expect(extended).toBeDefined();
    expect(accessor.extend).toHaveBeenCalledOnce();
  });

  it('extend returns undefined on failure', async () => {
    accessor.insertRecord.mockResolvedValue(true);
    accessor.extend.mockResolvedValue(false);
    const lock = await provider.lock(cfg());
    const extended = await lock?.extend(30_000, 0);
    expect(extended).toBeUndefined();
  });

  it('double unlock throws LockException', async () => {
    accessor.insertRecord.mockResolvedValue(true);
    accessor.unlock.mockResolvedValue(undefined);
    const lock = await provider.lock(cfg());
    await lock?.unlock();
    await expect(lock?.unlock()).rejects.toThrow();
  });
});
