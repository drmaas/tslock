import {
  AbstractSimpleLock,
  ClockProvider,
  type LockConfiguration,
  lockAtLeastUntil,
  lockAtMostUntil,
  type SimpleLock,
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
    if (this.provider.locks.get(this.config.name) !== lockAtMostUntil(this.config)) return;
    this.provider.locks.set(this.config.name, lockAtLeastUntil(this.config));
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    const ownedUntil = lockAtMostUntil(this.config);
    if (this.provider.locks.get(this.config.name) === ownedUntil && ownedUntil > ClockProvider.now()) {
      this.provider.locks.set(this.config.name, lockAtMostUntil(newConfig));
      return new InMemoryLock(this.provider, newConfig);
    }
    return undefined;
  }
}
