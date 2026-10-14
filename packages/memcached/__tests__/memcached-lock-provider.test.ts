import { ClockProvider, createLockConfig } from '@tslock/core';
import type { Client as MemjsClient } from 'memjs';
import { describe, expect, it, vi } from 'vitest';
import { MemcachedLockProvider } from '../src/memcached-lock-provider.js';

function makeClient(overrides: Record<string, unknown> = {}): MemjsClient {
  const add = (overrides.add as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(true);
  const get =
    (overrides.get as ReturnType<typeof vi.fn> | undefined) ??
    vi.fn(async () => {
      const value = add.mock.calls.at(-1)?.[1];
      return {
        value: typeof value === 'string' ? Buffer.from(value) : null,
        flags: null,
      };
    });
  return {
    add,
    get,
    delete: (overrides.delete as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(true),
    replace: (overrides.replace as ReturnType<typeof vi.fn> | undefined) ?? vi.fn().mockResolvedValue(true),
  } as unknown as MemjsClient;
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
    expect(client.add).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expires: 61 });
  });

  it('lock() returns undefined when add fails', async () => {
    const client = makeClient({ add: vi.fn().mockResolvedValue(false) });
    const provider = new MemcachedLockProvider(client);
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() uses env prefix', async () => {
    const add = vi.fn().mockResolvedValue({ success: true });
    const provider = new MemcachedLockProvider(makeClient({ add }), { servers: '', env: 'prod' });
    await provider.lock(config('my-task'));
    expect(add.mock.calls[0]![0]).toBe('shedlock:prod:my-task');
  });

  it('unlock() calls delete when keepLockFor <= 0', async () => {
    const del = vi.fn().mockResolvedValue(true);
    const client = makeClient({ add: vi.fn().mockResolvedValue(true), delete: del });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 10_000, 0)))!;
    ClockProvider.setClock(() => 1_020_000);
    await lock.unlock();
    expect(del).toHaveBeenCalledOnce();
  });

  it('unlock() calls replace when keepLockFor > 0', async () => {
    const replace = vi.fn().mockResolvedValue(true);
    const client = makeClient({ add: vi.fn().mockResolvedValue(true), replace });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 60_000, 30_000)))!;
    ClockProvider.setClock(() => 1_005_000);
    await lock.unlock();
    expect(replace).toHaveBeenCalledWith(expect.any(String), expect.any(String), { expires: 26 });
  });

  it('unlock() throws when delete fails', async () => {
    const client = makeClient({ delete: vi.fn().mockResolvedValue(false) });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 10_000, 0)))!;
    ClockProvider.setClock(() => 1_020_000);
    await expect(lock.unlock()).rejects.toThrow('Can not unlock');
  });

  it('unlock() throws when replace fails', async () => {
    const client = makeClient({ replace: vi.fn().mockResolvedValue(false) });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 60_000, 30_000)))!;
    ClockProvider.setClock(() => 1_005_000);
    await expect(lock.unlock()).rejects.toThrow('Can not unlock');
  });

  it('unlock() does not delete when the stored value differs', async () => {
    const del = vi.fn().mockResolvedValue(true);
    const get = vi.fn().mockResolvedValue({ value: Buffer.from('other-owner'), flags: null });
    const client = makeClient({ delete: del, get });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 10_000, 0)))!;
    ClockProvider.setClock(() => 1_020_000);
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(del).not.toHaveBeenCalled();
    expect(client.replace).not.toHaveBeenCalled();
  });

  it('unlock() does not replace when the stored value differs', async () => {
    const replace = vi.fn().mockResolvedValue(true);
    const get = vi.fn().mockResolvedValue({ value: Buffer.from('other-owner'), flags: null });
    const client = makeClient({ replace, get });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 60_000, 30_000)))!;
    ClockProvider.setClock(() => 1_005_000);
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(replace).not.toHaveBeenCalled();
    expect(client.delete).not.toHaveBeenCalled();
  });

  it('unlock() deletes when the stored bytes match this lock', async () => {
    const del = vi.fn().mockResolvedValue(true);
    const add = vi.fn().mockResolvedValue(true);
    const get = vi.fn(async () => ({
      value: Buffer.from(String(add.mock.calls[0]?.[1])),
      flags: null,
    }));
    const client = makeClient({ add, delete: del, get });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 10_000, 0)))!;
    ClockProvider.setClock(() => 1_020_000);
    await lock.unlock();
    expect(get).toHaveBeenCalledWith('shedlock:default:t');
    expect(del).toHaveBeenCalledOnce();
    expect(del).toHaveBeenCalledWith('shedlock:default:t');
  });

  it('unlock() replaces with a shortened TTL when the stored bytes match', async () => {
    const replace = vi.fn().mockResolvedValue(true);
    const add = vi.fn().mockResolvedValue(true);
    const get = vi.fn(async () => ({
      value: Buffer.from(String(add.mock.calls[0]?.[1])),
      flags: null,
    }));
    const client = makeClient({ add, replace, get });
    const provider = new MemcachedLockProvider(client);
    const lock = (await provider.lock(config('t', 60_000, 30_000)))!;
    const value = add.mock.calls[0]![1];
    ClockProvider.setClock(() => 1_005_000);
    await lock.unlock();
    expect(get).toHaveBeenCalledWith('shedlock:default:t');
    expect(replace).toHaveBeenCalledWith('shedlock:default:t', value, { expires: 26 });
  });
});
