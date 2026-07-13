export type {
  AbstractStorageAccessor,
  ExtensibleLockProvider,
  LockConfiguration,
  LockProvider,
  SimpleLock,
  StorageAccessor,
} from '@tslock/core';
export { LockException, StorageBasedLockProvider } from '@tslock/core';
export type { DatastoreConfiguration, DatastoreFieldNames } from './datastore-configuration.js';
export { resolveDatastoreConfiguration } from './datastore-configuration.js';
export { createDatastoreProvider } from './datastore-lock-provider.js';
export { DatastoreStorageAccessor } from './datastore-storage-accessor.js';
