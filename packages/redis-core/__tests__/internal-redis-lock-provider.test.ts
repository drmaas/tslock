import { ClockProvider, createLockConfig } from '@tslock/core';
import { describe, expect, it, vi } from 'vitest';
import {
  DEL_IF_EQUALS_SCRIPT,
  EXTEND_IF_EQUALS_SCRIPT,
  InternalRedisLockProvider,
  KEEP_IF_EQUALS_SCRIPT,
  type RedisTemplate,
} from '../src/index.js';

function makeRedis(overrides: Partial<RedisTemplate> = {}): RedisTemplate & { eval: ReturnType<typeof vi.fn> } {
  return {
    setIfAbsent: vi.fn().mockResolvedValue(true),
    setIfPresent: vi.fn().mockResolvedValue(true),
    delete: vi.fn().mockResolvedValue(true),
    eval: vi.fn().mockResolvedValue(1),
    deleteKey: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as RedisTemplate & { eval: ReturnType<typeof vi.fn> };
}

describe('InternalRedisLockProvider', () => {
  it('lock() returns lock when setIfAbsent returns true', async () => {
    const redis = makeRedis({ setIfAbsent: vi.fn().mockResolvedValue(true) });
    const provider = new InternalRedisLockProvider(redis);
    const lock = await provider.lock(createLockConfig('my-task', 60_000));
    expect(lock).toBeDefined();
    expect(redis.setIfAbsent).toHaveBeenCalledOnce();
  });

  it('lock() returns undefined when setIfAbsent returns false', async () => {
    const redis = makeRedis({ setIfAbsent: vi.fn().mockResolvedValue(false) });
    const provider = new InternalRedisLockProvider(redis);
    const lock = await provider.lock(createLockConfig('my-task', 60_000));
    expect(lock).toBeUndefined();
  });

  it('buildKey uses prefix:env:name', () => {
    const redis = makeRedis();
    const provider = new InternalRedisLockProvider(redis, { keyPrefix: 'p', env: 'e' });
    expect(provider.buildKey('my-task')).toBe('p:e:my-task');
  });

  it('buildKey uses defaults when config not provided', () => {
    const redis = makeRedis();
    const provider = new InternalRedisLockProvider(redis);
    expect(provider.buildKey('my-task')).toBe('job-lock:default:my-task');
  });

  it('unlock() with safeUpdate=true calls eval with DEL script', async () => {
    const redis = makeRedis();
    const provider = new InternalRedisLockProvider(redis, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    await lock.unlock();
    expect(redis.eval).toHaveBeenCalledWith(DEL_IF_EQUALS_SCRIPT, expect.any(Array), expect.any(Array));
  });

  it('unlock() with safeUpdate=false calls deleteKey', async () => {
    const redis = makeRedis();
    const provider = new InternalRedisLockProvider(redis, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    await lock.unlock();
    expect(redis.deleteKey).toHaveBeenCalledOnce();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('extend() with safeUpdate=true calls eval with EXTEND script', async () => {
    const redis = makeRedis({ eval: vi.fn().mockResolvedValue(1) });
    const provider = new InternalRedisLockProvider(redis, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(redis.eval).toHaveBeenCalledWith(EXTEND_IF_EQUALS_SCRIPT, expect.any(Array), expect.any(Array));
  });

  it('extend() with safeUpdate=true returns undefined when eval returns 0', async () => {
    const redis = makeRedis({ eval: vi.fn().mockResolvedValue(0) });
    const provider = new InternalRedisLockProvider(redis, { safeUpdate: true });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('extend() with safeUpdate=false calls setIfPresent', async () => {
    const redis = makeRedis({ setIfPresent: vi.fn().mockResolvedValue(true) });
    const provider = new InternalRedisLockProvider(redis, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeDefined();
    expect(redis.setIfPresent).toHaveBeenCalledOnce();
  });

  it('extend() with safeUpdate=false returns undefined when setIfPresent false', async () => {
    const redis = makeRedis({ setIfPresent: vi.fn().mockResolvedValue(false) });
    const provider = new InternalRedisLockProvider(redis, { safeUpdate: false });
    const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
    const extended = await lock.extend(120_000, 0);
    expect(extended).toBeUndefined();
  });

  it('lock() value contains hostname and a UUID-shaped randomId', async () => {
    const redis = makeRedis();
    const provider = new InternalRedisLockProvider(redis);
    await provider.lock(createLockConfig('t', 60_000));
    const value = redis.setIfAbsent.mock.calls[0]![1] as string;
    expect(value.startsWith('ADDED:')).toBe(true);
    const hostname = value.slice(value.indexOf('@') + 1, value.lastIndexOf(':'));
    expect(hostname.length).toBeGreaterThan(0);
    const randomId = value.slice(value.lastIndexOf(':') + 1);
    expect(randomId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  });

  it('unlock() with lockAtLeastFor > 0 keeps the key via KEEP script (safeUpdate=true)', async () => {
    ClockProvider.setClock(() => 1_000_000);
    try {
      const redis = makeRedis();
      const provider = new InternalRedisLockProvider(redis, { safeUpdate: true });
      const lock = (await provider.lock(createLockConfig('t', 60_000, 30_000)))!;
      await lock.unlock();
      expect(redis.eval).toHaveBeenCalledOnce();
      const [script, keys, args] = redis.eval.mock.calls[0]!;
      expect(script).toBe(KEEP_IF_EQUALS_SCRIPT);
      expect(keys).toEqual(['job-lock:default:t']);
      expect(args[1]).toBe(30_000);
      expect(redis.deleteKey).not.toHaveBeenCalled();
    } finally {
      ClockProvider.resetClock();
    }
  });

  it('unlock() with lockAtLeastFor > 0 keeps the key via setIfPresent (safeUpdate=false)', async () => {
    ClockProvider.setClock(() => 1_000_000);
    try {
      const redis = makeRedis();
      const provider = new InternalRedisLockProvider(redis, { safeUpdate: false });
      const lock = (await provider.lock(createLockConfig('t', 60_000, 30_000)))!;
      await lock.unlock();
      expect(redis.setIfPresent).toHaveBeenCalledOnce();
      const [key, value, expireMs] = redis.setIfPresent.mock.calls[0]!;
      expect(key).toBe('job-lock:default:t');
      expect(typeof value).toBe('string');
      expect(expireMs).toBe(30_000);
      expect(redis.deleteKey).not.toHaveBeenCalled();
    } finally {
      ClockProvider.resetClock();
    }
  });

  it('unlock() with lockAtLeastFor = 0 still deletes', async () => {
    ClockProvider.setClock(() => 1_000_000);
    try {
      const redis = makeRedis();
      const provider = new InternalRedisLockProvider(redis);
      const lock = (await provider.lock(createLockConfig('t', 60_000)))!;
      await lock.unlock();
      expect(redis.eval).toHaveBeenCalledWith(DEL_IF_EQUALS_SCRIPT, expect.any(Array), expect.any(Array));
    } finally {
      ClockProvider.resetClock();
    }
  });
});
