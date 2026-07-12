import { LockException } from '@tslock/core';

export interface S3ProviderConfig {
  bucket: string;
  objectPrefix: string;
}

export function createS3ProviderConfig(input: {
  bucket: string;
  objectPrefix?: string;
}): S3ProviderConfig {
  if (!input.bucket) {
    throw new LockException('bucket must be a non-empty string');
  }
  return {
    bucket: input.bucket,
    objectPrefix: input.objectPrefix ?? 'shedlock/',
  };
}
