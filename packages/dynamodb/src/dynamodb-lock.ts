import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { DynamoDBAccessor } from './dynamodb-accessor.js';

export class DynamoDBLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: DynamoDBAccessor,
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
