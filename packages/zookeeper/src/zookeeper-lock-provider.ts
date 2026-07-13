import type { LockConfiguration, LockProvider, SimpleLock } from '@tslock/core';
import { ZooKeeperAccessor } from './zookeeper-accessor.js';
import type { ZooKeeperLockProviderOptions } from './zookeeper-lock-provider-options.js';
import { resolveOptions } from './zookeeper-lock-provider-options.js';
import type { ZooKeeperClient } from './zookeeper-types.js';

export class ZooKeeperLockProvider implements LockProvider {
  private readonly accessor: ZooKeeperAccessor;

  constructor(client: ZooKeeperClient, options?: ZooKeeperLockProviderOptions) {
    const opts = resolveOptions(options);
    this.accessor = new ZooKeeperAccessor(client, opts.basePath);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}

export function createZooKeeperLockProvider(
  client: ZooKeeperClient,
  options?: ZooKeeperLockProviderOptions,
): ZooKeeperLockProvider {
  return new ZooKeeperLockProvider(client, options);
}
