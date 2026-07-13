import type { ExtensibleLockProvider, LockConfiguration, SimpleLock } from '@tslock/core';
import type { Collection, Db } from 'mongodb';
import { MongoAccessor } from './mongo-accessor.js';
import type { MongoLockDocument } from './mongo-lock-document.js';

export interface MongoLockProviderOptions {
  collection?: string;
  collectionOptions?: {
    writeConcern?: { w?: 'majority' | number; j?: boolean; wtimeoutMS?: number };
    readConcern?: { level?: 'local' | 'majority' | 'linearizable' | 'available' | 'snapshot' };
  };
}

export class MongoLockProvider implements ExtensibleLockProvider {
  private readonly accessor: MongoAccessor;

  constructor(collection: Collection<MongoLockDocument>) {
    this.accessor = new MongoAccessor(collection);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}

export function createMongoLockProvider(db: Db, options?: MongoLockProviderOptions): MongoLockProvider {
  const collectionName = options?.collection ?? 'shedLock';
  const writeConcern = { w: 'majority' as const, ...options?.collectionOptions?.writeConcern };
  const readConcern = { level: 'majority' as const, ...options?.collectionOptions?.readConcern };
  const collection = db.collection<MongoLockDocument>(collectionName, { writeConcern, readConcern });
  return new MongoLockProvider(collection);
}
