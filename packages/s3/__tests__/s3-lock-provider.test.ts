import type { S3Client } from '@aws-sdk/client-s3';
import { createLockConfig, type SimpleLock, StorageBasedLockProvider } from '@tslock/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { S3LockProvider } from '../src/s3-lock-provider.js';
import type { S3ProviderConfig } from '../src/s3-provider-config.js';
import { createS3ProviderConfig } from '../src/s3-provider-config.js';
import { S3StorageAccessor } from '../src/s3-storage-accessor.js';

describe('S3LockProvider', () => {
  let mockSend: ReturnType<typeof vi.fn>;
  let s3Client: S3Client;
  let providerConfig: S3ProviderConfig;

  beforeEach(() => {
    mockSend = vi.fn();
    s3Client = { send: mockSend } as unknown as S3Client;
    providerConfig = createS3ProviderConfig({
      bucket: 'test-bucket',
    });
  });

  it('first lock acquires via insertRecord, second lock via updateRecord', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

    const provider = new S3LockProvider(s3Client, providerConfig);
    const config = createLockConfig('test', 10000, 1000);

    const lock1 = await provider.lock(config);
    expect(lock1).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(2);

    mockSend
      .mockResolvedValueOnce({
        ETag: '"etag1"',
        Metadata: {
          lockuntil: '1970-01-01T00:00:01.000Z',
          lockedby: 'host',
          lockedat: '1970-01-01T00:00:00.000Z',
        },
        $metadata: { httpStatusCode: 200 },
      })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

    const lock2 = await provider.lock(config);
    expect(lock2).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });

  it('clearCache resets registry so next call tries insertRecord', async () => {
    mockSend
      .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

    const provider = new S3LockProvider(s3Client, providerConfig);
    const config = createLockConfig('test', 10000, 1000);

    const lock1 = await provider.lock(config);
    expect(lock1).toBeDefined();

    provider.clearCache('test');

    mockSend
      .mockRejectedValueOnce({ name: 'NotFound', $metadata: { httpStatusCode: 404 } })
      .mockResolvedValueOnce({ $metadata: { httpStatusCode: 200 } });

    const lock2 = await provider.lock(config);
    expect(lock2).toBeDefined();
    expect(mockSend).toHaveBeenCalledTimes(4);
  });
});
