import { LockException, Utils } from '@tslock/core';

export interface GcsProviderConfig {
  bucket: string;
  objectPrefix: string;
  lockedBy: string;
}

export function createGcsProviderConfig(input: {
  bucket: string;
  objectPrefix?: string;
  lockedBy?: string;
}): GcsProviderConfig {
  if (!input.bucket) {
    throw new LockException('bucket must be a non-empty string');
  }
  return {
    bucket: input.bucket,
    objectPrefix: input.objectPrefix ?? 'shedlock/',
    lockedBy: input.lockedBy ?? Utils.getHostname(),
  };
}
