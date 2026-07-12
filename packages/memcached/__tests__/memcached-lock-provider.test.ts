import { describe, expect, it, vi } from 'vitest';
import { createLockConfig, ClockProvider } from '@tslock/core';
import { MemcachedLockProvider } from '../src/memcached-lock-provider.js';

function makeClient(overrides: Record<string, any> = {}): any {
  return {
    add: vi.fn().mockResolvedValue({ success: true }),
    delete: vi.fn().mockResolvedValue({ success: true }),
    replace: vi.fn().mockResolvedValue({ success: true }),
    ...overrides,
  };
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => 1_000_000);
  return createLockConfig(name, most, least);
}

describe('MemcachedLockProvider', () => {
  it('lock() returns lock when add succeeds', async () => {
    const client = makeClient();
    const provider = new MemcachedLockProvider(client);
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(client.add).toHaveBeenCalledOnce();
  });

  it('lock() returns undefined when add fails', async () => {
    const client = makeClient({ add: vi.fn().mockResolvedValue({ success: false }) });
    const provider = new MemcachedLockProvider(client);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() uses env prefix', async () => {
    const add = vi.fn().mockResolvedValue({ success: true });
    const provider = new MemcachedLockProvider(makeClient({ add }), { servers: '', env: 'prod' });
    await provider.lock(config('my-task'));
    expect(add.mock.calls[0][0]).toBe('shedlock:prod:my-task');
  });

  it('unlock() calls delete when keepLockFor <= 0', async () => {
    const del = vi.fn().mockResolvedValue({ success: true });
    const client = makeClient({ add: vi.fn().mockResolvedValue({ success: true }), delete: del });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 10_000, 0)))!;
    ClockProvider.setClock(() => 1_020_000);
    await lock.unlock();
    expect(del).toHaveBeenCalledOnce();
  });

  it('unlock() calls replace when keepLockFor > 0', async () => {
    const replace = vi.fn().mockResolvedValue({ success: true });
    const client = makeClient({ add: vi.fn().mockResolvedValue({ success: true }), replace });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 60_000, 30_000)))!;
    ClockProvider.setClock(() => 1_005_000);
    await lock.unlock();
    expect(replace).toHaveBeenCalledOnce();
  });

  it('unlock() throws when delete fails', async () => {
    const client = makeClient({ delete: vi.fn().mockResolvedValue({ success: false }) });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 10_000, 0)))!;
    ClockProvider.setClock(() => 1_020_000);
    await expect(lock.unlock()).rejects.toThrow('Can not unlock');
  });

  it('unlock() throws when replace fails', async () => {
    const client = makeClient({ replace: vi.fn().mockResolvedValue({ success: false }) });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 60_000, 30_000)))!;
    ClockProvider.setClock(() => 1_005_000);
    await expect(lock.unlock()).rejects.toThrow('Can not unlock');
  });
});
