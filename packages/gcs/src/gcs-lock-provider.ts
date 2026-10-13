import type { Storage } from '@google-cloud/storage';
import {
  type ExtensibleLockProvider,
  extensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
  StorageBasedLockProvider,
} from '@tslock/core';
import type { GcsProviderConfig } from './gcs-provider-config.js';
import { GcsStorageAccessor } from './gcs-storage-accessor.js';

export class GcsLockProvider implements ExtensibleLockProvider {
  readonly [extensibleLockProvider]: true = true;

  private readonly delegate: StorageBasedLockProvider;

  constructor(storage: Storage, config: GcsProviderConfig) {
    const accessor = new GcsStorageAccessor(storage, config);
    this.delegate = new StorageBasedLockProvider(accessor);
  }

  lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.delegate.lock(config);
  }

  clearCache(name: string): void {
    this.delegate.clearCache(name);
  }
}
