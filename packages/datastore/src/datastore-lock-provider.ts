import { StorageBasedLockProvider } from '@tslock/core';
import type { DatastoreConfiguration } from './datastore-configuration.js';
import { resolveDatastoreConfiguration } from './datastore-configuration.js';
import { DatastoreStorageAccessor } from './datastore-storage-accessor.js';

export function createDatastoreProvider(config: DatastoreConfiguration): StorageBasedLockProvider {
  const resolved = resolveDatastoreConfiguration(config);
  const accessor = new DatastoreStorageAccessor(
    resolved.datastore,
    resolved.entityName,
    resolved.fieldNames,
    resolved.lockedByValue,
    resolved.useDate,
  );
  return new StorageBasedLockProvider(accessor);
}
