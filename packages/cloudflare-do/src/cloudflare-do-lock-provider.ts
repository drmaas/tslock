import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  LockException,
  type SimpleLock,
  Utils,
} from '@tslock/core';
import { CloudflareDoLock } from './cloudflare-do-lock.js';
import type { LockOp, LockOpResult } from './protocol.js';

export type CloudflareDoFetcher = (lockName: string, init: RequestInit) => Promise<Response>;

export interface CloudflareDoLockProviderOptions {
  fetch: CloudflareDoFetcher;
}

export class CloudflareDoLockProvider implements ExtensibleLockProvider {
  private readonly fetcher: CloudflareDoFetcher;

  constructor(options: CloudflareDoLockProviderOptions) {
    if (!options?.fetch || typeof options.fetch !== 'function') {
      throw new LockException('fetch adapter is required');
    }
    this.fetcher = options.fetch;
  }

  private async call(op: LockOp): Promise<LockOpResult> {
    const response = await this.fetcher(op.name, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(op),
    });
    if (!response.ok) {
      throw new LockException(`Cloudflare DO lock request failed with HTTP ${response.status}`);
    }
    const result = (await response.json()) as LockOpResult;
    return result;
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const result = await this.call({
      op: 'lock',
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      createdAt: config.createdAt,
      lockedBy: Utils.getHostname(),
    });
    if (result.ok && result.acquired) {
      return new CloudflareDoLock(config, this);
    }
    return undefined;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    await this.call({
      op: 'unlock',
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      createdAt: config.createdAt,
      lockedBy: Utils.getHostname(),
    });
  }

  async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const result = await this.call({
      op: 'extend',
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      createdAt: config.createdAt,
      lockedBy: Utils.getHostname(),
    });
    if (result.ok && result.extended) {
      return new CloudflareDoLock(config, this);
    }
    return undefined;
  }
}

export function createCloudflareDoLockProvider(options: CloudflareDoLockProviderOptions): CloudflareDoLockProvider {
  return new CloudflareDoLockProvider(options);
}
