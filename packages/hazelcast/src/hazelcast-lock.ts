import { AbstractSimpleLock, type LockConfiguration } from '@tslock/core';
import type { HazelcastAccessor } from './hazelcast-accessor.js';

export class HazelcastLock extends AbstractSimpleLock {
  constructor(
    config: LockConfiguration,
    private readonly accessor: HazelcastAccessor,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    await this.accessor.unlock(this.config);
  }
}
