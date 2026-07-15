import { ClockProvider, createLockConfig } from '@tslock/core';
import type cassandra from 'cassandra-driver';
import { type MockInstance, describe, expect, it, vi } from 'vitest';
import type { ResolvedCassandraOptions } from '../../src/cassandra-cql.js';
import { CassandraStorageAccessor } from '../../src/cassandra-storage-accessor.js';

const defaultOpts: ResolvedCassandraOptions = {
  keyspace: 'shedlock_test',
  tableName: 'shedlock',
  columnNames: { name: 'name', lockUntil: 'lock_until', lockedAt: 'locked_at', lockedBy: 'locked_by' },
  lockedByValue: 'myhost',
  consistencyLevel: 6,
  serialConsistencyLevel: 9,
};

function makeClient(): cassandra.Client {
  return {
    execute: vi.fn(),
  } as unknown as cassandra.Client;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('CassandraStorageAccessor', () => {
  it('insertRecord returns true when [applied] = true', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.insertRecord(config());
    expect(result).toBe(true);
    expect(client.execute).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO'),
      expect.arrayContaining(['test', expect.any(Date), expect.any(Date), 'myhost']),
      { prepare: true, consistency: 6, serialConsistency: 9 },
    );
  });

  it('insertRecord returns false when [applied] = false', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': false }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.insertRecord(config());
    expect(result).toBe(false);
  });

  it('insertRecord propagates errors', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockRejectedValue(new Error('connection failed'));
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await expect(accessor.insertRecord(config())).rejects.toThrow('connection failed');
  });

  it('updateRecord returns true when [applied] = true', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.updateRecord(config());
    expect(result).toBe(true);
    expect(client.execute).toHaveBeenCalledWith(
      expect.stringContaining('UPDATE'),
      expect.arrayContaining([expect.any(Date), expect.any(Date), 'myhost', 'test', expect.any(Date)]),
      { prepare: true, consistency: 6, serialConsistency: 9 },
    );
  });

  it('updateRecord returns false when [applied] = false', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': false }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.updateRecord(config());
    expect(result).toBe(false);
  });

  it('unlock does not throw when [applied] = false', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': false }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await expect(accessor.unlock(config())).resolves.toBeUndefined();
  });

  it('unlock passes correct params', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await accessor.unlock(config());
    expect(client.execute).toHaveBeenCalledWith(
      expect.stringContaining('SET lock_until'),
      expect.arrayContaining([expect.any(Date), 'test', 'myhost', expect.any(Date)]),
      expect.any(Object),
    );
  });

  it('extend returns true when [applied] = true', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.extend(config());
    expect(result).toBe(true);
  });

  it('extend returns false when [applied] = false', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': false }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.extend(config());
    expect(result).toBe(false);
  });

  it('uses prepare:true and correct consistency levels', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await accessor.insertRecord(config());
    expect(client.execute).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Array),
      expect.objectContaining({ prepare: true, consistency: 6, serialConsistency: 9 }),
    );
  });

  it('Date parameters are Date instances', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await accessor.insertRecord(config());
    const params = (client.execute as unknown as MockInstance).mock.calls[0][1];
    params.slice(1, 3).forEach((p: unknown) => {
      expect(p instanceof Date).toBe(true);
    });
  });
});
