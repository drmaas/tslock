import { fuzzTests, lockProviderIntegrationTests } from '@tslock/test-support';
import { Client } from 'memjs';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { MemcachedLockProvider } from '../../src/memcached-lock-provider.js';

let container: StartedTestContainer | undefined;
let client: Client | undefined;
let provider: MemcachedLockProvider | undefined;

beforeAll(async () => {
  container = await new GenericContainer('memcached:alpine')
    .withExposedPorts(11211)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();
  try {
    client = Client.create(`${container.getHost()}:${container.getMappedPort(11211)}`);
    provider = new MemcachedLockProvider(client);
  } catch (error) {
    client?.quit();
    await container.stop().catch(() => undefined);
    client = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('Memcached integration provider was not initialized');
  return provider;
};

lockProviderIntegrationTests(getProvider);
fuzzTests(getProvider);

afterAll(async () => {
  client?.quit();
  await container?.stop();
});
