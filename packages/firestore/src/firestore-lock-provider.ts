import { StorageBasedLockProvider } from '@tslock/core';
import type { FirestoreConfiguration } from './firestore-configuration.js';
import { resolveFirestoreConfiguration } from './firestore-configuration.js';
import { FirestoreStorageAccessor } from './firestore-storage-accessor.js';

export function createFirestoreProvider(config: FirestoreConfiguration): StorageBasedLockProvider {
  const resolved = resolveFirestoreConfiguration(config);
  const accessor = new FirestoreStorageAccessor(
    resolved.firestore,
    resolved.collectionName,
    resolved.fieldNames,
    resolved.lockedByValue,
    resolved.useTimestamps,
  );
  return new StorageBasedLockProvider(accessor);
}
