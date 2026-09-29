import type { CloudFrontKeyValueStoreClient } from '@aws-sdk/client-cloudfront-keyvaluestore';
import { LockException } from '@tslock/core';

export interface CloudFrontKvsLockProviderOptions {
  client: CloudFrontKeyValueStoreClient;
  kvsArn: string;
  keyPrefix?: string;
  maxEtagRetries?: number;
}

export interface CloudFrontKvsConfiguration {
  readonly client: CloudFrontKeyValueStoreClient;
  readonly kvsArn: string;
  readonly keyPrefix: string;
  readonly maxEtagRetries: number;
}

export function resolveCloudFrontKvsConfiguration(input: CloudFrontKvsLockProviderOptions): CloudFrontKvsConfiguration {
  if (!input.client) {
    throw new LockException('CloudFront KeyValueStore client is required');
  }
  if (typeof input.kvsArn !== 'string' || input.kvsArn.trim().length === 0) {
    throw new LockException('kvsArn must be a non-empty string');
  }
  const keyPrefix = input.keyPrefix ?? 'tslock/';
  if (typeof keyPrefix !== 'string' || keyPrefix.includes('\0')) {
    throw new LockException('keyPrefix must be a string without control NUL characters');
  }
  if (Buffer.byteLength(keyPrefix, 'utf8') > 256) {
    throw new LockException('keyPrefix must be at most 256 UTF-8 bytes');
  }
  const maxEtagRetries = input.maxEtagRetries ?? 3;
  if (!Number.isInteger(maxEtagRetries) || maxEtagRetries < 1) {
    throw new LockException('maxEtagRetries must be an integer >= 1');
  }
  return Object.freeze({
    client: input.client,
    kvsArn: input.kvsArn.trim(),
    keyPrefix,
    maxEtagRetries,
  });
}
