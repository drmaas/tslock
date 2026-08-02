import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { type RedisClientType, createClient } from 'redis';
import { afterAll, describe, expect, it } from 'vitest';
import { createNodeRedisLockProvider } from '../../src/node-redis-lock-provider.js';

const enabled = process.env.TSLOCK_REDIS_INTEGRATION === '1';
const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
let client: RedisClientType | undefined;
let available = false;

if (enabled) {
  const candidate = createClient({ url, socket: { connectTimeout: 500 } });
  try {
    await candidate.connect();
    await candidate.ping();
    client = candidate;
    available = true;
  } catch {
    if (candidate.isOpen) await candidate.disconnect();
  }
}

const integrationDescribe = enabled ? describe : describe.skip;

integrationDescribe('node-redis integration', () => {
  afterAll(async () => {
    if (client?.isOpen) await client.quit();
  });

  it('connects to Redis', () => {
    expect(available).toBe(true);
  });

  if (available) {
    const getProvider = async () => createNodeRedisLockProvider(client!);
    extensibleLockProviderIntegrationTests(getProvider);
    fuzzTests(getProvider);
  }
});
