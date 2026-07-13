import { createLockConfig } from '@tslock/core';
import { DatabaseProduct, DefaultSqlStatementsSource, SqlConfiguration } from '@tslock/sql-support';
import type { CompiledQuery, Kysely } from 'kysely';
import { describe, expect, it, vi } from 'vitest';
import { getDialectInfo } from '../src/dialect-info.js';
import { KyselyStorageAccessor } from '../src/kysely-storage-accessor.js';

function makeDb(affectedRows: number | bigint): Kysely<unknown> {
  return {
    executeQuery: vi.fn().mockResolvedValue({ numAffectedRows: affectedRows }),
  } as unknown as Kysely<unknown>;
}

function makeDbThrowing(error: unknown): Kysely<unknown> {
  return {
    executeQuery: vi.fn().mockRejectedValue(error),
  } as unknown as Kysely<unknown>;
}

describe('KyselyStorageAccessor', () => {
  const source = new DefaultSqlStatementsSource(new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }));
  const dialect = getDialectInfo('postgresql');

  it('insertRecord returns true when affectedRows > 0', async () => {
    const db = makeDb(1);
    const accessor = new KyselyStorageAccessor(db, source, dialect);
    expect(await accessor.insertRecord(createLockConfig('t', 1000))).toBe(true);
  });

  it('insertRecord returns false when affectedRows === 0', async () => {
    const db = makeDb(0);
    const accessor = new KyselyStorageAccessor(db, source, dialect);
    expect(await accessor.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord returns false on duplicate key (pg 23505)', async () => {
    const db = makeDbThrowing({ code: '23505' });
    const accessor = new KyselyStorageAccessor(db, source, dialect);
    expect(await accessor.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord rethrows non-duplicate errors', async () => {
    const db = makeDbThrowing(new Error('connection lost'));
    const accessor = new KyselyStorageAccessor(db, source, dialect);
    await expect(accessor.insertRecord(createLockConfig('t', 1000))).rejects.toThrow('connection lost');
  });

  it('updateRecord returns true/false based on affectedRows', async () => {
    const dbTrue = makeDb(1);
    const dbFalse = makeDb(0);
    const accTrue = new KyselyStorageAccessor(dbTrue, source, dialect);
    const accFalse = new KyselyStorageAccessor(dbFalse, source, dialect);
    expect(await accTrue.updateRecord(createLockConfig('t', 1000))).toBe(true);
    expect(await accFalse.updateRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('extend returns true/false', async () => {
    const accTrue = new KyselyStorageAccessor(makeDb(1), source, dialect);
    const accFalse = new KyselyStorageAccessor(makeDb(0), source, dialect);
    expect(await accTrue.extend(createLockConfig('t', 1000))).toBe(true);
    expect(await accFalse.extend(createLockConfig('t', 1000))).toBe(false);
  });

  it('unlock calls executeQuery and returns void', async () => {
    const db = makeDb(0);
    const accessor = new KyselyStorageAccessor(db, source, dialect);
    await expect(accessor.unlock(createLockConfig('t', 1000))).resolves.toBeUndefined();
  });

  it('passes translated SQL and values to db.executeQuery', async () => {
    const executeQuery = vi.fn().mockResolvedValue({ numAffectedRows: 1 });
    const db = { executeQuery } as unknown as Kysely<unknown>;
    const accessor = new KyselyStorageAccessor(db, source, dialect);
    await accessor.insertRecord(createLockConfig('t', 1000));
    expect(executeQuery).toHaveBeenCalledOnce();
    const compiled = executeQuery.mock.calls[0]?.[0] as ReturnType<typeof CompiledQuery.raw>;
    expect(compiled.sql).toContain('INSERT INTO shedlock');
    expect(compiled.sql).toContain('$1');
  });
});
