import { ClockProvider, type LockConfiguration, lockAtMostUntil, type SimpleLock, Utils } from '@tslock/core';
import type { Collection, Document, Filter, FindOneAndUpdateOptions } from 'mongodb';
import { MongoServerError } from 'mongodb';
import { MongoLock, mongoDate, storedDeadline } from './mongo-lock.js';
import type { MongoLockDocument } from './mongo-lock-document.js';

export class MongoAccessor {
  constructor(private readonly collection: Collection<MongoLockDocument>) {}

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    const now = ClockProvider.now();
    const written = mongoDate(lockAtMostUntil(config));
    try {
      const result = await this.collection.findOneAndUpdate(
        { _id: config.name, lockUntil: { $lte: mongoDate(now) } } as Filter<MongoLockDocument>,
        {
          $set: {
            lockUntil: written,
            lockedAt: mongoDate(now),
            lockedBy: Utils.getHostname(),
          } as unknown as Document,
        },
        { upsert: true, returnDocument: 'after' } as FindOneAndUpdateOptions,
      );
      if (!result) return undefined;
      return new MongoLock(config, this.collection, storedDeadline(written, result.lockUntil));
    } catch (e) {
      if (e instanceof MongoServerError && e.code === 11000) {
        return undefined;
      }
      throw e;
    }
  }
}
