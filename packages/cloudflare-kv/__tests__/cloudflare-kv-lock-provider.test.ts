import { ClockProvider, createLockConfig, LockException } from '@tslock/core';
import { extensibleLockProviderIntegrationTests, withMutableClock } from '@tslock/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { resolveCloudflareKvConfiguration } from '../src/cloudflare-kv-configuration.js';
import { createCloudflareKvLockProvider } from '../src/cloudflare-kv-lock-provider.js';
import { createCloudflareKvRestNamespace } from '../src/cloudflare-kv-namespace.js';
import { CLOUDFLARE_KV_MIN_EXPIRATION_TTL_SECONDS, kvExpirationTtlSeconds } from '../src/kv-expiration.js';
import { decodeLockRecord } from '../src/lock-record.js';
import { MemoryKvNamespace } from './memory-kv.js';

function provider(kv: MemoryKvNamespace, confirmWrite = true) {
  return createCloudflareKvLockProvider({
    kv,
    acknowledgeAdvisoryLock: true,
    confirmWrite,
  });
}

describe('kvExpirationTtlSeconds', () => {
  it('floors short leases at 60 seconds', () => {
    expect(kvExpirationTtlSeconds(5_000, 0)).toBe(CLOUDFLARE_KV_MIN_EXPIRATION_TTL_SECONDS);
    expect(kvExpirationTtlSeconds(60_000, 0)).toBe(61);
    expect(kvExpirationTtlSeconds(90_000, 0)).toBe(91);
  });
});

describe('resolveCloudflareKvConfiguration', () => {
  const kv = new MemoryKvNamespace();

  it('requires an acknowledged advisory namespace', () => {
    expect(() => resolveCloudflareKvConfiguration({ kv, acknowledgeAdvisoryLock: true })).not.toThrow();
    expect(() => resolveCloudflareKvConfiguration({ kv, acknowledgeAdvisoryLock: false as unknown as true })).toThrow(
      LockException,
    );
    expect(() =>
      resolveCloudflareKvConfiguration({
        kv: {} as MemoryKvNamespace,
        acknowledgeAdvisoryLock: true,
      }),
    ).toThrow(LockException);
  });

  it('rejects a NUL prefix and a non-boolean confirmWrite', () => {
    expect(() => resolveCloudflareKvConfiguration({ kv, acknowledgeAdvisoryLock: true, keyPrefix: 'bad\0' })).toThrow(
      LockException,
    );
    expect(() =>
      resolveCloudflareKvConfiguration({
        kv,
        acknowledgeAdvisoryLock: true,
        confirmWrite: 'yes' as unknown as boolean,
      }),
    ).toThrow(LockException);
  });
});

describe('CloudflareKvLockProvider', () => {
  beforeEach(() => {
    ClockProvider.resetClock();
  });

  it('stores a 60 second TTL for a short logical lease and still expires on lockUntil', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const kv = new MemoryKvNamespace();
      const locks = provider(kv);
      const first = await locks.lock(createLockConfig('job', 5_000));
      expect(first).toBeDefined();
      const stored = kv.entries.get('tslock:job');
      expect(stored?.expirationTtl).toBe(60);
      expect(decodeLockRecord(stored?.value ?? '').lockUntil).toBe(1_005_000);

      expect(await locks.lock(createLockConfig('job', 5_000))).toBeUndefined();
      clock.advance(5_001);
      const second = await locks.lock(createLockConfig('job', 5_000));
      expect(second).toBeDefined();
      await second?.unlock();
    });
  });

  it('does not let a late unlock release a newer holder when the read is fresh', async () => {
    await withMutableClock(1_000_000, async (clock) => {
      const kv = new MemoryKvNamespace();
      const locks = provider(kv);
      const first = await locks.lock(createLockConfig('job', 5_000));
      expect(first).toBeDefined();
      clock.advance(5_001);
      const second = await locks.lock(createLockConfig('job', 30_000));
      expect(second).toBeDefined();
      await first?.unlock();
      expect(await locks.lock(createLockConfig('job', 30_000))).toBeUndefined();
      await second?.unlock();
    });
  });

  it('rejects a malformed record instead of treating it as free', async () => {
    const kv = new MemoryKvNamespace();
    await kv.put('tslock:job', '{"nope":true}');
    await expect(provider(kv).lock(createLockConfig('job', 30_000))).rejects.toBeInstanceOf(LockException);
  });

  it('returns undefined when the confirm read does not show our token', async () => {
    const kv = new MemoryKvNamespace();
    const originalGet = kv.get.bind(kv);
    let reads = 0;
    kv.get = async (key: string) => {
      reads += 1;
      if (reads === 2) return JSON.stringify({ lockUntil: 9, lockedAt: 1, lockedBy: 'other', token: 'other' });
      return originalGet(key);
    };
    const lock = await provider(kv).lock(createLockConfig('job', 30_000));
    expect(lock).toBeUndefined();
    expect(kv.entries.has('tslock:job')).toBe(true);
  });

  it('throws when the storage key exceeds 512 bytes', async () => {
    const kv = new MemoryKvNamespace();
    await expect(provider(kv).lock(createLockConfig('x'.repeat(600), 30_000))).rejects.toBeInstanceOf(LockException);
  });
});

describe('Cloudflare KV in-memory shared contracts', () => {
  const kv = new MemoryKvNamespace();
  const getProvider = async () => provider(kv);
  extensibleLockProviderIntegrationTests(getProvider, { timeMode: 'mock' });
});

describe('createCloudflareKvRestNamespace', () => {
  it('maps get, put, delete, and HTTP errors', async () => {
    const calls: Array<{ url: string; method: string; body?: string }> = [];
    const fetchImpl = async (input: string | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const method = init?.method ?? 'GET';
      calls.push({ url, method, body: typeof init?.body === 'string' ? init.body : undefined });
      if (method === 'GET' && url.endsWith('missing')) return new Response('not found', { status: 404 });
      if (method === 'GET') return new Response('value', { status: 200 });
      if (method === 'PUT' && url.includes('boom')) return new Response('nope', { status: 429 });
      if (method === 'DELETE') return new Response(null, { status: 200 });
      return new Response(null, { status: 200 });
    };
    const kv = createCloudflareKvRestNamespace({
      accountId: 'acct',
      namespaceId: 'ns',
      apiToken: 'token',
      fetch: fetchImpl,
    });

    expect(await kv.get('missing')).toBeNull();
    expect(await kv.get('locks/job')).toBe('value');
    await kv.put('locks/job', '{"token":"t"}', { expirationTtl: 60 });
    await kv.delete('locks/job');
    await expect(kv.put('boom', 'x', { expirationTtl: 60 })).rejects.toBeInstanceOf(LockException);

    expect(calls[0]?.url).toContain('/accounts/acct/storage/kv/namespaces/ns/values/missing');
    expect(calls[2]?.url).toContain('expiration_ttl=60');
    expect(calls[2]?.url).toContain('locks%2Fjob');
    expect(calls[2]?.body).toBe('{"token":"t"}');
    expect(() => createCloudflareKvRestNamespace({ accountId: ' ', namespaceId: 'ns', apiToken: 'token' })).toThrow(
      LockException,
    );
  });
});
