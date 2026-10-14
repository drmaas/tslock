import {
  type ExtensibleLockProvider,
  extensibleLockProvider,
  type LockConfiguration,
  LockException,
  type SimpleLock,
  Utils,
} from '@tslock/core';
import { CloudflareDoLock } from './cloudflare-do-lock.js';
import type { LockOp, LockOpResult } from './protocol.js';

function newToken(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') {
    throw new LockException('crypto.randomUUID is required to create a Durable Object lock token');
  }
  return globalThis.crypto.randomUUID();
}

export type CloudflareDoFetcher = (lockName: string, init: RequestInit) => Promise<Response>;

export interface CloudflareDoLockProviderOptions {
  fetch: CloudflareDoFetcher;
}

export class CloudflareDoLockProvider implements ExtensibleLockProvider {
  readonly [extensibleLockProvider]: true = true;

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
    const token = newToken();
    const result = await this.call({
      op: 'lock',
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      createdAt: config.createdAt,
      lockedBy: Utils.getHostname(),
      token,
    });
    if (!result.ok || !result.acquired) return undefined;
    if (typeof result.token !== 'string' || result.token.length === 0) {
      throw new LockException('Cloudflare DO lock response did not include an ownership token');
    }
    return new CloudflareDoLock(config, result.token, this);
  }

  async unlock(config: LockConfiguration, token?: string): Promise<void> {
    if (typeof token !== 'string' || token.length === 0) return;
    await this.call({
      op: 'unlock',
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      createdAt: config.createdAt,
      lockedBy: Utils.getHostname(),
      token,
    });
  }

  async extend(config: LockConfiguration, token?: string): Promise<SimpleLock | undefined> {
    if (typeof token !== 'string' || token.length === 0) return undefined;
    const result = await this.call({
      op: 'extend',
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      createdAt: config.createdAt,
      lockedBy: Utils.getHostname(),
      token,
    });
    if (result.ok && result.extended) {
      return new CloudflareDoLock(config, token, this);
    }
    return undefined;
  }
}

export function createCloudflareDoLockProvider(options: CloudflareDoLockProviderOptions): CloudflareDoLockProvider {
  return new CloudflareDoLockProvider(options);
}
