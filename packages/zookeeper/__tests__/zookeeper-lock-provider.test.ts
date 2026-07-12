import { describe, expect, it, vi } from 'vitest';
import { ClockProvider, createLockConfig, LockException } from '@tslock/core';
import { ZooKeeperLockProvider } from '../src/zookeeper-lock-provider.js';

function makeClient(overrides: Record<string, unknown> = {}): any {
  return {
    get: vi.fn(),
    set: vi.fn(),
    create: vi.fn(),
    mkdirp: vi.fn((_path: string, cb: (err: Error | null) => void) => cb(null)),
    ...overrides,
  };
}

const BASE_NOW = 1_000_000;

function makeStat(version: number = 1) {
  return {
    czxid: 0,
    mzxid: 0,
    ctime: 0,
    mtime: 0,
    version,
    cversion: 0,
    aversion: 0,
    ephemeralOwner: '0',
    dataLength: 0,
    numChildren: 0,
    pzxid: 0,
  };
}

function config(name = 'test', most = 60_000, least = 0) {
  ClockProvider.setClock(() => BASE_NOW);
  return createLockConfig(name, most, least);
}

function pastIso(): string {
  return new Date(BASE_NOW - 10_000).toISOString();
}

describe('ZooKeeperLockProvider', () => {
  it('lock() returns lock when setData CAS succeeds on expired znode', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(client.get).toHaveBeenCalledWith('/shedlock-test/test', false);
    expect(client.set).toHaveBeenCalledWith(
      '/shedlock-test/test',
      expect.any(Buffer),
      5,
    );
  });

  it('lock() returns undefined when znode has future lockUntil', async () => {
    const futureIso = new Date(BASE_NOW + 100_000).toISOString();
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(3), futureIso]),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('lock() creates new znode on NoNode and returns lock', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('No node'), { code: -101 })),
      create: vi.fn().mockResolvedValue('/shedlock-test/test'),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(client.create).toHaveBeenCalledWith(
      '/shedlock-test/test',
      expect.any(Buffer),
      0,
    );
  });

  it('lock() creates basePath on first use via mkdirp', async () => {
    const mkdirp = vi.fn((_path: string, cb: (err: Error | null) => void) => cb(null));
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('No node'), { code: -101 })),
      create: vi.fn().mockResolvedValue('/shedlock-test/test'),
      mkdirp,
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    await provider.lock(config());
    expect(mkdirp).toHaveBeenCalledWith('/shedlock-test', expect.any(Function));
  });

  it('lock() returns undefined on NodeExists during create', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('No node'), { code: -101 })),
      create: vi.fn().mockRejectedValue(Object.assign(new Error('Node exists'), { code: -110 })),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() returns undefined on BadVersion during setData CAS', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockRejectedValue(Object.assign(new Error('Bad version'), { code: -103 })),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() propagates non-recoverable errors', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('Connection loss'), { code: -4 })),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    await expect(provider.lock(config())).rejects.toThrow('Connection loss');
  });

  it('lock() creates data with lockAtMostUntil ISO string', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const cfg = config('test', 60_000);
    await provider.lock(cfg);
    const expectedIso = new Date(1_060_000).toISOString();
    expect(client.set).toHaveBeenCalledWith(
      '/shedlock-test/test',
      Buffer.from(expectedIso),
      5,
    );
  });

  it('unlock() sets unlockTime with version -1', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config('test', 60_000, 0)))!;
    ClockProvider.setClock(() => BASE_NOW + 10_000);
    await lock.unlock();
    const expectedIso = new Date(BASE_NOW + 10_000).toISOString();
    expect(client.set).toHaveBeenLastCalledWith(
      '/shedlock-test/test',
      Buffer.from(expectedIso),
      -1,
    );
  });

  it('unlock() uses lockAtLeastFor when computing unlockTime', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config('test', 60_000, 10_000)))!;
    ClockProvider.setClock(() => BASE_NOW + 2_000);
    await lock.unlock();
    const expectedIso = new Date(BASE_NOW + 10_000).toISOString();
    expect(client.set).toHaveBeenLastCalledWith(
      '/shedlock-test/test',
      Buffer.from(expectedIso),
      -1,
    );
  });

  it('extend() throws LockException', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    ClockProvider.setClock(() => BASE_NOW + 20_000);
    await expect(lock.extend(30_000, 0)).rejects.toThrow(LockException);
  });

  it('writes Buffer to set and create', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    await provider.lock(config());
    expect(Buffer.isBuffer(client.set.mock.calls[0][1])).toBe(true);
  });

  it('uses default basePath when no options given', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(1), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(2)),
    });
    const provider = new ZooKeeperLockProvider(client);
    await provider.lock(config());
    expect(client.get).toHaveBeenCalledWith('/shedlock/test', false);
  });

  it('strips trailing slash from basePath', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(1), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(2)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock/' });
    await provider.lock(config());
    expect(client.get).toHaveBeenCalledWith('/shedlock/test', false);
  });

  it('handles Buffer data from get', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), Buffer.from(pastIso())]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
  });
});
