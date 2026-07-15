import type { Database } from '@google-cloud/spanner';
import { ClockProvider, createLockConfig } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import type { SpannerColumnNames } from '../src/spanner-configuration.js';
import { SpannerStorageAccessor } from '../src/spanner-storage-accessor.js';

const NOW = 1_000_000;

interface MockTransaction {
  insert: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  read: ReturnType<typeof vi.fn>;
  runUpdate: ReturnType<typeof vi.fn>;
  commit: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

interface MockDatabase {
  runTransactionAsync: ReturnType<typeof vi.fn>;
  [key: string]: unknown;
}

function makeDb(overrides: Record<string, unknown> = {}): MockDatabase {
  const runTransactionAsync = vi.fn();
  return { runTransactionAsync, ...overrides } as MockDatabase;
}

function makeTx(overrides: Record<string, unknown> = {}): MockTransaction {
  const insert = vi.fn();
  const update = vi.fn();
  const read = vi.fn();
  const runUpdate = vi.fn();
  const commit = vi.fn().mockResolvedValue(undefined);
  return {
    insert,
    update,
    read,
    runUpdate,
    commit,
    ...overrides,
  } as MockTransaction;
}

function cols(overrides?: Partial<SpannerColumnNames>): SpannerColumnNames {
  return {
    name: 'name',
    lockUntil: 'lockUntil',
    lockedAt: 'lockedAt',
    lockedBy: 'lockedBy',
    ...overrides,
  };
}

function cfg(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => NOW);
  return createLockConfig(name, most, least);
}

async function runTx(tx: MockTransaction, fn: (t: MockTransaction) => Promise<unknown>): Promise<unknown> {
  const result = await fn(tx);
  return result;
}

