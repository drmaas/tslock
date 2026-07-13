import { ClockProvider, createLockConfig, Utils } from '@tslock/core';
import type { DocumentCollection, EdgeCollection } from 'arangojs/collection';
import type { Database } from 'arangojs/database';
import { describe, expect, it, vi } from 'vitest';
import { ArangoDbLockProvider } from '../src/arangodb-lock-provider.js';

type ArangoCollection<T> = DocumentCollection<T> & EdgeCollection<T>;

function makeTxn(overrides: Record<string, any> = {}) {
  return {
    step: vi.fn().mockImplementation((fn: Function) => fn()),
    commit: vi.fn().mockResolvedValue(undefined),
    abort: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeDb(txn?: any): Database {
  const t = txn ?? makeTxn();
  return { beginTransaction: vi.fn().mockResolvedValue(t) } as any;
}

function makeCol(overrides: Record<string, any> = {}): ArangoCollection<any> {
  return {
    name: 'shedLock',
    document: vi.fn(),
    save: vi.fn().mockResolvedValue({}),
    update: vi.fn().mockResolvedValue({}),
    ...overrides,
  } as any;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('ArangoDbLockProvider', () => {
  it('lock() acquires first lock when doc not found', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(col.save).toHaveBeenCalledWith(expect.objectContaining({ _key: 'test' }));
    expect(txn.commit).toHaveBeenCalled();
    expect(txn.abort).not.toHaveBeenCalled();
  });

  it('lock() acquires expired lock when doc exists with past lockUntil', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockResolvedValue({
        _key: 'test',
        lockUntil: '1970-01-01T00:00:00.000Z',
        lockedAt: '1970-01-01T00:00:00.000Z',
        lockedBy: 'other',
      }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(col.update).toHaveBeenCalled();
    expect(txn.commit).toHaveBeenCalled();
    expect(txn.abort).not.toHaveBeenCalled();
  });

  it('lock() returns undefined when lock is held', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockResolvedValue({
        _key: 'test',
        lockUntil: '2999-01-01T00:00:00.000Z',
        lockedAt: '2999-01-01T00:00:00.000Z',
        lockedBy: 'other',
      }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
    expect(txn.abort).toHaveBeenCalled();
    expect(col.save).not.toHaveBeenCalled();
    expect(col.update).not.toHaveBeenCalled();
  });

  it('lock() aborts and propagates non-1202 errors from document()', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    await expect(provider.lock(config())).rejects.toThrow('network error');
    expect(txn.abort).toHaveBeenCalled();
  });

  it('lock() calls beginTransaction with exclusive', async () => {
    const txn = makeTxn();
    const db = makeDb(txn);
    const col = makeCol({
      document: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
    });
    const provider = new ArangoDbLockProvider(col, db);
    await provider.lock(config('test', 60_000));
    expect(db.beginTransaction).toHaveBeenCalledWith({
      exclusive: ['shedLock'],
    });
  });

  it('lock() uses step for document operations in transaction', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    await provider.lock(config());
    expect(txn.step).toHaveBeenCalled();
  });

  it('extend() returns undefined when doc not found', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi
        .fn()
        .mockRejectedValueOnce({ errorNum: 1202, name: 'ArangoError' })
        .mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    const extended = await lock!.extend(60_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() returns undefined when lockedBy does not match', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValueOnce({ errorNum: 1202, name: 'ArangoError' }).mockResolvedValue({
        _key: 'test',
        lockUntil: '2999-01-01T00:00:00.000Z',
        lockedAt: '2999-01-01T00:00:00.000Z',
        lockedBy: 'other-host',
      }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    const extended = await lock!.extend(60_000, 0);
    expect(extended).toBeUndefined();
    expect(col.update).not.toHaveBeenCalled();
  });

  it('extend() returns undefined when lock is expired', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValueOnce({ errorNum: 1202, name: 'ArangoError' }).mockResolvedValue({
        _key: 'test',
        lockUntil: '1970-01-01T00:00:00.000Z',
        lockedAt: '1970-01-01T00:00:00.000Z',
        lockedBy: 'hostname',
      }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    const extended = await lock!.extend(60_000, 0);
    expect(extended).toBeUndefined();
    expect(col.update).not.toHaveBeenCalled();
  });

  it('extend() succeeds when conditions are met', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('hostname');
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValueOnce({ errorNum: 1202, name: 'ArangoError' }).mockResolvedValue({
        _key: 'test',
        lockUntil: '2999-01-01T00:00:00.000Z',
        lockedAt: '2999-01-01T00:00:00.000Z',
        lockedBy: 'hostname',
        _rev: 'abc123',
      }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    const extended = await lock!.extend(60_000, 0);
    expect(extended).toBeDefined();
    expect(col.update).toHaveBeenCalled();
  });

  it('unlock() calls update with unlockTime', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = (await provider.lock(config()))!;
    await lock.unlock();
    expect(col.update).toHaveBeenCalledWith('test', expect.objectContaining({ lockUntil: expect.any(String) }));
  });

  it('unlock() swallows document-not-found errors', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
      update: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
  });

  it('unlock() propagates non-1202 errors', async () => {
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValue({ errorNum: 1202, name: 'ArangoError' }),
      update: vi.fn().mockRejectedValue(new Error('network error')),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('network error');
  });

  it('unlock after extend throws on original lock', async () => {
    vi.spyOn(Utils, 'getHostname').mockReturnValue('hostname');
    const txn = makeTxn();
    const col = makeCol({
      document: vi.fn().mockRejectedValueOnce({ errorNum: 1202, name: 'ArangoError' }).mockResolvedValue({
        _key: 'test',
        lockUntil: '2999-01-01T00:00:00.000Z',
        lockedAt: '2999-01-01T00:00:00.000Z',
        lockedBy: 'hostname',
        _rev: 'abc123',
      }),
    });
    const db = makeDb(txn);
    const provider = new ArangoDbLockProvider(col, db);
    const lock = (await provider.lock(config()))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    await expect(lock.unlock()).rejects.toThrow('Lock has already been released or extended');
  });
});
