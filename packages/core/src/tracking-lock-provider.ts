import type { LockConfiguration } from './lock-configuration.js';
import type { LockProvider } from './lock-provider.js';
import type { SimpleLock } from './simple-lock.js';

class TrackingSimpleLock implements SimpleLock {
  private unlocked = false;

  constructor(
    private readonly delegate: SimpleLock,
    private readonly activeLocks: Set<SimpleLock>,
  ) {}

  async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.unlocked = true;
    this.activeLocks.delete(this);
    await this.delegate.unlock();
  }

  async extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined> {
    const newLock = await this.delegate.extend(lockAtMostFor, lockAtLeastFor);
    if (!newLock) return undefined;
    this.activeLocks.delete(this);
    const wrapped = new TrackingSimpleLock(newLock, this.activeLocks);
    this.activeLocks.add(wrapped);
    return wrapped;
  }
}

export class TrackingLockProviderWrapper implements LockProvider {
  private readonly activeLocks = new Set<SimpleLock>();

  constructor(private readonly delegate: LockProvider) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const lock = await this.delegate.lock(config);
    if (!lock) return undefined;
    const wrapped = new TrackingSimpleLock(lock, this.activeLocks);
    this.activeLocks.add(wrapped);
    return wrapped;
  }

  getActiveLocks(): ReadonlySet<SimpleLock> {
    return this.activeLocks;
  }
}
