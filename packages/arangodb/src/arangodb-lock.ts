import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { ArangoDbAccessor } from './arangodb-accessor.js';

export class ArangoDbLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: ArangoDbAccessor,
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
