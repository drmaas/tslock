import { DatabaseProduct } from '@tslock/sql-support';
import { describe, expect, it, vi } from 'vitest';
import { PgConnection } from '../src/connections/pg-connection.js';

describe('PgConnection', () => {
  it('getDatabaseProduct returns POSTGRES', () => {
    const conn = new PgConnection({} as never);
    expect(conn.getDatabaseProduct()).toBe(DatabaseProduct.POSTGRES);
  });

  it('query translates :name to $N and returns affectedRows', async () => {
    const pool = {
      query: vi.fn().mockResolvedValue({ rowCount: 1 }),
    };
    const conn = new PgConnection(pool as never);
    const result = await conn.query('INSERT INTO t(n) VALUES(:name)', { name: 'foo' });
    expect(result.affectedRows).toBe(1);
    expect(pool.query).toHaveBeenCalledWith('INSERT INTO t(n) VALUES($1)', ['foo']);
  });

  it('query defaults affectedRows to 0 when rowCount is null', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rowCount: null }) };
    const conn = new PgConnection(pool as never);
    const result = await conn.query('SELECT 1', {});
    expect(result.affectedRows).toBe(0);
  });

  it('isDuplicateKeyError true for code 23505', () => {
    const conn = new PgConnection({} as never);
    expect(conn.isDuplicateKeyError({ code: '23505' })).toBe(true);
  });

  it('isDuplicateKeyError false for other codes', () => {
    const conn = new PgConnection({} as never);
    expect(conn.isDuplicateKeyError({ code: '23503' })).toBe(false);
    expect(conn.isDuplicateKeyError(null)).toBe(false);
    expect(conn.isDuplicateKeyError('string error')).toBe(false);
  });
});
