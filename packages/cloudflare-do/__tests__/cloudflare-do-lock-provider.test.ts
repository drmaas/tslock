import { ClockProvider, createLockConfig, Utils } from '@tslock/core';
import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createCloudflareDoLockProvider } from '../src/cloudflare-do-lock-provider.js';
import { createMemoryDoLockStorage, type DoLockStorage } from '../src/do-lock-storage.js';
import { handleTslockLockRequest } from '../src/handle-lock-request.js';

function createInProcessProvider(storage: DoLockStorage = createMemoryDoLockStorage()) {
  let chain: Promise<unknown> = Promise.resolve();
  const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };
  return createCloudflareDoLockProvider({
    fetch: (lockName, init) =>
      serialized(() =>
        handleTslockLockRequest(
          storage,
          new Request(`https://do.local/lock?name=${encodeURIComponent(lockName)}`, init),
          ClockProvider.now(),
        ),
      ),
  });
}

describe('CloudflareDoLockProvider', () => {
  beforeEach(() => {
    ClockProvider.resetClock();
    ClockProvider.setClock(() => 1_000_000);
  });

  it('acquires and skips while held', async () => {
    const provider = createInProcessProvider();
    const lock1 = await provider.lock(createLockConfig('job', 60_000));
    expect(lock1).toBeDefined();
    const lock2 = await provider.lock(createLockConfig('job', 60_000));
    expect(lock2).toBeUndefined();
    await lock1!.unlock();
  });

  it('extends when owner', async () => {
    const provider = createInProcessProvider();
    const lock = await provider.lock(createLockConfig('job', 60_000));
    expect(lock).toBeDefined();
    const extended = await lock!.extend(120_000, 0);
    expect(extended).toBeDefined();
    await extended!.unlock();
  });

  it('keeps the holder when hostname() is localhost and another provider calls unlock(config)', async () => {
    const hostname = vi.spyOn(Utils, 'getHostname').mockReturnValue('localhost');
    try {
      const storage = createMemoryDoLockStorage();
      const bodies: Array<{ op: string; lockedBy?: string; token?: string }> = [];
      let chain: Promise<unknown> = Promise.resolve();
      const serialized = <T>(fn: () => Promise<T>): Promise<T> => {
        const next = chain.then(fn, fn);
        chain = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      };
      const fetch = (lockName: string, init: RequestInit) =>
        serialized(async () => {
          bodies.push(JSON.parse(String(init.body)) as { op: string; lockedBy?: string; token?: string });
          return handleTslockLockRequest(
            storage,
            new Request(`https://do.local/lock?name=${encodeURIComponent(lockName)}`, init),
            ClockProvider.now(),
          );
        });
      const holder = createCloudflareDoLockProvider({ fetch });
      const other = createCloudflareDoLockProvider({ fetch });
      const config = createLockConfig('job', 60_000);

      const lock = await holder.lock(config);
      expect(lock).toBeDefined();
      expect(bodies[0]).toMatchObject({ op: 'lock', lockedBy: 'localhost' });
      expect(bodies[0]?.token).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);

      expect(await other.lock(createLockConfig('job', 60_000))).toBeUndefined();
      expect(bodies[1]).toMatchObject({ op: 'lock', lockedBy: 'localhost' });
      expect(bodies[1]?.token).not.toBe(bodies[0]?.token);

      const holderToken = bodies[0]?.token;
      await other.unlock(config);
      expect(bodies.some((body) => body.op === 'unlock' && body.token === holderToken)).toBe(false);
      expect(await other.lock(createLockConfig('job', 60_000))).toBeUndefined();

      await lock!.unlock();
      expect(
        bodies.some((body) => body.op === 'unlock' && body.token === holderToken && body.lockedBy === 'localhost'),
      ).toBe(true);
      expect(await other.lock(createLockConfig('job', 60_000))).toBeDefined();
    } finally {
      hostname.mockRestore();
    }
  });
});

describe('Cloudflare DO in-process shared contracts', () => {
  const getProvider = async () => createInProcessProvider();
  extensibleLockProviderIntegrationTests(getProvider, { timeMode: 'mock' });
  fuzzTests(getProvider);
});
