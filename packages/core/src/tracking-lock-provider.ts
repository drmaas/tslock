import { ClockProvider } from './clock-provider.js';
import type { LockConfiguration } from './lock-configuration.js';
import type { LockProvider } from './lock-provider.js';
import type { SimpleLock } from './simple-lock.js';

export interface ActiveLockRecord {
  readonly name: string;
  readonly lockAtMostFor: number;
  readonly lockAtLeastFor: number;
  readonly acquiredAt: number;
  readonly updatedAt: number;
}

class TrackingSimpleLock implements SimpleLock {
  private unlocked = false;

  constructor(
    private readonly delegate: SimpleLock,
    private readonly activeLocks: Set<SimpleLock>,
    private readonly records: Map<SimpleLock, ActiveLockRecord>,
    private readonly record: ActiveLockRecord,
  ) {}

  async unlock(): Promise<void> {
    if (this.unlocked) return;
    this.unlocked = true;
    this.activeLocks.delete(this);
    this.records.delete(this);
    await this.delegate.unlock();
  }

  async extend(lockAtMostFor: number, lockAtLeastFor: number): Promise<SimpleLock | undefined> {
    const newLock = await this.delegate.extend(lockAtMostFor, lockAtLeastFor);
    if (!newLock) return undefined;
    this.activeLocks.delete(this);
    this.records.delete(this);
    const nextRecord: ActiveLockRecord = Object.freeze({
      name: this.record.name,
      lockAtMostFor,
      lockAtLeastFor,
      acquiredAt: this.record.acquiredAt,
      updatedAt: ClockProvider.now(),
    });
    const wrapped = new TrackingSimpleLock(newLock, this.activeLocks, this.records, nextRecord);
    this.activeLocks.add(wrapped);
    this.records.set(wrapped, nextRecord);
    return wrapped;
  }
}

export class TrackingLockProviderWrapper implements LockProvider {
  private readonly activeLocks = new Set<SimpleLock>();
  private readonly records = new Map<SimpleLock, ActiveLockRecord>();

  constructor(private readonly delegate: LockProvider) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const lock = await this.delegate.lock(config);
    if (!lock) return undefined;
    const now = ClockProvider.now();
    const record: ActiveLockRecord = Object.freeze({
      name: config.name,
      lockAtMostFor: config.lockAtMostFor,
      lockAtLeastFor: config.lockAtLeastFor,
      acquiredAt: now,
      updatedAt: now,
    });
    const wrapped = new TrackingSimpleLock(lock, this.activeLocks, this.records, record);
    this.activeLocks.add(wrapped);
    this.records.set(wrapped, record);
    return wrapped;
  }

  getActiveLocks(): ReadonlySet<SimpleLock> {
    return this.activeLocks;
  }

  getActiveLockRecords(): readonly ActiveLockRecord[] {
    return [...this.records.values()];
  }
}
