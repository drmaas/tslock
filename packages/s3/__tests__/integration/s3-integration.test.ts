import { randomUUID } from 'node:crypto';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import { LocalstackContainer, type StartedLocalStackContainer } from '@testcontainers/localstack';
import type { StorageBasedLockProvider } from '@tslock/core';
import { fuzzTests, storageBasedLockProviderIntegrationTests } from '@tslock/test-support';
import { afterAll, beforeAll } from 'vitest';
import { S3LockProvider } from '../../src/s3-lock-provider.js';
import { createS3ProviderConfig } from '../../src/s3-provider-config.js';
import { S3StorageAccessor } from '../../src/s3-storage-accessor.js';

let container: StartedLocalStackContainer | undefined;
let s3: S3Client | undefined;
let provider: S3LockProvider | undefined;
let accessor: S3StorageAccessor | undefined;

beforeAll(async () => {
  container = await new LocalstackContainer('localstack/localstack:s3-latest')
    .withEnvironment({ SERVICES: 's3' })
    .start();
  try {
    const endpoint = container.getConnectionUri();
    s3 = new S3Client({
      endpoint,
      region: 'us-east-1',
      credentials: {
        accessKeyId: 'test',
        secretAccessKey: 'test',
      },
      forcePathStyle: true,
    });
    const bucket = `tslock-test-${randomUUID()}`;
    await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    const providerConfig = createS3ProviderConfig({ bucket, objectPrefix: 'shedlock/' });
    provider = new S3LockProvider(s3, providerConfig);
    accessor = new S3StorageAccessor(s3, providerConfig);
  } catch (error) {
    s3?.destroy();
    await container.stop().catch(() => undefined);
    s3 = undefined;
    container = undefined;
    throw error;
  }
}, 120_000);

const getProvider = async (): Promise<StorageBasedLockProvider> => {
  if (!provider) throw new Error('S3 integration provider was not initialized');
  return provider as unknown as StorageBasedLockProvider;
};

const getAccessor = async () => {
  if (!accessor) throw new Error('S3 integration accessor was not initialized');
  return accessor;
};

storageBasedLockProviderIntegrationTests(getProvider, { timeMode: 'real', getAccessor });
fuzzTests(getProvider);

afterAll(async () => {
  try {
    s3?.destroy();
  } finally {
    await container?.stop();
  }
});
