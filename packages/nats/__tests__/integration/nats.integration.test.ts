import { fuzzTests, lockProviderIntegrationTests } from '@tslock/test-support';
import { type KV, type NatsConnection, StorageType, connect } from 'nats';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { NatsLockProvider } from '../../src/nats-lock-provider.js';

let container: StartedTestContainer | undefined;
let connection: NatsConnection | undefined;
let provider: NatsLockProvider | undefined;

beforeAll(async () => {
  container = await new GenericContainer('nats:2.10-alpine')
    .withCommand(['-js'])
    .withExposedPorts(4222)
    .withWaitStrategy(Wait.forListeningPorts())
    .start();

  try {
    connection = await connect({
      servers: `nats://${container.getHost()}:${container.getMappedPort(4222)}`,
    });
    const kv: KV = await connection.jetstream().views.kv('tslock-integration', {
      storage: StorageType.Memory,
    });
    provider = new NatsLockProvider(kv);
  } catch (error) {
    try {
      await connection?.close();
    } finally {
      await container.stop().catch(() => undefined);
      connection = undefined;
      container = undefined;
    }
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('NATS integration provider was not initialized');
  return provider;
};

lockProviderIntegrationTests(getProvider);
fuzzTests(getProvider);

afterAll(async () => {
  try {
    await connection?.drain();
  } finally {
    try {
      await connection?.close();
    } finally {
      await container?.stop();
    }
  }
});
