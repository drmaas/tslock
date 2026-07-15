import { ClockProvider, createLockConfig } from '@tslock/core';
import type { Collection, Document } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { describe, expect, it, vi } from 'vitest';
import type { MongoLockDocument } from '../src/mongo-lock-document.js';
import { MongoLockProvider } from '../src/mongo-lock-provider.js';

function makeCol(overrides: Record<string, unknown> = {}): Collection<MongoLockDocument> {
  return {
    findOneAndUpdate: vi
      .fn()
      .mockResolvedValue({ _id: 'test', lockUntil: new Date(), lockedAt: new Date(), lockedBy: 'host' }),
    ...overrides,
  } as unknown as Collection<MongoLockDocument>;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('MongoLockProvider', () => {
  it('lock() returns lock when findOneAndUpdate returns a doc', async () => {
    const col = makeCol();
    const provider = new MongoLockProvider(col);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
  });

  it('lock() returns undefined when findOneAndUpdate returns null', async () => {
    const col = makeCol({ findOneAndUpdate: vi.fn().mockResolvedValue(null) });
    const provider = new MongoLockProvider(col);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() returns undefined on duplicate key (code 11000)', async () => {
    const col = makeCol({
      findOneAndUpdate: vi.fn().mockRejectedValue(new MongoServerError({ code: 11000 } as unknown as Document)),
    });
    const provider = new MongoLockProvider(col);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() propagates non-11000 errors', async () => {
    const col = makeCol({ findOneAndUpdate: vi.fn().mockRejectedValue(new Error('network')) });
    const provider = new MongoLockProvider(col);
    await expect(provider.lock(config())).rejects.toThrow('network');
  });

  it('lock() passes correct filter with $lte on lockUntil', async () => {
    const fn = vi.fn().mockResolvedValue({ _id: 't', lockUntil: new Date(), lockedAt: new Date(), lockedBy: 'h' });
    const col = makeCol({ findOneAndUpdate: fn });
    const provider = new MongoLockProvider(col);
    ClockProvider.setClock(() => 5_000_000);
    await provider.lock(createLockConfig('my-lock', 10_000));
    const filter = fn.mock.calls[0][0];
    expect(filter._id).toBe('my-lock');
    expect(filter.lockUntil.$lte).toBeInstanceOf(Date);
  });

  it('unlock() works', async () => {
    const col = makeCol();
    const provider = new MongoLockProvider(col);
    const lock = (await provider.lock(config()))!;
    await lock.unlock();
  });

  it('extend() returns new lock on success', async () => {
    const col = makeCol();
    const provider = new MongoLockProvider(col);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
  });

  it('extend() returns undefined when null result', async () => {
    const col = makeCol({
      findOneAndUpdate: vi
        .fn()
        .mockResolvedValueOnce({ _id: 't', lockUntil: new Date(), lockedAt: new Date(), lockedBy: 'h' })
        .mockResolvedValue(null),
    });
    const provider = new MongoLockProvider(col);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('unlock after extend throws on original lock', async () => {
    const col = makeCol();
    const provider = new MongoLockProvider(col);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    await expect(lock.unlock()).rejects.toThrow('Lock has already been released or extended');
  });
});
