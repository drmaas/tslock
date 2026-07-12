import { describe, expect, it, vi } from 'vitest';
import { createLockConfig } from '@tslock/core';
import { DatabaseProduct, DefaultSqlStatementsSource, SqlConfiguration } from '@tslock/sql-support';
import { SqlStorageAccessor } from '../src/sql-storage-accessor.js';
import type { SqlConnection } from '../src/sql-connection.js';

function makeConnection(opts: {
  affectedRowsBySql?: Map<string, number>;
  insertThrows?: unknown;
} = {}): SqlConnection {
  const queryMock = vi.fn();
  queryMock.mockImplementation((sql: string) => {
    if (opts.insertThrows && sql.includes('INSERT')) {
      throw opts.insertThrows;
    }
    const rows = opts.affectedRowsBySql?.get(sql) ?? 0;
    return Promise.resolve({ affectedRows: rows });
  });
  return {
    query: queryMock,
    isDuplicateKeyError: (e: unknown) =>
      typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505',
    getDatabaseProduct: () => DatabaseProduct.POSTGRES,
  };
}

describe('SqlStorageAccessor', () => {
  const POSTGRES_CONFIG = () => new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
  const DEFAULT_SOURCE = (config = POSTGRES_CONFIG()) => new DefaultSqlStatementsSource(config);

  it('insertRecord returns true when affectedRows > 0', async () => {
    const source = DEFAULT_SOURCE();
    const insertSql = source.getInsertStatement();
    const conn = makeConnection({ affectedRowsBySql: new Map([[insertSql, 1]]) });
    const accessor = new SqlStorageAccessor(conn, source);
    const result = await accessor.insertRecord(createLockConfig('test', 1000));
    expect(result).toBe(true);
  });

  it('insertRecord returns false on duplicate key', async () => {
    const source = DEFAULT_SOURCE();
    const insertSql = source.getInsertStatement();
    const conn = makeConnection({
      affectedRowsBySql: new Map([[insertSql, 0]]),
      insertThrows: { code: '23505' },
    });
    const accessor = new SqlStorageAccessor(conn, source);
    const result = await accessor.insertRecord(createLockConfig('test', 1000));
    expect(result).toBe(false);
  });

  it('insertRecord rethrows non-duplicate errors', async () => {
    const source = DEFAULT_SOURCE();
    const conn = makeConnection({ insertThrows: new Error('connection lost') });
    const accessor = new SqlStorageAccessor(conn, source);
    await expect(accessor.insertRecord(createLockConfig('test', 1000))).rejects.toThrow(
      'connection lost',
    );
  });

  it('updateRecord returns true/false based on affectedRows', async () => {
    const source = DEFAULT_SOURCE();
    const updateSql = source.getUpdateStatement();
    const connTrue = makeConnection({ affectedRowsBySql: new Map([[updateSql, 1]]) });
    const connFalse = makeConnection({ affectedRowsBySql: new Map([[updateSql, 0]]) });
    expect(
      await new SqlStorageAccessor(connTrue, source).updateRecord(createLockConfig('t', 1000)),
    ).toBe(true);
    expect(
      await new SqlStorageAccessor(connFalse, source).updateRecord(createLockConfig('t', 1000)),
    ).toBe(false);
  });

  it('extend returns true/false based on affectedRows', async () => {
    const source = DEFAULT_SOURCE();
    const extendSql = source.getExtendStatement();
    const connTrue = makeConnection({ affectedRowsBySql: new Map([[extendSql, 1]]) });
    expect(
      await new SqlStorageAccessor(connTrue, source).extend(createLockConfig('t', 1000)),
    ).toBe(true);
  });

  it('unlock calls query and returns void', async () => {
    const source = DEFAULT_SOURCE();
    const conn = makeConnection();
    const accessor = new SqlStorageAccessor(conn, source);
    await expect(accessor.unlock(createLockConfig('t', 1000))).resolves.toBeUndefined();
  });
});
