import { ClockProvider, createLockConfig } from '@tslock/core';
import { withMutableClock } from '@tslock/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import type { CloudflareKvLockProviderOptions } from '../src/cloudflare-kv-configuration.js';
import { createCloudflareKvLockProvider } from '../src/cloudflare-kv-lock-provider.js';
import { decodeLockRecord } from '../src/lock-record.js';
import { MemoryKvNamespace, PopCacheKv, RateLimitedKv } from './memory-kv.js';

function providerFor(kv: CloudflareKvLockProviderOptions['kv']) {
  return createCloudflareKvLockProvider({
    kv,
    acknowledgeAdvisoryLock: true,
  });
}

describe('Workers KV documented failure modes', () => {
  afterEach(() => {
    ClockProvider.resetClock();
  });

  it('lets two cached misses both acquire (stale reads, two holders)', async () => {
    await withMutableClock(1_000_000, async () => {
      const central = { value: null as string | null };
      const popA = new PopCacheKv(central, null);
      const popB = new PopCacheKv(central, null);
      const first = await providerFor(popA).lock(createLockConfig('job', 60_000));
      const second = await providerFor(popB).lock(createLockConfig('job', 60_000));
      expect(first).toBeDefined();
      expect(second).toBeDefined();
    });
  });

  it('keeps a cached value after delete so the next acquire skips (delayed delete)', async () => {
    await withMutableClock(1_000_000, async () => {
      const central = { value: null as string | null };
      const writer = new PopCacheKv(central, undefined);
      const reader = new PopCacheKv(central, undefined);
      const lock = await providerFor(writer).lock(createLockConfig('job', 60_000));
      expect(lock).toBeDefined();
      reader.cache = central.value;
      await lock?.unlock();
      expect(central.value).toBeNull();
      expect(await providerFor(reader).lock(createLockConfig('job', 60_000))).toBeUndefined();
      reader.cache = undefined;
      const next = await providerFor(reader).lock(createLockConfig('job', 60_000));
      expect(next).toBeDefined();
      await next?.unlock();
    });
  });

  it('uses the 60 second KV TTL floor while logical lockUntil still gates acquire', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const kv = new MemoryKvNamespace();
      const locks = providerFor(kv);
      expect(await locks.lock(createLockConfig('short', 5_000))).toBeDefined();
      expect(kv.entries.get('tslock:short')?.expirationTtl).toBeGreaterThanOrEqual(60);
      expect(kv.entries.has('tslock:short')).toBe(true);
      clock.advance(5_001);
      expect(await locks.lock(createLockConfig('short', 5_000))).toBeDefined();
    });
  });

  it('propagates a one-write-per-second rejection instead of reporting success', async () => {
    await withMutableClock(1_000_000, async () => {
      const kv = new RateLimitedKv();
      const lock = await providerFor(kv).lock(createLockConfig('hot', 60_000));
      expect(lock).toBeDefined();
      await expect(lock?.unlock()).rejects.toThrow(/429/);
      expect(kv.entries.has('tslock:hot')).toBe(true);
    });
  });

  it('deletes on a stale read of our own token and can drop a newer holder', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const central = { value: null as string | null };
      const popA = new PopCacheKv(central, undefined);
      const first = await providerFor(popA).lock(createLockConfig('job', 5_000));
      expect(first).toBeDefined();
      const staleToken = decodeLockRecord(popA.cache ?? '').token;
      clock.advance(5_001);
      const popB = new PopCacheKv(central, undefined);
      const second = await providerFor(popB).lock(createLockConfig('job', 60_000));
      expect(second).toBeDefined();
      expect(decodeLockRecord(central.value ?? '').token).not.toBe(staleToken);
      popA.cache = JSON.stringify({
        lockUntil: 1_005_000,
        lockedAt: 1_000_000,
        lockedBy: 'stale',
        token: staleToken,
      });
      await first?.unlock();
      expect(central.value).toBeNull();
      const third = await providerFor(new PopCacheKv(central, undefined)).lock(createLockConfig('job', 60_000));
      expect(third).toBeDefined();
    });
  });
});
