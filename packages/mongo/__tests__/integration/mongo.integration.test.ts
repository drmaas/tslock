import { MongoDBContainer } from '@testcontainers/mongodb';
import { extensibleLockProviderIntegrationTests, fuzzTests } from '@tslock/test-support';
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll } from 'vitest';
import { createMongoLockProvider } from '../../src/mongo-lock-provider.js';

let container: Awaited<ReturnType<MongoDBContainer['start']>> | undefined;
let client: MongoClient | undefined;
let provider: ReturnType<typeof createMongoLockProvider> | undefined;

beforeAll(async () => {
  container = await new MongoDBContainer('mongo:7').start();
  try {
    client = new MongoClient(container.getConnectionString());
    await client.connect();
    provider = createMongoLockProvider(client.db('tslock_test'));
  } catch (error) {
    await client?.close().catch(() => undefined);
    await container.stop().catch(() => undefined);
    client = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('MongoDB integration provider was not initialized');
  return provider;
};

extensibleLockProviderIntegrationTests(getProvider);
fuzzTests(getProvider);

afterAll(async () => {
  try {
    await client?.close();
  } finally {
    await container?.stop();
  }
});
