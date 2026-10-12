import { createLockConfig, LockException } from '@tslock/core';
import type cassandra from 'cassandra-driver';
import { describe, expect, it, type MockInstance, vi } from 'vitest';
import { CassandraLockProvider } from '../../src/cassandra-lock-provider.js';

function makeClient(): cassandra.Client {
  return {
    execute: vi.fn(),
  } as unknown as cassandra.Client;
}

describe('CassandraLockProvider.lock', () => {
  it('clears the row cache when an update misses the row so the next lock inserts', async () => {
    const client = makeClient();
    const execute = client.execute as unknown as MockInstance;
    execute
      .mockResolvedValueOnce({ rows: [{ '[applied]': false }] })
      .mockResolvedValueOnce({ rows: [{ '[applied]': false, lock_until: null }] })
      .mockResolvedValueOnce({ rows: [{ '[applied]': true }] });
    const provider = new CassandraLockProvider(client, {
      keyspace: 'shedlock_test',
      lockedByValue: 'myhost',
    });

    const rejection = provider.lock(createLockConfig('shedlock-job', 60_000));
    await expect(rejection).rejects.toBeInstanceOf(LockException);
    await expect(rejection).rejects.toThrow('Lock record not found: shedlock-job');

    const lock = await provider.lock(createLockConfig('shedlock-job', 60_000));
    expect(lock).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(3);
    expect(execute.mock.calls[0]?.[0]).toContain('INSERT');
    expect(execute.mock.calls[0]?.[0]).toContain('IF NOT EXISTS');
    expect(execute.mock.calls[1]?.[0]).toContain('UPDATE');
    expect(execute.mock.calls[2]?.[0]).toContain('INSERT');
    expect(execute.mock.calls[2]?.[0]).toContain('IF NOT EXISTS');
    expect(execute.mock.calls[2]?.[1]).toEqual(expect.arrayContaining(['shedlock-job']));
  });
});
