import type { Storage } from '@google-cloud/storage';
import { createLockConfig } from '@tslock/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GcsLockProvider } from '../src/gcs-lock-provider.js';
import type { GcsProviderConfig } from '../src/gcs-provider-config.js';
import { createGcsProviderConfig } from '../src/gcs-provider-config.js';

describe('GcsLockProvider', () => {
  let mockFile: {
    exists: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    getMetadata: ReturnType<typeof vi.fn>;
    save: ReturnType<typeof vi.fn>;
    setMetadata: ReturnType<typeof vi.fn>;
  };
  let mockBucket: { file: ReturnType<typeof vi.fn> };
  let mockStorage: Storage;
  let providerConfig: GcsProviderConfig;

  beforeEach(() => {
    mockFile = {
      exists: vi.fn(),
      get: vi.fn(),
      getMetadata: vi.fn(),
      save: vi.fn(),
      setMetadata: vi.fn(),
    };
    mockBucket = { file: vi.fn().mockReturnValue(mockFile) };
    mockStorage = { bucket: vi.fn().mockReturnValue(mockBucket) } as unknown as Storage;
    providerConfig = createGcsProviderConfig({
      bucket: 'test-bucket',
      lockedBy: 'test-host',
    });
  });

  it('first lock acquires via insertRecord, second lock via updateRecord', async () => {
    mockFile.exists.mockResolvedValue([false]);
    mockFile.save.mockResolvedValue(undefined);

    const provider = new GcsLockProvider(mockStorage, providerConfig);
    const config = createLockConfig('test', 10000, 1000);

    const lock1 = await provider.lock(config);
    expect(lock1).toBeDefined();
    expect(mockFile.save).toHaveBeenCalledTimes(1);

    mockFile.exists.mockResolvedValue([true]);
    mockFile.getMetadata.mockResolvedValue([
      {
        generation: '1',
        metadata: {
          lockUntil: '1970-01-01T00:00:01.000Z',
          lockedBy: 'test-host',
          lockedAt: '1970-01-01T00:00:00.000Z',
          lockName: 'test',
        },
      },
    ]);
    mockFile.save.mockResolvedValue(undefined);

    const lock2 = await provider.lock(config);
    expect(lock2).toBeDefined();
    expect(mockFile.save).toHaveBeenCalledTimes(2);
  });

  it('clearCache resets registry so next call tries insertRecord', async () => {
    mockFile.exists.mockResolvedValue([false]);
    mockFile.save.mockResolvedValue(undefined);

    const provider = new GcsLockProvider(mockStorage, providerConfig);
    const config = createLockConfig('test', 10000, 1000);

    const lock1 = await provider.lock(config);
    expect(lock1).toBeDefined();

    provider.clearCache('test');

    mockFile.exists.mockResolvedValue([false]);
    mockFile.save.mockResolvedValue(undefined);

    const lock2 = await provider.lock(config);
    expect(lock2).toBeDefined();
    expect(mockFile.save).toHaveBeenCalledTimes(2);
  });
});
