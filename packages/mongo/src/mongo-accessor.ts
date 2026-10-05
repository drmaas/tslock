import {
  ClockProvider,
  DelegatingSimpleLock,
  type LockConfiguration,
  lockAtMostUntil,
  type SimpleLock,
  Utils,
  unlockTime,
} from '@tslock/core';
import type { Collection, Document, Filter, FindOneAndUpdateOptions } from 'mongodb';
import { MongoServerError } from 'mongodb';
import type { MongoLockDocument } from './mongo-lock-document.js';

export class MongoAccessor {
  constructor(private readonly collection: Collection<MongoLockDocument>) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    try {
      const result = await this.collection.findOneAndUpdate(
        { _id: config.name, lockUntil: { $lte: new Date(now) } } as Filter<MongoLockDocument>,
        {
          $set: {
            lockUntil: new Date(lockAtMostUntil(config)),
            lockedAt: new Date(now),
            lockedBy: hostname,
          } as unknown as Document,
        },
        { upsert: true, returnDocument: 'after' } as FindOneAndUpdateOptions,
      );
      if (!result) return undefined;
      return new DelegatingSimpleLock(config, this);
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000) {
        return undefined;
      }
      throw e;
    }
  }

  async extend(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const hostname = Utils.getHostname();
    const result = await this.collection.findOneAndUpdate(
      {
        _id: config.name,
        lockUntil: { $gt: new Date(now) },
        lockedBy: hostname,
      } as Filter<MongoLockDocument>,
      { $set: { lockUntil: new Date(lockAtMostUntil(config)) } } as unknown as Document,
      { returnDocument: 'after' } as FindOneAndUpdateOptions,
    );
    if (!result) return undefined;
    return new DelegatingSimpleLock(config, this);
  }

  async unlock(config: LockConfiguration): Promise<void> {
    await this.collection.findOneAndUpdate(
      { _id: config.name } as Filter<MongoLockDocument>,
      { $set: { lockUntil: new Date(unlockTime(config)) } } as unknown as Document,
    );
  }
}
