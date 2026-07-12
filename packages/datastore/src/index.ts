export { createDatastoreProvider } from './datastore-lock-provider.js';
export type { DatastoreConfiguration, DatastoreFieldNames } from './datastore-configuration.js';
export { resolveDatastoreConfiguration } from './datastore-configuration.js';
export { DatastoreStorageAccessor } from './datastore-storage-accessor.js';
export { StorageBasedLockProvider, LockException } from '@tslock/core';
export type {
  StorageAccessor,
  AbstractStorageAccessor,
  LockConfiguration,
  LockProvider,
  ExtensibleLockProvider,
  SimpleLock,
} from '@tslock/core';
