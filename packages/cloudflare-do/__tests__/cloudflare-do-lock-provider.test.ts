import { ClockProvider, createLockConfig } from '@tslock/core';
import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { createCloudflareDoLockProvider } from '../src/cloudflare-do-lock-provider.js';
import { createMemoryDoLockStorage } from '../src/do-lock-storage.js';
import { handleTslockLockRequest } from '../src/handle-lock-request.js';

function createInProcessProvider() {
  const storage = createMemoryDoLockStorage();
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
});

describe('Cloudflare DO in-process shared contracts', () => {
  const getProvider = async () => createInProcessProvider();
  extensibleLockProviderIntegrationTests(getProvider, { timeMode: 'mock' });
  fuzzTests(getProvider);
});
