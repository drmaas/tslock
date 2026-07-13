import { ClockProvider, LockException, createLockConfig } from '@tslock/core';
import type { KV, KeyValueEntry } from 'nats';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { longToBytes } from '../src/long-utils.js';
import { NatsLockProvider } from '../src/nats-lock-provider.js';
import { NatsLock } from '../src/nats-lock.js';

function mockKv(): KV {
  return {
    get: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  } as unknown as KV;
}

function entry(value: number, revision = 1): KeyValueEntry {
  return {
    value: longToBytes(value),
    revision,
    key: '',
    bucket: '',
    delta: 0,
    created: new Date(),
  };
}

describe('NatsLockProvider', () => {
  let kv: KV;
  let provider: NatsLockProvider;

  beforeEach(() => {
    kv = mockKv();
    provider = new NatsLockProvider(kv);
    ClockProvider.resetClock();
  });

  describe('lock()', () => {
    it('returns NatsLock when key does not exist and create succeeds', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(null);
      vi.mocked(kv.create).mockResolvedValueOnce(1);

      const result = await provider.lock(config);
      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(NatsLock);
      expect(kv.create).toHaveBeenCalledWith('test', longToBytes(1_060_000));
    });

    it('returns undefined when key does not exist and create conflicts', async () => {
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(null);
      vi.mocked(kv.create).mockRejectedValueOnce({ code: 10071, message: 'Conflict' });

      const result = await provider.lock(config);
      expect(result).toBeUndefined();
    });

    it('propagates non-conflict error on create', async () => {
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(null);
      vi.mocked(kv.create).mockRejectedValueOnce(new Error('network error'));

      await expect(provider.lock(config)).rejects.toThrow('network error');
    });

    it('returns undefined when key exists and not expired', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(1_010_000));

      const result = await provider.lock(config);
      expect(result).toBeUndefined();
      expect(kv.create).not.toHaveBeenCalled();
      expect(kv.update).not.toHaveBeenCalled();
    });

    it('returns NatsLock when key exists and expired, update succeeds', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(999_000));
      vi.mocked(kv.update).mockResolvedValueOnce(2);

      const result = await provider.lock(config);
      expect(result).toBeDefined();
      expect(result).toBeInstanceOf(NatsLock);
      expect(kv.update).toHaveBeenCalledWith('test', longToBytes(1_060_000), 1);
    });

    it('returns undefined when key exists and expired, update conflicts', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(999_000));
      vi.mocked(kv.update).mockRejectedValueOnce({ code: 10071 });

      const result = await provider.lock(config);
      expect(result).toBeUndefined();
    });

    it('propagates non-conflict error on update', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(999_000));
      vi.mocked(kv.update).mockRejectedValueOnce(new Error('network error'));

      await expect(provider.lock(config)).rejects.toThrow('network error');
    });
  });

  describe('unlock()', () => {
    it('no-op when entry is null', async () => {
      const config = createLockConfig('test', 60_000);
      const lock = new NatsLock(kv, config);
      vi.mocked(kv.get).mockResolvedValueOnce(null);

      await lock.unlock();
      expect(kv.delete).not.toHaveBeenCalled();
      expect(kv.update).not.toHaveBeenCalled();
    });

    it('no-op when stored lockUntil > lockAtMostUntil', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000);
      const lock = new NatsLock(kv, config);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(1_070_000));

      await lock.unlock();
      expect(kv.delete).not.toHaveBeenCalled();
      expect(kv.update).not.toHaveBeenCalled();
    });

    it('deletes key when lockAtLeastFor is 0', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000, 0);
      const lock = new NatsLock(kv, config);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(1_060_000));

      await lock.unlock();
      expect(kv.delete).toHaveBeenCalledWith('test');
      expect(kv.update).not.toHaveBeenCalled();
    });

    it('updates key to lockAtLeastUntil when still in lockAtLeastFor window', async () => {
      ClockProvider.setClock(() => 1_000_000);
      const config = createLockConfig('test', 60_000, 5_000);
      const lock = new NatsLock(kv, config);
      vi.mocked(kv.get).mockResolvedValueOnce(entry(1_060_000, 1));

      await lock.unlock();
      expect(kv.update).toHaveBeenCalledWith('test', longToBytes(1_005_000), 1);
      expect(kv.delete).not.toHaveBeenCalled();
    });
  });

  describe('extend()', () => {
    it('throws LockException (not supported)', async () => {
      const config = createLockConfig('test', 60_000);
      vi.mocked(kv.get).mockResolvedValueOnce(null);
      vi.mocked(kv.create).mockResolvedValueOnce(1);

      const lock = (await provider.lock(config))!;
      await expect(lock.extend(60_000, 0)).rejects.toThrow(LockException);
      await expect(lock.extend(60_000, 0)).rejects.toThrow('Extend not supported');
    });
  });
});
