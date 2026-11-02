import type { S3Client } from '@aws-sdk/client-s3';
import { StorageBasedLockProvider } from '@tslock/core';
import type { S3ProviderConfig } from './s3-provider-config.js';
import { S3StorageAccessor } from './s3-storage-accessor.js';

export class S3LockProvider extends StorageBasedLockProvider {
  constructor(s3: S3Client, config: S3ProviderConfig) {
    super(new S3StorageAccessor(s3, config));
  }
}
