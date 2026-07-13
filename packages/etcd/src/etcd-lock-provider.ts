import type { LockConfiguration, LockProvider, SimpleLock } from '@tslock/core';
import type { Etcd3 } from 'etcd3';
import { EtcdAccessor } from './etcd-accessor.js';
import { type EtcdLockProviderOptions, resolveOptions } from './etcd-lock-provider-options.js';

export class EtcdLockProvider implements LockProvider {
  private readonly accessor: EtcdAccessor;

  constructor(client: Etcd3, options?: EtcdLockProviderOptions) {
    const opts = resolveOptions(options);
    this.accessor = new EtcdAccessor(client, opts.env);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}
