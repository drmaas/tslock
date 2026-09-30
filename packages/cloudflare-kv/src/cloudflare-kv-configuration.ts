import { LockException } from '@tslock/core';
import type { CloudflareKvNamespace } from './cloudflare-kv-namespace.js';

export interface CloudflareKvLockProviderOptions {
  kv: CloudflareKvNamespace;
  acknowledgeAdvisoryLock: true;
  keyPrefix?: string;
  confirmWrite?: boolean;
}

export interface CloudflareKvConfiguration {
  readonly kv: CloudflareKvNamespace;
  readonly keyPrefix: string;
  readonly confirmWrite: boolean;
}

const MAX_PREFIX_BYTES = 256;

function utf8Size(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function resolveCloudflareKvConfiguration(input: CloudflareKvLockProviderOptions): CloudflareKvConfiguration {
  if (
    !input?.kv ||
    typeof input.kv.get !== 'function' ||
    typeof input.kv.put !== 'function' ||
    typeof input.kv.delete !== 'function'
  ) {
    throw new LockException('kv namespace with get, put, and delete is required');
  }
  if (input.acknowledgeAdvisoryLock !== true) {
    throw new LockException(
      'Set acknowledgeAdvisoryLock: true to use the best-effort Workers KV provider. For mutual exclusion, use @tslock/cloudflare-do.',
    );
  }
  const keyPrefix = input.keyPrefix ?? 'tslock:';
  if (typeof keyPrefix !== 'string' || keyPrefix.includes('\0')) {
    throw new LockException('keyPrefix must be a string without NUL characters');
  }
  if (utf8Size(keyPrefix) > MAX_PREFIX_BYTES) {
    throw new LockException('keyPrefix must be at most 256 UTF-8 bytes');
  }
  const confirmWrite = input.confirmWrite ?? true;
  if (typeof confirmWrite !== 'boolean') {
    throw new LockException('confirmWrite must be a boolean');
  }
  return Object.freeze({
    kv: input.kv,
    keyPrefix,
    confirmWrite,
  });
}
