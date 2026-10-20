import { createLockConfig } from '@tslock/core';
import { DatabaseProduct, DefaultSqlStatementsSource, SqlConfiguration } from '@tslock/sql-support';
import { DrizzleQueryError } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';
import { InMemoryShedlock, runSameHostScenario } from '../../sql/__tests__/in-memory-shedlock.js';
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
    expect(await accT.extend(createLockConfig('t', 1000), 1_000)).toBe(true);
    expect(await accF.extend(createLockConfig('t', 1000), 1_000)).toBe(false);
  });

  it('unlock void', async () => {
    const { db } = makeDb(0);
    const acc = new DrizzleStorageAccessor(db, source, pgDialect);
    await expect(acc.unlock(createLockConfig('t', 1000))).resolves.toBeUndefined();
  });

  it('extend returns false when no previous deadline is given', async () => {
    const execute = vi.fn().mockResolvedValue({ affectedRows: 1 });
    const acc = new DrizzleStorageAccessor({ execute }, source, pgDialect);
    expect(await acc.extend(createLockConfig('t', 1000))).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it('does not unlock or extend a newer same-host lock', async () => {
    const store = new InMemoryShedlock();
    await runSameHostScenario(
      store,
      (statements) =>
        new DrizzleStorageAccessor(
          {
            execute: async (query) => {
              const { sql, values } = flattenDrizzleSql(query);
              const affected = store.execute(sql, values);
              return { affectedRows: affected, rowCount: affected };
            },
          },
          statements,
          pgDialect,
        ),
    );
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

  it('mysql getAffectedRows reads affectedRows from the mysql2 result tuple', () => {
    expect(mysqlDialect.getAffectedRows([{ affectedRows: 1, insertId: 0 }, []])).toBe(1);
    expect(mysqlDialect.getAffectedRows([{ affectedRows: 0 }, []])).toBe(0);
    expect(mysqlDialect.getAffectedRows([])).toBe(0);
    expect(mysqlDialect.getAffectedRows({ affectedRows: 1 })).toBe(1);
  });

  it('pg getAffectedRows still reads rowCount 1', () => {
    expect(pgDialect.getAffectedRows({ rowCount: 1 })).toBe(1);
  });

  it('extend returns true for a mysql2 tuple with affectedRows 1', async () => {
    const executeMock = vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]);
    const acc = new DrizzleStorageAccessor({ execute: executeMock }, source, mysqlDialect);
    expect(await acc.extend(createLockConfig('t', 1000), 1_000)).toBe(true);
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

describe('DrizzleLockProvider mysql2 execute tuple', () => {
  it('returns a lock when execute resolves affectedRows 1 and undefined when the next call resolves 0', async () => {
    const execute = vi
      .fn()
      .mockResolvedValueOnce([{ affectedRows: 1 }, []])
      .mockResolvedValueOnce([{ affectedRows: 0 }, []]);
    const provider = new DrizzleLockProvider(
      { execute },
      'mysql',
      new SqlConfiguration({ databaseProduct: DatabaseProduct.MYSQL }),
    );

    const first = await provider.lock(createLockConfig('job', 1000));
    expect(first).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);

    const second = await provider.lock(createLockConfig('job', 1000));
    expect(second).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(2);
  });
});

function flattenDrizzleSql(query: unknown): { sql: string; values: unknown[] } {
  const values: unknown[] = [];
  return { sql: walk(query), values };

  function walk(chunk: unknown): string {
    if (!chunk || typeof chunk !== 'object') return '';
    const record = chunk as { queryChunks?: unknown[]; value?: unknown; encoder?: unknown };
    if (Array.isArray(record.queryChunks)) return record.queryChunks.map((part) => walk(part)).join('');
    if (Array.isArray(record.value) && record.value.every((part) => typeof part === 'string')) {
      return record.value.join('');
    }
    if ('encoder' in record) {
      values.push(record.value);
      return '?';
    }
    throw new Error(`Unrecognized SQL chunk: ${Object.keys(record).join(',')}`);
  }
}
