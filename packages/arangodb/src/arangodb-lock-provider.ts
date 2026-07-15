import type { ExtensibleLockProvider, LockConfiguration, SimpleLock } from '@tslock/core';
import type { DocumentCollection, EdgeCollection } from 'arangojs/collection';
import type { Database } from 'arangojs/database';
import { ArangoDbAccessor } from './arangodb-accessor.js';
import type { ArangoDbLockDocument } from './arangodb-lock-document.js';

type ArangoCollection<T extends Record<string, unknown>> = DocumentCollection<T> & EdgeCollection<T>;

export interface ArangoDbLockProviderOptions {
  collection?: string;
}

export class ArangoDbLockProvider implements ExtensibleLockProvider {
  private readonly accessor: ArangoDbAccessor;

  constructor(collection: ArangoCollection<ArangoDbLockDocument>, database: Database) {
    this.accessor = new ArangoDbAccessor(collection, database);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}

export function createArangoDbLockProvider(
  database: Database,
  options?: ArangoDbLockProviderOptions,
): ArangoDbLockProvider {
  const collectionName = options?.collection ?? 'shedLock';
  const collection = database.collection<ArangoDbLockDocument>(collectionName);
  return new ArangoDbLockProvider(collection, database);
}
