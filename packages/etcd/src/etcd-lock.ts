import { AbstractSimpleLock, type LockConfiguration } from '@tslock/core';
import type { Lease } from 'etcd3';
import type { EtcdAccessor } from './etcd-accessor.js';

export class EtcdLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: EtcdAccessor,
    private readonly lease: Lease,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.accessor.unlock(this.config, this.lease);
  }
}
