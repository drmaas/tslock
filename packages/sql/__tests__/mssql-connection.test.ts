import { DatabaseProduct } from '@tslock/sql-support';
import { describe, expect, it, vi } from 'vitest';
import { MssqlConnection } from '../src/connections/mssql-connection.js';

describe('MssqlConnection', () => {
  it('getDatabaseProduct returns SQL_SERVER', () => {
    const conn = new MssqlConnection({} as never);
    expect(conn.getDatabaseProduct()).toBe(DatabaseProduct.SQL_SERVER);
  });

  it('query translates :name to @name, uses request.input, returns affectedRows', async () => {
    const inputMock = vi.fn();
    const queryMock = vi.fn().mockResolvedValue({ rowsAffected: [1] });
    const request = { input: inputMock, query: queryMock };
    const pool = { request: vi.fn().mockReturnValue(request) };
    const conn = new MssqlConnection(pool as never);
    const result = await conn.query('INSERT INTO t(n, l) VALUES(@name, @lockUntil)', { name: 'foo', lockUntil: 1234 });
    expect(result.affectedRows).toBe(1);
    expect(inputMock).toHaveBeenCalledWith('name', 'foo');
    expect(inputMock).toHaveBeenCalledWith('lockUntil', 1234);
    expect(queryMock).toHaveBeenCalledWith('INSERT INTO t(n, l) VALUES(@name, @lockUntil)');
  });

  it('query defaults affectedRows to 0 when rowsAffected is undefined', async () => {
    const request = {
      input: vi.fn().mockReturnThis(),
      query: vi.fn().mockResolvedValue({ rowsAffected: undefined }),
    };
    const pool = { request: vi.fn().mockReturnValue(request) };
    const conn = new MssqlConnection(pool as never);
    const result = await conn.query('SELECT 1', {});
    expect(result.affectedRows).toBe(0);
  });

  it('isDuplicateKeyError true for number 2627 and 2601', () => {
    const conn = new MssqlConnection({} as never);
    expect(conn.isDuplicateKeyError({ number: 2627 })).toBe(true);
    expect(conn.isDuplicateKeyError({ number: 2601 })).toBe(true);
    expect(conn.isDuplicateKeyError({ number: 8152 })).toBe(false);
    expect(conn.isDuplicateKeyError(null)).toBe(false);
  });
});
