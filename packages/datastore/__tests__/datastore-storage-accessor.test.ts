import type { Datastore, Transaction } from '@google-cloud/datastore';
import { ClockProvider, createLockConfig } from '@tslock/core';
import { type MockInstance, describe, expect, it, vi } from 'vitest';
import type { DatastoreFieldNames } from '../src/datastore-configuration.js';
import { DatastoreStorageAccessor } from '../src/datastore-storage-accessor.js';

const NOW = 1_000_000;

function makeDatastore(overrides: Record<string, unknown> = {}) {
  const runTransaction = vi.fn();
  const key = vi.fn((parts: string[]) => ({ kind: parts[0], name: parts[1] }));
  return { runTransaction, key, ...overrides } as unknown as Datastore;
}

function makeTxn(overrides: Record<string, unknown> = {}) {
  const get = vi.fn();
  const upsert = vi.fn();
  return { get, upsert, ...overrides } as unknown as Transaction;
}

function cfg(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => NOW);
  return createLockConfig(name, most, least);
}

function makeAccessor(overrides?: {
  datastore?: Datastore;
  entityName?: string;
  fieldNames?: DatastoreFieldNames;
  lockedByValue?: string;
  useDate?: boolean;
}) {
  return new DatastoreStorageAccessor(
    overrides?.datastore ?? makeDatastore(),
    overrides?.entityName ?? 'shedlock',
    overrides?.fieldNames ?? { lockUntil: 'lockUntil', lockedAt: 'lockedAt', lockedBy: 'lockedBy' },
    overrides?.lockedByValue ?? 'my-host',
    overrides?.useDate ?? false,
  );
}

describe('DatastoreStorageAccessor', () => {
  describe('insertRecord', () => {
    it('returns true when entity does not exist', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.insertRecord(cfg())).toBe(true);
      expect(txn.upsert).toHaveBeenCalledOnce();
    });

    it('returns false when entity already exists', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([{ lockUntil: '2999-01-01T00:00:00.000Z' }]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.insertRecord(cfg())).toBe(false);
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('writes correct data on insert', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'host1' });
      await accessor.insertRecord(cfg('my-lock', 30_000));
      expect(txn.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            lockUntil: expect.any(String),
            lockedAt: expect.any(String),
            lockedBy: 'host1',
          },
        }),
      );
    });
  });

  describe('updateRecord', () => {
    it('returns true when lock expired', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([{ lockUntil: '1970-01-01T00:00:00.500Z' }]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.updateRecord(cfg())).toBe(true);
      expect(txn.upsert).toHaveBeenCalledOnce();
    });

    it('returns false when lock still held', async () => {
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([{ lockUntil: '2000-01-01T00:00:00.000Z' }]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.updateRecord(cfg())).toBe(false);
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('returns false when entity missing', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.updateRecord(cfg())).toBe(false);
      expect(txn.upsert).not.toHaveBeenCalled();
    });
  });

  describe('unlock', () => {
    it('updates lockUntil on match', async () => {
      const entity = { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      await accessor.unlock(cfg());
      expect(txn.upsert).toHaveBeenCalledOnce();
    });

    it('skips when lockedBy mismatch', async () => {
      const entity = { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'other-host' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      await accessor.unlock(cfg());
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('skips when entity missing', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      await accessor.unlock(cfg());
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('preserves extra fields via spread', async () => {
      const entity = { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host', foo: 'bar' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      await accessor.unlock(cfg());
      expect(txn.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ foo: 'bar' }),
        }),
      );
    });
  });

  describe('extend', () => {
    it('returns true on success', async () => {
      const entity = { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(true);
      expect(txn.upsert).toHaveBeenCalledOnce();
    });

    it('returns false when lockedBy mismatch', async () => {
      const entity = { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'other-host' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(false);
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('returns false when lock expired', async () => {
      const entity = { lockUntil: '1970-01-01T00:00:00.500Z', lockedBy: 'my-host' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(false);
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('returns false when entity missing', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      expect(await accessor.extend(cfg())).toBe(false);
      expect(txn.upsert).not.toHaveBeenCalled();
    });

    it('preserves extra fields via spread', async () => {
      const entity = { lockUntil: '2999-01-01T00:00:00.000Z', lockedBy: 'my-host', foo: 'bar' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host' });
      await accessor.extend(cfg());
      expect(txn.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ foo: 'bar' }),
        }),
      );
    });
  });

  describe('safeGet / NOT_FOUND handling', () => {
    it('returns undefined on code 5 error', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.insertRecord(cfg())).toBe(true);
    });

    it('returns undefined on message-based not found', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue(new Error('No entity found')) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      expect(await accessor.insertRecord(cfg())).toBe(true);
    });

    it('propagates non-NOT_FOUND errors', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue(new Error('permission denied')) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore });
      await expect(accessor.updateRecord(cfg())).rejects.toThrow('permission denied');
    });
  });

  describe('field encoding', () => {
    it('writes ISO strings by default', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, useDate: false });
      await accessor.insertRecord(cfg());
      const data = (txn.upsert as unknown as MockInstance).mock.calls[0][0].data as Record<string, unknown>;
      expect(typeof data.lockUntil).toBe('string');
      expect(typeof data.lockedAt).toBe('string');
    });

    it('writes Date objects when useDate is true', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, useDate: true });
      await accessor.insertRecord(cfg());
      const data = (txn.upsert as unknown as MockInstance).mock.calls[0][0].data as Record<string, unknown>;
      expect(data.lockUntil instanceof Date).toBe(true);
      expect(data.lockedAt instanceof Date).toBe(true);
    });

    it('parseFieldValue handles Date objects', async () => {
      const now = Date.now();
      const entity = { lockUntil: new Date(now + 60_000), lockedBy: 'my-host' };
      const txn = makeTxn({ get: vi.fn().mockResolvedValue([entity]) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({ datastore, lockedByValue: 'my-host', useDate: true });
      expect(await accessor.extend(cfg())).toBe(true);
      expect(txn.upsert).toHaveBeenCalledOnce();
    });
  });

  describe('custom configuration', () => {
    it('uses custom entity name and field names', async () => {
      const txn = makeTxn({ get: vi.fn().mockRejectedValue({ code: 5 }) });
      const datastore = makeDatastore({
        runTransaction: vi.fn().mockImplementation(async (fn: (t: Transaction) => Promise<unknown>) => await fn(txn)),
      });
      const accessor = makeAccessor({
        datastore,
        entityName: 'locks',
        fieldNames: { lockUntil: 'lu', lockedAt: 'la', lockedBy: 'lb' },
        lockedByValue: 'custom-host',
      });
      await accessor.insertRecord(cfg('test'));
      expect(txn.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            lu: expect.any(String),
            la: expect.any(String),
            lb: 'custom-host',
          },
        }),
      );
    });
  });
});
