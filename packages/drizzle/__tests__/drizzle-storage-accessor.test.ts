import { createLockConfig } from '@tslock/core';
import { DatabaseProduct, DefaultSqlStatementsSource, SqlConfiguration } from '@tslock/sql-support';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { DRIZZLE_DIALECT_INFOS, DrizzleLockProvider } from '../src/drizzle-lock-provider.js';
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

function driverCause(shape: Record<string, unknown>): Error {
  return shape as unknown as Error;
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

  it('insertRecord false on duplicate key (mysql ER_DUP_ENTRY)', async () => {
    const { db } = makeDb(0, { code: 'ER_DUP_ENTRY' });
    const acc = new DrizzleStorageAccessor(db, source, mysqlDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on duplicate key (sqlite UNIQUE constraint failed)', async () => {
    const { db } = makeDb(0, new Error('UNIQUE constraint failed: t.n'));
    const acc = new DrizzleStorageAccessor(db, source, sqliteDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on DrizzleQueryError cause errno 1062 (mysql)', async () => {
    const wrapped = new DrizzleQueryError('INSERT INTO shedlock', [], driverCause({ errno: 1062 }));
    const { db } = makeDb(0, wrapped);
    const acc = new DrizzleStorageAccessor(db, source, mysqlDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on DrizzleQueryError cause ER_DUP_ENTRY (mysql)', async () => {
    const wrapped = new DrizzleQueryError('INSERT INTO shedlock', [], driverCause({ code: 'ER_DUP_ENTRY' }));
    const { db } = makeDb(0, wrapped);
    const acc = new DrizzleStorageAccessor(db, source, mysqlDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on DrizzleQueryError cause 23505 (postgresql)', async () => {
    const wrapped = new DrizzleQueryError('INSERT INTO shedlock', [], driverCause({ code: '23505' }));
    const { db } = makeDb(0, wrapped);
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord false on DrizzleQueryError cause UNIQUE constraint failed (sqlite)', async () => {
    const wrapped = new DrizzleQueryError(
      'INSERT INTO shedlock',
      [],
      new Error('UNIQUE constraint failed: shedlock.name'),
    );
    const { db } = makeDb(0, wrapped);
    const acc = new DrizzleStorageAccessor(db, source, sqliteDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
  });

  it('insertRecord rethrows non-duplicate errors', async () => {
    const { db } = makeDb(0, new Error('connection lost'));
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    await expect(acc.insertRecord(createLockConfig('t', 1000))).rejects.toThrow('connection lost');
  });

  it('insertRecord rethrows original DrizzleQueryError when cause is not a duplicate', async () => {
    const wrapped = new DrizzleQueryError('INSERT INTO shedlock', [], new Error('connection lost'));
    const { db } = makeDb(0, wrapped);
    const acc = new DrizzleStorageAccessor(db, source, mysqlDialect);
    await expect(acc.insertRecord(createLockConfig('t', 1000))).rejects.toBe(wrapped);
  });

  it('insertRecord false on cyclic duplicate-key cause without hanging', async () => {
    const cause = driverCause({ errno: 1062 }) as Error & { cause?: unknown };
    cause.cause = cause;
    const wrapped = new DrizzleQueryError('INSERT INTO shedlock', [], cause);
    const { db } = makeDb(0, wrapped);
    const acc = new DrizzleStorageAccessor(db, source, mysqlDialect);
    expect(await acc.insertRecord(createLockConfig('t', 1000))).toBe(false);
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

describe('DrizzleLockProvider mysql duplicate-key wrapped in DrizzleQueryError', () => {
  it('lock succeeds after wrapped 1062 insert and second lock skips insert', async () => {
    const executeMock = vi.fn();
    executeMock
      .mockRejectedValueOnce(new DrizzleQueryError('INSERT INTO shedlock', [], driverCause({ errno: 1062 })))
      .mockResolvedValue({ affectedRows: 1 });

    const provider = new DrizzleLockProvider(
      { execute: executeMock },
      'mysql',
      new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL }),
    );

    const first = await provider.lock(createLockConfig('job', 1000));
    expect(first).toBeDefined();
    expect(executeMock).toHaveBeenCalledTimes(2);

    const second = await provider.lock(createLockConfig('job', 1000));
    expect(second).toBeDefined();
    expect(executeMock).toHaveBeenCalledTimes(3);
  });
});
