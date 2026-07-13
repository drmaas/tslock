import type { LockConfiguration, LockProvider, SimpleLock } from '@tslock/core';
import type { Client as HazelcastClient } from 'hazelcast-client';
import { HazelcastAccessor } from './hazelcast-accessor.js';
import { type HazelcastLockProviderOptions, resolveOptions } from './hazelcast-lock-provider-options.js';

export class HazelcastLockProvider implements LockProvider {
  private readonly accessor: HazelcastAccessor;

  constructor(client: HazelcastClient, options?: HazelcastLockProviderOptions) {
    const opts = resolveOptions(options);
    this.accessor = new HazelcastAccessor(client, opts.lockStoreKey, opts.lockLeaseTimeMs);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}
