import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import Redis from 'ioredis';
import { afterAll, describe, expect, it } from 'vitest';
import { createIoRedisLockProvider } from '../../src/io-redis-lock-provider.js';

const enabled = process.env.TSLOCK_REDIS_INTEGRATION === '1';
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
let client: Redis | undefined;
let available = false;

if (enabled) {
  const candidate = new Redis(url, { lazyConnect: true, connectTimeout: 500, maxRetriesPerRequest: 1 });
  try {
    await candidate.connect();
    await candidate.ping();
    client = candidate;
    available = true;
  } catch {
    candidate.disconnect();
  }
}

const integrationDescribe = enabled ? describe : describe.skip;

integrationDescribe('ioredis integration', () => {
  afterAll(() => {
    client?.disconnect();
  });

  it('connects to Redis', () => {
    expect(available).toBe(true);
  });

  if (available) {
    const getProvider = async () => createIoRedisLockProvider(client!);
    extensibleLockProviderIntegrationTests(getProvider);
    fuzzTests(getProvider);
  }
});
