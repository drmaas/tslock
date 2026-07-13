import { ClockProvider, type LockConfiguration, type LockProvider, type SimpleLock, Utils } from '@tslock/core';
import type { Client as MemjsClient } from 'memjs';
import { Client } from 'memjs';
import type { MemcachedLockProviderOptions } from './memcached-configuration.js';
import { MemcachedLock } from './memcached-lock.js';

const ENV_DEFAULT = 'default';

export class MemcachedLockProvider implements LockProvider {
  private readonly env: string;

  constructor(
    private readonly client: MemjsClient,
    options?: MemcachedLockProviderOptions,
  ) {
    this.env = options?.env ?? ENV_DEFAULT;
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const key = `shedlock:${this.env}:${config.name}`;
    const value = `ADDED:${Utils.toIsoString(now)}@${hostname}`;
    const expireTimeSeconds = Math.floor(config.lockAtMostFor / 1000) + 1;

    const result = await this.client.add(key, value, { expires: expireTimeSeconds });
    if (result.success) {
      return new MemcachedLock(this.client, key, value, config);
    }
    return undefined;
  }
}

export function createMemcachedLockProvider(options: MemcachedLockProviderOptions): MemcachedLockProvider {
  if (!options.servers) throw new Error('servers is required');
  const client = Client.create(options.servers, options.clientOptions);
  return new MemcachedLockProvider(client, options);
}
