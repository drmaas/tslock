import {
  AbstractSimpleLock,
  type LockConfiguration,
  type SimpleLock,
  lockAtLeastUntil,
  lockAtMostUntil,
} from '@tslock/core';
import type { InMemoryLockProvider } from './in-memory-lock-provider.js';

export class InMemoryLock extends AbstractSimpleLock {
  constructor(
    private readonly provider: InMemoryLockProvider,
    config: LockConfiguration,
  ) {
    super(config);
  }

  protected override async doUnlock(): Promise<void> {
    this.provider.locks.set(this.config.name, lockAtLeastUntil(this.config));
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    if (this.provider.isLocked(newConfig.name)) {
      this.provider.locks.set(newConfig.name, lockAtMostUntil(newConfig));
      return new InMemoryLock(this.provider, newConfig);
    }
    return undefined;
  }
}
