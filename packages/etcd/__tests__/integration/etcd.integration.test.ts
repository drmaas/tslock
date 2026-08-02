import { fuzzTests, lockProviderIntegrationTests } from '@tslock/test-support';
import { Etcd3 } from 'etcd3';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll } from 'vitest';
import { EtcdLockProvider } from '../../src/etcd-lock-provider.js';

let container: StartedTestContainer | undefined;
let client: Etcd3 | undefined;
let provider: EtcdLockProvider | undefined;

beforeAll(async () => {
  container = await new GenericContainer('quay.io/coreos/etcd:v3.5.15')
    .withCommand([
      '/usr/local/bin/etcd',
      '--name',
      's1',
      '--data-dir',
      '/etcd-data',
      '--listen-client-urls',
      'http://0.0.0.0:2379',
      '--advertise-client-urls',
      'http://0.0.0.0:2379',
      '--listen-peer-urls',
      'http://0.0.0.0:2380',
      '--initial-advertise-peer-urls',
      'http://0.0.0.0:2380',
      '--initial-cluster',
      's1=http://0.0.0.0:2380',
      '--initial-cluster-token',
      'tslock-integration',
      '--initial-cluster-state',
      'new',
    ])
    .withExposedPorts(2379)
    .withWaitStrategy(Wait.forLogMessage(/ready to serve client requests/))
    .start();
  try {
    client = new Etcd3({ hosts: `${container.getHost()}:${container.getMappedPort(2379)}` });
    provider = new EtcdLockProvider(client);
    await client.get('tslock:readiness').string();
  } catch (error) {
    client?.close();
    await container.stop().catch(() => undefined);
    client = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async () => {
  if (!provider) throw new Error('etcd integration provider was not initialized');
  return provider;
};

lockProviderIntegrationTests(getProvider);
fuzzTests(getProvider);

afterAll(async () => {
  client?.close();
  await container?.stop();
});