describe('SpannerStorageAccessor', () => {
  describe('insertRecord', () => {
    it('returns true on success', async () => {
      const tx = makeTx();
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.insertRecord(cfg())).toBe(true);
      expect(tx.insert).toHaveBeenCalledOnce();
      expect(tx.commit).toHaveBeenCalledOnce();
    });

    it('returns false on ALREADY_EXISTS (code 6)', async () => {
      const tx = makeTx();
      tx.commit.mockRejectedValue({ code: 6 });
      const db = makeDb({
        runTransactionAsync: vi.fn().mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => {
          return await runTx(tx, fn);
        }),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.insertRecord(cfg())).toBe(false);
    });

    it('returns false on FAILED_PRECONDITION (code 9)', async () => {
      const tx = makeTx();
      tx.commit.mockRejectedValue({ code: 9, message: 'already exists' });
      const db = makeDb({
        runTransactionAsync: vi.fn().mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => {
          return await runTx(tx, fn);
        }),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.insertRecord(cfg())).toBe(false);
    });

    it('propagates other errors', async () => {
      const tx = makeTx();
      tx.commit.mockRejectedValue(new Error('network error'));
      const db = makeDb({
        runTransactionAsync: vi.fn().mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => {
          return await runTx(tx, fn);
        }),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      await expect(accessor.insertRecord(cfg())).rejects.toThrow('network error');
    });

    it('uses correct columns and values in insert', async () => {
      const tx = makeTx();
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      await accessor.insertRecord(cfg('my-lock', 30_000));
      expect(tx.insert).toHaveBeenCalledWith(
        'shedlock',
        expect.objectContaining({
          name: 'my-lock',
          lockedBy: 'my-host',
        }),
      );
    });

    it('uses custom column names', async () => {
      const tx = makeTx();
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(
        db as unknown as Database,
        'custom_table',
        cols({ name: 'n', lockUntil: 'lu', lockedAt: 'la', lockedBy: 'lb' }),
        'host1',
      );
      await accessor.insertRecord(cfg('test'));
      expect(tx.insert).toHaveBeenCalledWith('custom_table', {
        n: 'test',
        lu: expect.any(String),
        la: expect.any(String),
        lb: 'host1',
      });
    });
  });

  describe('updateRecord', () => {
    it('returns true when lock expired and update succeeds', async () => {
      const tx = makeTx();
      tx.read.mockResolvedValue([[{ lockUntil: '1970-01-01T00:00:00.500Z' }]]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.updateRecord(cfg())).toBe(true);
      expect(tx.update).toHaveBeenCalledOnce();
      expect(tx.commit).toHaveBeenCalledOnce();
    });

    it('returns false when lock still held', async () => {
      const tx = makeTx();
      tx.read.mockResolvedValue([[{ lockUntil: '2000-01-01T00:00:00.000Z' }]]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.updateRecord(cfg())).toBe(false);
      expect(tx.update).not.toHaveBeenCalled();
    });

    it('returns false when row missing', async () => {
      const tx = makeTx();
      tx.read.mockResolvedValue([[]]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.updateRecord(cfg())).toBe(false);
      expect(tx.update).not.toHaveBeenCalled();
    });
  });

  describe('unlock', () => {
    it('resolves without error on success', async () => {
      const tx = makeTx();
      tx.runUpdate.mockResolvedValue([1]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      await expect(accessor.unlock(cfg())).resolves.toBeUndefined();
      expect(tx.commit).toHaveBeenCalledOnce();
    });

    it('resolves when 0 rows affected (no-op)', async () => {
      const tx = makeTx();
      tx.runUpdate.mockResolvedValue([0]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      await expect(accessor.unlock(cfg())).resolves.toBeUndefined();
    });

    it('generates SQL with backtick-quoted identifiers', async () => {
      const tx = makeTx();
      const captured: { sql: string; params?: Record<string, unknown> }[] = [];
      tx.runUpdate.mockImplementation((q: { sql: string; params?: Record<string, unknown> }) => {
        captured.push(q);
        return [1];
      });
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(
        db as unknown as Database,
        'shedlock',
        cols({ name: 'n', lockUntil: 'lu', lockedBy: 'lb' }),
        'my-host',
      );
      await accessor.unlock(cfg('test'));
      expect(captured[0].sql).toContain('UPDATE `shedlock`');
      expect(captured[0].sql).toContain('SET `lu` = @unlockTime');
      expect(captured[0].sql).toContain('WHERE `n` = @name');
      expect(captured[0].sql).toContain('AND `lb` = @lockedBy');
      expect(captured[0].params).toMatchObject({
        unlockTime: expect.any(String),
        name: 'test',
        lockedBy: 'my-host',
      });
    });
  });

  describe('extend', () => {
    it('returns true when row count > 0', async () => {
      const tx = makeTx();
      tx.runUpdate.mockResolvedValue([1]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.extend(cfg())).toBe(true);
      expect(tx.commit).toHaveBeenCalledOnce();
    });

    it('returns false when row count is 0', async () => {
      const tx = makeTx();
      tx.runUpdate.mockResolvedValue([0]);
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      expect(await accessor.extend(cfg())).toBe(false);
    });

    it('includes lockUntil > @now condition', async () => {
      const tx = makeTx();
      const captured: { sql: string; params?: Record<string, unknown> }[] = [];
      tx.runUpdate.mockImplementation((q: { sql: string; params?: Record<string, unknown> }) => {
        captured.push(q);
        return [1];
      });
      const db = makeDb({
        runTransactionAsync: vi
          .fn()
          .mockImplementation(async (fn: (...args: unknown[]) => Promise<unknown>) => await runTx(tx, fn)),
      });
      const accessor = new SpannerStorageAccessor(db as unknown as Database, 'shedlock', cols(), 'my-host');
      await accessor.extend(cfg());
      expect(captured[0].sql).toContain('AND `lockUntil` > @now');
      expect(captured[0].params).toMatchObject({
        lockUntil: expect.any(String),
        name: 'test',
        lockedBy: 'my-host',
        now: expect.any(String),
      });
    });
  });
});
