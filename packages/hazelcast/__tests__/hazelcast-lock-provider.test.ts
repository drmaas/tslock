import { ClockProvider, createLockConfig, LockException } from '@tslock/core';
import type { Client as HazelcastClient } from 'hazelcast-client';
import { describe, expect, it, vi } from 'vitest';
import { HazelcastLockProvider } from '../src/hazelcast-lock-provider.js';

function makeStore(overrides: Record<string, any> = {}) {
  const get = overrides.get ?? vi.fn().mockResolvedValue(null);
  return {
    lock: vi.fn().mockResolvedValue(undefined),
    unlock: vi.fn().mockResolvedValue(undefined),
    get,
    put: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function makeClient(store?: any): HazelcastClient {
  const s = store ?? makeStore();
  return { getMap: vi.fn().mockResolvedValue(s) } as any;
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('HazelcastLockProvider', () => {
  it('lock() acquires when no existing entry', async () => {
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(store.lock).toHaveBeenCalledWith('test', 60_000);
    expect(store.put).toHaveBeenCalledWith(
      'test',
      expect.objectContaining({
        lockUntil: expect.any(String),
        lockedAt: expect.any(String),
        lockedBy: expect.any(String),
      }),
      60_000,
    );
    expect(store.unlock).toHaveBeenCalledWith('test');
  });

  it('lock() acquires when existing entry is expired', async () => {
    const store = makeStore({
      get: vi.fn().mockResolvedValue({
        lockUntil: '1970-01-01T00:00:00.000Z',
        lockedAt: '1970-01-01T00:00:00.000Z',
        lockedBy: 'other',
      }),
    });
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(store.put).toHaveBeenCalled();
    expect(store.unlock).toHaveBeenCalled();
  });

  it('lock() returns undefined when entry is still valid', async () => {
    const store = makeStore({
      get: vi.fn().mockResolvedValue({
        lockUntil: '2999-01-01T00:00:00.000Z',
        lockedAt: '2999-01-01T00:00:00.000Z',
        lockedBy: 'other',
      }),
    });
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
    expect(store.put).not.toHaveBeenCalled();
    expect(store.unlock).toHaveBeenCalled();
  });

  it('lock() calls unlock in finally even when get rejects', async () => {
    const store = makeStore({ get: vi.fn().mockRejectedValue(new Error('get failed')) });
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    await expect(provider.lock(config())).rejects.toThrow('get failed');
    expect(store.unlock).toHaveBeenCalled();
  });

  it('lock() does not call unlock when store.lock itself throws', async () => {
    const store = makeStore({
      lock: vi.fn().mockRejectedValue(new Error('lock failed')),
      get: vi.fn().mockResolvedValue(null),
    });
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    await expect(provider.lock(config())).rejects.toThrow('lock failed');
    expect(store.unlock).not.toHaveBeenCalled();
  });

  it('unlock() removes entry when now >= lockAtLeastUntil', async () => {
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const lock = (await provider.lock(config('test', 60_000, 0)))!;
    await lock.unlock();
    expect(store.remove).toHaveBeenCalledWith('test');
    expect(store.put).toHaveBeenCalledTimes(1);
    expect(store.unlock).toHaveBeenCalled();
  });

  it('unlock() puts with lockUntil when now < lockAtLeastUntil', async () => {
    ClockProvider.setClock(() => 500);
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const lock = (await provider.lock(config('test', 60_000, 10_000)))!;
    await lock.unlock();
    expect(store.put).toHaveBeenCalled();
    expect(store.remove).not.toHaveBeenCalled();
  });

  it('unlock() calls lock with lockLeaseTimeMs', async () => {
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client, { lockLeaseTimeMs: 5000 });
    const lock = (await provider.lock(config()))!;
    await lock.unlock();
    expect(store.lock).toHaveBeenCalledWith('test', 5000);
  });

  it('extend() throws LockException', async () => {
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const lock = (await provider.lock(config()))!;
    await expect(lock.extend(60_000, 0)).rejects.toThrow(LockException);
  });

  it('lock record fields are correct', async () => {
    ClockProvider.setClock(() => 5_000_000);
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const cfg = createLockConfig('my-lock', 10_000);
    await provider.lock(cfg);
    const record = store.put.mock.calls[0][1];
    expect(record.lockUntil).toBe('1970-01-01T01:23:30.000Z');
    expect(record.lockedAt).toBe('1970-01-01T01:23:20.000Z');
    expect(record.lockedBy).toBeDefined();
  });

  it('put TTL equals lockAtMostFor', async () => {
    const store = makeStore();
    const client = makeClient(store);
    const provider = new HazelcastLockProvider(client);
    const cfg = createLockConfig('ttl-test', 120_000);
    await provider.lock(cfg);
    expect(store.put.mock.calls[0][2]).toBe(120_000);
  });
});
