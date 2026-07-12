import { AbstractSimpleLock, type LockConfiguration, type SimpleLock } from '@tslock/core';
import type { OpenSearchAccessor } from './opensearch-accessor.js';

export class OpenSearchLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: OpenSearchAccessor,
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
