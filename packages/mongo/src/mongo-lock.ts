import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { MongoAccessor } from './mongo-accessor.js';

export class MongoLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: MongoAccessor,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.accessor.unlock(this.config);
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    return await this.accessor.extend(newConfig);
  }
}
