import {
  ClockProvider,
  createLockConfig,
  type ExtensibleLockProvider,
  KeepAliveLockProvider,
  LockException,
} from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import { isBadVersionException, isNodeExistsException, isNoNodeException } from '../src/zookeeper-errors.js';
import { ZooKeeperLockProvider } from '../src/zookeeper-lock-provider.js';
import type { ZooKeeperClient } from '../src/zookeeper-types.js';

interface MockZooKeeperClient {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
  mkdirp: ReturnType<typeof vi.fn>;
}

function makeClient(overrides: Record<string, unknown> = {}): MockZooKeeperClient {
  return {
    get: vi.fn(),
    set: vi.fn(),
    create: vi.fn(),
    mkdirp: vi.fn((_path: string, cb: (err: Error | null) => void) => cb(null)),
    ...overrides,
  };
}

const BASE_NOW = 1_000_000;

function makeStat(version = 1) {
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
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(client.get).toHaveBeenCalledWith('/shedlock-test/test', false);
    expect(client.set).toHaveBeenCalledWith('/shedlock-test/test', expect.any(Buffer), 5);
  });

  it('lock() returns undefined when znode has future lockUntil', async () => {
    const futureIso = new Date(BASE_NOW + 100_000).toISOString();
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(3), futureIso]),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
    expect(client.set).not.toHaveBeenCalled();
  });

  it('lock() creates new znode on NoNode and returns lock', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('No node'), { code: -101 })),
      create: vi.fn().mockResolvedValue('/shedlock-test/test'),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(client.create).toHaveBeenCalledWith('/shedlock-test/test', expect.any(Buffer), 0);
  });

  it('lock() creates basePath on first use via mkdirp', async () => {
    const mkdirp = vi.fn((_path: string, cb: (err: Error | null) => void) => cb(null));
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('No node'), { code: -101 })),
      create: vi.fn().mockResolvedValue('/shedlock-test/test'),
      mkdirp,
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    await provider.lock(config());
    expect(mkdirp).toHaveBeenCalledWith('/shedlock-test', expect.any(Function));
  });

  it('lock() returns undefined on NodeExists during create', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('No node'), { code: -101 })),
      create: vi.fn().mockRejectedValue(Object.assign(new Error('Node exists'), { code: -110 })),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() returns undefined when create rejects with message-form NodeExists', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(new Error('-101 no node')),
      create: vi.fn().mockRejectedValue(new Error('-110 node exists')),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() rejects message-form connection loss during create', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(new Error('-101 no node')),
      create: vi.fn().mockRejectedValue(new Error('-4 connection loss')),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    await expect(provider.lock(config())).rejects.toThrow('-4 connection loss');
  });

  it('lock() returns undefined on BadVersion during setData CAS', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockRejectedValue(Object.assign(new Error('Bad version'), { code: -103 })),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
  });

  it('lock() returns undefined when set rejects with message-form BadVersion', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockRejectedValue(new Error('-103 bad version')),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeUndefined();
    expect(client.create).not.toHaveBeenCalled();
  });

  it('lock() creates the znode when get rejects with message-form NoNode', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(new Error('-101 no node')),
      create: vi.fn().mockResolvedValue('/shedlock-test/test'),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
    expect(client.create).toHaveBeenCalledWith('/shedlock-test/test', expect.any(Buffer), 0);
  });

  it('lock() propagates non-recoverable errors', async () => {
    const client = makeClient({
      get: vi.fn().mockRejectedValue(Object.assign(new Error('Connection loss'), { code: -4 })),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    await expect(provider.lock(config())).rejects.toThrow('Connection loss');
  });

  it('lock() creates data with lockAtMostUntil ISO string', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const cfg = config('test', 60_000);
    await provider.lock(cfg);
    const expectedIso = new Date(1_060_000).toISOString();
    expect(client.set).toHaveBeenCalledWith('/shedlock-test/test', Buffer.from(expectedIso), 5);
  });

  it('unlock() sets unlockTime with the version from the get of this lock body', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), Buffer.from(ownIso)]),
      set: vi.fn().mockResolvedValue(makeStat(7)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config('test', 60_000, 0)))!;
    ClockProvider.setClock(() => BASE_NOW + 10_000);
    await lock.unlock();
    const expectedIso = new Date(BASE_NOW + 10_000).toISOString();
    expect(client.set).toHaveBeenLastCalledWith('/shedlock-test/test', Buffer.from(expectedIso), 6);
    expect(client.set).toHaveBeenCalledTimes(2);
  });

  it('unlock() uses lockAtLeastFor when computing unlockTime', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(8), ownIso]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config('test', 60_000, 10_000)))!;
    ClockProvider.setClock(() => BASE_NOW + 2_000);
    await lock.unlock();
    const expectedIso = new Date(BASE_NOW + 10_000).toISOString();
    expect(client.set).toHaveBeenLastCalledWith('/shedlock-test/test', Buffer.from(expectedIso), 8);
  });

  it('unlock() does not set when a newer holder replaced this lock body', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const newerIso = new Date(BASE_NOW + 180_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(9), newerIso]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config('test', 60_000, 0)))!;
    expect(client.set).toHaveBeenCalledTimes(1);
    ClockProvider.setClock(() => BASE_NOW + 70_000);
    await lock.unlock();
    expect(client.set).toHaveBeenCalledTimes(1);
    expect(client.get).toHaveBeenNthCalledWith(2, '/shedlock-test/test', false);
  });

  it('unlock() resolves when the znode is missing', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockRejectedValueOnce(Object.assign(new Error('No node'), { code: -101 })),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('unlock() resolves when set hits NoNode', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), ownIso]),
      set: vi
        .fn()
        .mockResolvedValueOnce(makeStat(6))
        .mockRejectedValueOnce(Object.assign(new Error('No node'), { code: -101 })),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
  });

  it('unlock() resolves when set hits BadVersion', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), ownIso]),
      set: vi
        .fn()
        .mockResolvedValueOnce(makeStat(6))
        .mockRejectedValueOnce(Object.assign(new Error('Bad version'), { code: -103 })),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
  });

  it('unlock() rejects connection loss while reading the znode', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockRejectedValueOnce(Object.assign(new Error('Connection loss'), { code: -4 })),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('Connection loss');
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('unlock() resolves when get rejects with message-form NoNode', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockRejectedValueOnce(new Error('-101 no node')),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('unlock() resolves when get rejects with message-form BadVersion', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockRejectedValueOnce(new Error('-103 bad version')),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('unlock() resolves when set rejects with message-form NoNode and does not write again', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), ownIso]),
      set: vi.fn().mockResolvedValueOnce(makeStat(6)).mockRejectedValueOnce(new Error('-101 no node')),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledTimes(2);
    await expect(client.set.mock.results[1]?.value).rejects.toThrow('-101 no node');
  });

  it('unlock() resolves when set rejects with message-form BadVersion and does not write again', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), ownIso]),
      set: vi.fn().mockResolvedValueOnce(makeStat(6)).mockRejectedValueOnce(new Error('-103 bad version')),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).resolves.toBeUndefined();
    expect(client.set).toHaveBeenCalledTimes(2);
    await expect(client.set.mock.results[1]?.value).rejects.toThrow('-103 bad version');
  });

  it('unlock() rejects message-form connection loss while reading the znode', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockRejectedValueOnce(new Error('-4 connection loss')),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('-4 connection loss');
    expect(client.set).toHaveBeenCalledTimes(1);
  });

  it('unlock() rejects message-form connection loss while writing unlockTime', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), ownIso]),
      set: vi.fn().mockResolvedValueOnce(makeStat(6)).mockRejectedValueOnce(new Error('-4 connection loss')),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('-4 connection loss');
  });

  it('unlock() rejects connection loss while writing unlockTime', async () => {
    ClockProvider.setClock(() => BASE_NOW);
    const ownIso = new Date(BASE_NOW + 60_000).toISOString();
    const client = makeClient({
      get: vi
        .fn()
        .mockResolvedValueOnce([makeStat(5), pastIso()])
        .mockResolvedValueOnce([makeStat(6), ownIso]),
      set: vi
        .fn()
        .mockResolvedValueOnce(makeStat(6))
        .mockRejectedValueOnce(Object.assign(new Error('Connection loss'), { code: -4 })),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = (await provider.lock(config()))!;
    await expect(lock.unlock()).rejects.toThrow('Connection loss');
  });

  it('extend() throws LockException', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
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
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    await provider.lock(config());
    expect(Buffer.isBuffer((client.set as unknown as ReturnType<typeof vi.fn>).mock.calls[0]![1])).toBe(true);
  });

  it('uses default basePath when no options given', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(1), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(2)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient);
    await provider.lock(config());
    expect(client.get).toHaveBeenCalledWith('/shedlock/test', false);
  });

  it('strips trailing slash from basePath', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(1), pastIso()]),
      set: vi.fn().mockResolvedValue(makeStat(2)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock/' });
    await provider.lock(config());
    expect(client.get).toHaveBeenCalledWith('/shedlock/test', false);
  });

  it('handles Buffer data from get', async () => {
    const client = makeClient({
      get: vi.fn().mockResolvedValue([makeStat(5), Buffer.from(pastIso())]),
      set: vi.fn().mockResolvedValue(makeStat(6)),
    });
    const provider = new ZooKeeperLockProvider(client as unknown as ZooKeeperClient, { basePath: '/shedlock-test' });
    const lock = await provider.lock(config());
    expect(lock).toBeDefined();
  });
});

