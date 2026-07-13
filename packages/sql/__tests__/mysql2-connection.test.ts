import { DatabaseProduct } from '@tslock/sql-support';
import { describe, expect, it, vi } from 'vitest';
import { Mysql2Connection } from '../src/connections/mysql2-connection.js';

describe('Mysql2Connection', () => {
  it('create detects MYSQL from version string', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([[{ version: '8.0.34' }], []]),
    };
    const conn = await Mysql2Connection.create(pool as never);
    expect(conn.getDatabaseProduct()).toBe(DatabaseProduct.MYSQL);
  });

  it('create detects MARIA_DB from version string', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([[{ version: '10.5.4-MariaDB' }], []]),
    };
    const conn = await Mysql2Connection.create(pool as never);
    expect(conn.getDatabaseProduct()).toBe(DatabaseProduct.MARIA_DB);
  });

  it('query translates :name to ? and returns affectedRows', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue([{ affectedRows: 1 }, []]),
    };
    const conn = await Mysql2Connection.create(pool as never);
    const result = await conn.query('INSERT INTO t(n) VALUES(:name)', { name: 'foo' });
    expect(result.affectedRows).toBe(1);
    expect(pool.query).toHaveBeenCalledWith('INSERT INTO t(n) VALUES(?)', ['foo']);
  });

  it('isDuplicateKeyError true for errno 1062', async () => {
    const pool = { query: vi.fn().mockResolvedValue([{ version: '8.0' }]) };
    const conn = await Mysql2Connection.create(pool as never);
    expect(conn.isDuplicateKeyError({ errno: 1062 })).toBe(true);
    expect(conn.isDuplicateKeyError({ code: 'ER_DUP_ENTRY' })).toBe(true);
    expect(conn.isDuplicateKeyError({ errno: 1064 })).toBe(false);
    expect(conn.isDuplicateKeyError(null)).toBe(false);
  });
});
