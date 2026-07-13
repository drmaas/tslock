import { createLockConfig } from '@tslock/core';
import { DatabaseProduct, DefaultSqlStatementsSource, SqlConfiguration } from '@tslock/sql-support';
import { describe, expect, it, vi } from 'vitest';
import { DRIZZLE_DIALECT_INFOS } from '../src/drizzle-lock-provider.js';
import { type DrizzleExecutor, DrizzleStorageAccessor } from '../src/drizzle-storage-accessor.js';

function makeDb(
  affected: number | { affectedRows?: number; rowCount?: number; changes?: number },
  throwError?: unknown,
): { db: DrizzleExecutor; executeMock: ReturnType<typeof vi.fn> } {
  const executeMock = vi.fn();
  if (throwError) {
    executeMock.mockRejectedValue(throwError);
  } else if (typeof affected === 'number') {
    executeMock.mockResolvedValue({ affectedRows: affected });
  } else {
    executeMock.mockResolvedValue(affected);
  }
  return { db: { execute: executeMock }, executeMock };
}

const source = new DefaultSqlStatementsSource(new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES }));
const pgDialect = DRIZZLE_DIALECT_INFOS.postgresql;
const mysqlDialect = DRIZZLE_DIALECT_INFOS.mysql;
const sqliteDialect = DRIZZLE_DIALECT_INFOS.sqlite;

describe('DrizzleStorageAccessor', () => {
  it('insertRecord true when affected > 0', async () => {
    const { db } = makeDb(1);
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(true);
  });

  it('insertRecord false when affected === 0', async () => {
    const { db } = makeDb(0);
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on duplicate key (pg 23505)', async () => {
    const { db } = makeDb(0, { code: '23505' });
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on duplicate key (mysql errno 1062)', async () => {
    const { db } = makeDb(0, { errno: 1062 });
    const acc = new DrizzleStorageAccessor(db, source, mysqlDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on duplicate key (sqlite UNIQUE constraint failed)', async () => {
    const { db } = makeDb(0, new Error('UNIQUE constraint failed: t.n'));
    const acc = new DrizzleStorageAccessor(db, source, sqliteDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord rethrows non-duplicate errors', async () => {
    const { db } = makeDb(0, new Error('connection lost'));
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    await expect(acc.insertRecord(createLockConfig('t', 1000))).rejects.toThrow('connection lost');
  });

  it('updateRecord true/false', async () => {
    const accT = new DrizzleStorageAccessor(makeDb(1).db, source, pgDialect);
    const accF = new DrizzleStorageAccessor(makeDb(0).db, source, pgDialect);
    expect(await accT.updateRecord(createLockConfig('t', 1000))).toBe(true);
    expect(await accF.updateRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('extend true/false', async () => {
    const accT = new DrizzleStorageAccessor(makeDb(1).db, source, pgDialect);
    const accF = new DrizzleStorageAccessor(makeDb(0).db, source, pgDialect);
    expect(await accT.extend(createLockConfig('t', 1000))).toBe(true);
    expect(await accF.extend(createLockConfig('t', 1000))).toBe(false);
  });

  it('unlock void', async () => {
    const { db } = makeDb(0);
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    await expect(acc.unlock(createLockConfig('t', 1000))).resolves.toBeUndefined();
  });

  it('mysql getAffectedRows reads affectedRows', () => {
    expect(mysqlDialect.getAffectedRows({ affectedRows: 5 })).toBe(5);
    expect(mysqlDialect.getAffectedRows({})).toBe(0);
  });

  it('sqlite getAffectedRows reads changes', () => {
    expect(sqliteDialect.getAffectedRows({ changes: 5 })).toBe(5);
    expect(sqliteDialect.getAffectedRows({ rowsAffected: 5 })).toBe(5);
    expect(sqliteDialect.getAffectedRows({})).toBe(0);
  });

  it('pg getAffectedRows reads affectedRows or rowCount', () => {
    expect(pgDialect.getAffectedRows({ affectedRows: 5 })).toBe(5);
    expect(pgDialect.getAffectedRows({ rowCount: 5 })).toBe(5);
    expect(pgDialect.getAffectedRows({})).toBe(0);
  });
});
