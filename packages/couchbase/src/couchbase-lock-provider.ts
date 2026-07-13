import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
  StorageBasedLockProvider,
} from '@tslock/core';
import type { Collection } from 'couchbase';
import { CouchbaseStorageAccessor } from './couchbase-storage-accessor.js';

export interface CouchbaseColumnNames {
  readonly name: string;
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface CouchbaseLockProviderOptions {
  readonly documentIdPrefix?: string;
  readonly columnNames?: Partial<CouchbaseColumnNames>;
  readonly lockedByValue?: string;
}

const DEFAULT_DOCUMENT_ID_PREFIX = 'shedlock:';

const DEFAULT_COLUMN_NAMES: CouchbaseColumnNames = {
  name: 'name',
  lockUntil: 'lockUntil',
  lockedAt: 'lockedAt',
  lockedBy: 'lockedBy',
};

export interface ResolvedOptions {
  documentIdPrefix: string;
  nameCol: string;
  lockUntilCol: string;
  lockedAtCol: string;
  lockedByCol: string;
  lockedByValue: string;
}

export function resolveOptions(options?: CouchbaseLockProviderOptions): ResolvedOptions {
  const documentIdPrefix = options?.documentIdPrefix ?? DEFAULT_DOCUMENT_ID_PREFIX;
  const c = options?.columnNames ?? {};
  return {
    documentIdPrefix,
    nameCol: c.name ?? DEFAULT_COLUMN_NAMES.name,
    lockUntilCol: c.lockUntil ?? DEFAULT_COLUMN_NAMES.lockUntil,
    lockedAtCol: c.lockedAt ?? DEFAULT_COLUMN_NAMES.lockedAt,
    lockedByCol: c.lockedBy ?? DEFAULT_COLUMN_NAMES.lockedBy,
    lockedByValue: options?.lockedByValue ?? 'unknown',
  };
}

export class CouchbaseLockProvider implements ExtensibleLockProvider {
  private readonly delegate: StorageBasedLockProvider;

  constructor(collection: Collection, options?: CouchbaseLockProviderOptions) {
    const resolved = resolveOptions(options);
    this.delegate = new StorageBasedLockProvider(new CouchbaseStorageAccessor(collection, resolved));
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.delegate.lock(config);
  }

  clearCache(name: string): void {
    this.delegate.clearCache(name);
  }
}
