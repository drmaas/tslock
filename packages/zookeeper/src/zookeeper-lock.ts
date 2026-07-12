import { AbstractSimpleLock, type LockConfiguration } from '@tslock/core';
import type { ZooKeeperAccessor } from './zookeeper-accessor.js';

export class ZooKeeperLock extends AbstractSimpleLock {
  constructor(
    private readonly accessor: ZooKeeperAccessor,
    config: LockConfiguration,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.accessor.unlock(this.config);
  }
}
