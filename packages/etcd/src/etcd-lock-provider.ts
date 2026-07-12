import type { Etcd3 } from 'etcd3';
import {
  type LockConfiguration,
  type LockProvider,
  type SimpleLock,
} from '@tslock/core';
import { EtcdAccessor } from './etcd-accessor.js';
import { resolveOptions, type EtcdLockProviderOptions } from './etcd-lock-provider-options.js';

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
