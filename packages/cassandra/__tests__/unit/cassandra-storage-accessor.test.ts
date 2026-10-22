import { ClockProvider, createLockConfig, LockException, lockAtMostUntil } from '@tslock/core';
import cassandra from 'cassandra-driver';
import { describe, expect, it, type MockInstance, vi } from 'vitest';
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

function driverRow(cells: Record<string, unknown>): cassandra.types.Row {
  const RowCtor = (
    cassandra.types as unknown as {
      Row: new (columns: { name: string }[]) => cassandra.types.Row;
    }
  ).Row;
  const row = new RowCtor(Object.keys(cells).map((name) => ({ name })));
  for (const [name, value] of Object.entries(cells)) row[name] = value;
  return row;
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

  it('updateRecord returns false when [applied] = false and lock_until is set', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({
      rows: [{ '[applied]': false, lock_until: new Date(1_000_000) }],
    });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const result = await accessor.updateRecord(config());
    expect(result).toBe(false);
  });

  it('updateRecord throws LockException when [applied] = false and lock_until is null', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({
      rows: [{ '[applied]': false, lock_until: null }],
    });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const rejection = accessor.updateRecord(config('shedlock-job'));
    await expect(rejection).rejects.toBeInstanceOf(LockException);
    await expect(rejection).rejects.toThrow('Lock record not found: shedlock-job');
  });

  it('updateRecord throws LockException when the lock_until column is omitted', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': false }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const rejection = accessor.updateRecord(config('shedlock-job'));
    await expect(rejection).rejects.toBeInstanceOf(LockException);
    await expect(rejection).rejects.toThrow('Lock record not found: shedlock-job');
  });

  it('updateRecord throws LockException when the LWT result has no row', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await expect(accessor.updateRecord(config('shedlock-job'))).rejects.toThrow('Lock record not found: shedlock-job');
  });

  it('updateRecord reads a mixed-case lockUntil column the way the driver folds unquoted names', async () => {
    const client = makeClient();
    const heldUntil = new Date(1_000_000);
    const opts: ResolvedCassandraOptions = {
      ...defaultOpts,
      columnNames: { ...defaultOpts.columnNames, lockUntil: 'Lock_Until' },
    };
    const row = driverRow({ '[applied]': false, lock_until: heldUntil });
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [row] });
    const accessor = new CassandraStorageAccessor(client, opts);
    await expect(accessor.updateRecord(config())).resolves.toBe(false);

    row.lock_until = null;
    const rejection = accessor.updateRecord(config('mixed-case'));
    await expect(rejection).rejects.toBeInstanceOf(LockException);
    await expect(rejection).rejects.toThrow('Lock record not found: mixed-case');
  });

  it('updateRecord propagates execute errors', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockRejectedValue(new Error('connection failed'));
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    await expect(accessor.updateRecord(config())).rejects.toThrow('connection failed');
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
    const lock = config();
    await accessor.unlock(lock);
    expect(client.execute).toHaveBeenCalledWith(
      expect.stringContaining('IF locked_by = ? AND lock_until = ?'),
      [new Date(1_000_000), 'test', 'myhost', new Date(lockAtMostUntil(lock))],
      expect.any(Object),
    );
  });

  it('does not unlock or extend a newer same-host lock', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const lock = config();
    const acquired = lockAtMostUntil(lock);
    const newerDeadline = acquired + 60_000;

    await accessor.unlock(lock);
    const unlockCall = (client.execute as unknown as MockInstance).mock.calls[0]!;
    expect(unlockCall[0]).toContain('lock_until = ?');
    expect(unlockCall[0]).not.toContain('lock_until >= ?');
    expect(unlockCall[1]).toEqual([new Date(1_000_000), 'test', 'myhost', new Date(acquired)]);
    expect(unlockCall[1][3]).not.toEqual(new Date(newerDeadline));

    expect(await accessor.extend(lock)).toBe(false);
    expect(client.execute).toHaveBeenCalledOnce();

    await accessor.extend(lock, acquired);
    const extendCall = (client.execute as unknown as MockInstance).mock.calls[1]!;
    expect(extendCall[0]).toContain('lock_until = ? AND lock_until > ?');
    expect(extendCall[1]).toEqual([new Date(acquired), 'test', 'myhost', new Date(acquired), new Date(1_000_000)]);
    expect(extendCall[1][3]).not.toEqual(new Date(newerDeadline));
  });

  it('extend returns false and does not write when no previous deadline is given', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    expect(await accessor.extend(config())).toBe(false);
    expect(client.execute).not.toHaveBeenCalled();
  });

  it('extend returns true when the deadline matches and [applied] = true', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': true }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const lock = config();
    const result = await accessor.extend(lock, lockAtMostUntil(lock));
    expect(result).toBe(true);
    expect(client.execute).toHaveBeenCalledOnce();
  });

  it('extend returns false when [applied] = false', async () => {
    const client = makeClient();
    (client.execute as unknown as MockInstance).mockResolvedValue({ rows: [{ '[applied]': false }] });
    const accessor = new CassandraStorageAccessor(client, defaultOpts);
    const lock = config();
    const result = await accessor.extend(lock, lockAtMostUntil(lock));
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
    const params = (client.execute as unknown as MockInstance).mock.calls[0]![1];
    params.slice(1, 3).forEach((p: unknown) => {
      expect(p instanceof Date).toBe(true);
    });
  });
});
