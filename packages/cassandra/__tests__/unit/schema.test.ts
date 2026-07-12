import { describe, expect, it, vi } from 'vitest';
import type cassandra from 'cassandra-driver';
import { createLockTable } from '../../src/cassandra-lock-provider.js';

function makeClient(): cassandra.Client {
  return { execute: vi.fn() } as any;
}

describe('createLockTable', () => {
  it('calls client.execute with CREATE TABLE IF NOT EXISTS', async () => {
    const client = makeClient();
    await createLockTable(client, { keyspace: 'shedlock_test' });
    expect(client.execute).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS shedlock_test.shedlock (name text PRIMARY KEY, lock_until timestamp, locked_at timestamp, locked_by text)',
    );
  });

  it('uses custom table name', async () => {
    const client = makeClient();
    await createLockTable(client, { keyspace: 'ks', tableName: 'my_locks' });
    expect(client.execute).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS ks.my_locks (name text PRIMARY KEY, lock_until timestamp, locked_at timestamp, locked_by text)',
    );
  });

  it('uses custom column names', async () => {
    const client = makeClient();
    await createLockTable(client, {
      keyspace: 'ks',
      columnNames: { name: 'lock_name', lockUntil: 'expires_at', lockedAt: 'created_at', lockedBy: 'owner' },
    });
    expect(client.execute).toHaveBeenCalledWith(
      'CREATE TABLE IF NOT EXISTS ks.shedlock (lock_name text PRIMARY KEY, expires_at timestamp, created_at timestamp, owner text)',
    );
  });

  it('propagates errors', async () => {
    const client = makeClient();
    (client.execute as any).mockRejectedValue(new Error('query failed'));
    await expect(createLockTable(client, { keyspace: 'ks' })).rejects.toThrow('query failed');
  });
});
