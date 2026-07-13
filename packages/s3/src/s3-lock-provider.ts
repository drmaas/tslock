import type { S3Client } from '@aws-sdk/client-s3';
import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
  StorageBasedLockProvider,
} from '@tslock/core';
import type { S3ProviderConfig } from './s3-provider-config.js';
import { S3StorageAccessor } from './s3-storage-accessor.js';

export class S3LockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(s3: S3Client, config: S3ProviderConfig) {
    const accessor = new S3StorageAccessor(s3, config);
    this.delegate = new StorageBasedLockProvider(accessor);
  }

  lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.delegate.lock(config);
  }

  clearCache(name: string): void {
    this.delegate.clearCache(name);
  }
}
