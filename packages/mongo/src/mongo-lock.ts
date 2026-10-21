import {
  AbstractSimpleLock,
  ClockProvider,
  type LockConfiguration,
  lockAtMostUntil,
  type SimpleLock,
  Utils,
  unlockTime,
} from '@tslock/core';
import type { Collection, Document, Filter, FindOneAndUpdateOptions } from 'mongodb';
import type { MongoLockDocument } from './mongo-lock-document.js';

export function mongoDate(epochMillis: number): Date {
  return new Date(Math.trunc(epochMillis));
}

export function storedDeadline(written: Date, stored: Date | undefined): Date {
  if (stored instanceof Date && stored.getTime() === written.getTime()) return stored;
  return written;
}

export class MongoLock extends AbstractSimpleLock {
  private readonly deadline: Date;

  constructor(
    config: LockConfiguration,
    private readonly collection: Collection<MongoLockDocument>,
    deadline: Date,
  ) {
    super(config);
    this.deadline = mongoDate(deadline.getTime());
  }

  protected override async doUnlock(): Promise<void> {
    await this.collection.findOneAndUpdate(
      {
        _id: this.config.name,
        lockedBy: Utils.getHostname(),
        lockUntil: this.deadline,
      } as Filter<MongoLockDocument>,
      { $set: { lockUntil: mongoDate(unlockTime(this.config)) } } as unknown as Document,
    );
  }

  protected override async doExtend(newConfig: LockConfiguration): Promise<SimpleLock | undefined> {
    if (this.deadline.getTime() <= ClockProvider.now()) return undefined;
    const written = mongoDate(lockAtMostUntil(newConfig));
    const result = await this.collection.findOneAndUpdate(
      {
        _id: this.config.name,
        lockedBy: Utils.getHostname(),
        lockUntil: this.deadline,
      } as Filter<MongoLockDocument>,
      { $set: { lockUntil: written } } as unknown as Document,
      { returnDocument: 'after' } as FindOneAndUpdateOptions,
    );
    if (!result) return undefined;
    return new MongoLock(newConfig, this.collection, storedDeadline(written, result.lockUntil));
  }
}