describe('ZooKeeper result-code matchers', () => {
  const syncNoNode = 'fn: "a_get" args: "/shedlock/test,false" result: "ZNONODE -101"';
  const syncBadVersion = 'fn: "a_set" args: "/shedlock/test,<buffer>,6" result: "ZBADVERSION -103"';
  const syncNodeExists = 'fn: "a_create" args: "/shedlock/test,<buffer>,0" result: "ZNODEEXISTS -110"';

  it('matches numeric codes and the promisified message form', () => {
    expect(isNoNodeException(Object.assign(new Error('No node'), { code: -101 }))).toBe(true);
    expect(isNoNodeException(new Error('-101 no node'))).toBe(true);
    expect(isBadVersionException(Object.assign(new Error('Bad version'), { code: -103 }))).toBe(true);
    expect(isBadVersionException(new Error('-103 bad version'))).toBe(true);
    expect(isNodeExistsException(Object.assign(new Error('Node exists'), { code: -110 }))).toBe(true);
    expect(isNodeExistsException(new Error('-110 node exists'))).toBe(true);
  });

  it('does not match other result codes or the synchronous fn result form', () => {
    expect(isNoNodeException(new Error('-103 bad version'))).toBe(false);
    expect(isBadVersionException(new Error('-101 no node'))).toBe(false);
    expect(isNoNodeException(new Error('-4 connection loss'))).toBe(false);
    expect(isBadVersionException(new Error('-4 connection loss'))).toBe(false);
    expect(isNoNodeException(new Error('-1010 no node'))).toBe(false);
    expect(isBadVersionException(new Error('-1030 bad version'))).toBe(false);
    expect(isNoNodeException(new Error(syncNoNode))).toBe(false);
    expect(isBadVersionException(new Error(syncBadVersion))).toBe(false);
    expect(isNoNodeException(new Error('No node'))).toBe(false);
    expect(isBadVersionException({ code: -4 })).toBe(false);
    expect(isNoNodeException(null)).toBe(false);
    expect(isBadVersionException(undefined)).toBe(false);
    expect(isNodeExistsException(new Error('-1100 node exists'))).toBe(false);
    expect(isNodeExistsException(new Error('-101 no node'))).toBe(false);
    expect(isNodeExistsException(null)).toBe(false);
    expect(isNodeExistsException(new Error(syncNodeExists))).toBe(false);
  });
});

describe('ZooKeeperLockProvider extensibility', () => {
  it('is not assignable to KeepAliveLockProvider', () => {
    const provider = new ZooKeeperLockProvider(makeClient() as unknown as ZooKeeperClient);
    const check = () => {
      // @ts-expect-error ZooKeeperLockProvider does not support extend
      new KeepAliveLockProvider(provider);
    };
    expect(check).toEqual(expect.any(Function));
    expect(() => new KeepAliveLockProvider(provider as unknown as ExtensibleLockProvider)).toThrow(LockException);
  });
});
