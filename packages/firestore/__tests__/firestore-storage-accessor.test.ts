import { ClockProvider, createLockConfig } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { FirestoreStorageAccessor } from '../src/firestore-storage-accessor.js';

const NOW = 1_000_000;

function makeFirestore(overrides: Record<string, any> = {}) {
  const runTransaction = vi.fn();
  const doc = vi.fn((name: string) => ({ id: name }));
  const collection = vi.fn(() => ({ doc }));
  return { runTransaction, collection, ...overrides } as any;
}

function makeSnapshot(exists: boolean, data: Record<string, any> = {}) {
  return {
    exists,
    get: vi.fn((field: string) => data[field]),
  } as any;
}

function makeTxn(overrides: Record<string, any> = {}) {
  const get = vi.fn();
  const create = vi.fn();
  const update = vi.fn();
  return { get, create, update, ...overrides } as any;
}

function cfg(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => NOW);
  return createLockConfig(name, most, least);
}

function makeAccessor(overrides?: Record<string, any>) {
  return new FirestoreStorageAccessor(
    overrides?.firestore ?? makeFirestore(),
    overrides?.collectionName ?? 'shedlock',
    overrides?.fieldNames ?? { lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy' },
    overrides?.lockedByValue ?? 'my-host',
    overrides?.useTimestamps ?? false,
  );
}

describe('FirestoreStorageAccessor', () => {
  describe('insertRecord', () => {
    it('returns true when document does not exist', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore });
      expect(await accessor.insertRecord(cfg())).toBe(true);
      expect(txn.create).toHaveBeenCalledOnce();
    });

    it('returns false when document already exists', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(true)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore });
      expect(await accessor.insertRecord(cfg())).toBe(false);
      expect(txn.create).not.toHaveBeenCalled();
    });

    it('writes correct data on insert', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'host1' });
      await accessor.insertRecord(cfg('my-lock', 30_000));
      expect(txn.create).toHaveBeenCalledWith(expect.anything(), {
        lockUntil: expect.any(String),
        lockedAt: expect.any(String),
        lockedBy: 'host1',
      });
    });
  });

  describe('updateRecord', () => {
    it('returns true when lock expired', async () => {
      const txn = makeTxn({
        get: vi.fn().mockResolvedValue(makeSnapshot(true, { lockUntil: '1970-01-01T00:00:00.500Z' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore });
      expect(await accessor.updateRecord(cfg())).toBe(true);
      expect(txn.update).toHaveBeenCalledOnce();
    });

    it('returns false when lock still held', async () => {
      const txn = makeTxn({
        get: vi.fn().mockResolvedValue(makeSnapshot(true, { lockUntil: '2000-01-01T00:00:00.000Z' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore });
      expect(await accessor.updateRecord(cfg())).toBe(false);
      expect(txn.update).not.toHaveBeenCalled();
    });

    it('returns false when document missing', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore });
      expect(await accessor.updateRecord(cfg())).toBe(false);
      expect(txn.update).not.toHaveBeenCalled();
    });
  });

  describe('unlock', () => {
    it('updates lockUntil on match', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      await accessor.unlock(cfg());
      expect(txn.update).toHaveBeenCalledOnce();
    });

    it('skips when lockedBy mismatch', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'other-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      await accessor.unlock(cfg());
      expect(txn.update).not.toHaveBeenCalled();
    });

    it('skips when lock expired (lockUntil < now)', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '1970-01-01T00:00:00.500Z', lockedBy: 'my-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      await accessor.unlock(cfg());
      expect(txn.update).not.toHaveBeenCalled();
    });

    it('skips when document missing', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore });
      await accessor.unlock(cfg());
      expect(txn.update).not.toHaveBeenCalled();
    });
  });

  describe('extend', () => {
    it('returns true on success', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(true);
      expect(txn.update).toHaveBeenCalledOnce();
    });

    it('returns false when lockedBy mismatch', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'other-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(false);
      expect(txn.update).not.toHaveBeenCalled();
    });

    it('returns false when lock expired', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '1970-01-01T00:00:00.500Z', lockedBy: 'my-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(false);
      expect(txn.update).not.toHaveBeenCalled();
    });

    it('returns false when document missing', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(false);
      expect(txn.update).not.toHaveBeenCalled();
    });
  });

  describe('field encoding', () => {
    it('writes ISO strings by default', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, useTimestamps: false });
      await accessor.insertRecord(cfg());
      const data = txn.create.mock.calls[0][1];
      expect(typeof data.lockUntil).toBe('string');
      expect(typeof data.lockedAt).toBe('string');
    });

    it('writes Timestamp objects when useTimestamps is true', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, useTimestamps: true });
      await accessor.insertRecord(cfg());
      const data = txn.create.mock.calls[0][1];
      expect(typeof data.lockUntil).toBe('object');
      expect(typeof (data.lockUntil as any).toMillis).toBe('function');
      expect(typeof data.lockedAt).toBe('object');
      expect(typeof (data.lockedAt as any).toMillis).toBe('function');
    });

    it('parses ISO strings correctly', async () => {
      const txn = makeTxn({
        get: vi
          .fn()
          .mockResolvedValue(makeSnapshot(true, { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host' })),
      });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({ firestore, lockedByValue: 'my-host', useTimestamps: false });
      expect(await accessor.extend(cfg())).toBe(true);
      expect(txn.update).toHaveBeenCalledOnce();
    });
  });

  describe('custom configuration', () => {
    it('uses custom collection name and field names', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue(makeSnapshot(false)) });
      const firestore = makeFirestore({ runTransaction: vi.fn().mockImplementation(async (fn: any) => await fn(txn)) });
      const accessor = makeAccessor({
        firestore,
        collectionName: 'locks',
        fieldNames: { lockUntil: 'lu', lockedAt: 'la', lockedBy: 'lb' },
        lockedByValue: 'custom-host',
      });
      await accessor.insertRecord(cfg('test'));
      expect(txn.create).toHaveBeenCalledWith(expect.anything(), {
        lu: expect.any(String),
        la: expect.any(String),
        lb: 'custom-host',
      });
    });
  });
});
