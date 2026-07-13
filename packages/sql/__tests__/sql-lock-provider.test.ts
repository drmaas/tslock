import { createLockConfig } from '@tslock/core';
import { DatabaseProduct, SqlConfiguration } from '@tslock/sql-support';
import { describe, expect, it, vi } from 'vitest';
import type { SqlConnection } from '../src/sql-connection.js';
import { SqlLockProvider } from '../src/sql-lock-provider.js';

function makeConn(insertRows: number): SqlConnection {
  return {
    query: vi.fn().mockResolvedValue({ affectedRows: insertRows }),
    isDuplicateKeyError: () => false,
    getDatabaseProduct: () => DatabaseProduct.POSTGRES,
  };
}

describe('SqlLockProvider', () => {
  it('extends StorageBasedLockProvider and acquires lock on insert success', async () => {
    const conn = makeConn(1);
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    const provider = new SqlLockProvider(conn, config);
    const lock = await provider.lock(createLockConfig('t', 1000));
    expect(lock).toBeDefined();
  });

  it('returns undefined when insert returns 0 rows (no error)', async () => {
    const conn = makeConn(0);
    conn.query = vi.fn().mockResolvedValue({ affectedRows: 0 });
    const config = new SqlConfiguration({ databaseProduct: DatabaseProduct.POSTGRES });
    const provider = new SqlLockProvider(conn, config);
    const lock = await provider.lock(createLockConfig('t', 1000));
    expect(lock).toBeUndefined();
  });
});
