export type {
  AbstractStorageAccessor,
  ExtensibleLockProvider,
  LockConfiguration,
  LockProvider,
  SimpleLock,
  StorageAccessor,
} from '@tslock/core';
export { LockException, StorageBasedLockProvider } from '@tslock/core';
export type { FirestoreConfiguration, FirestoreFieldNames } from './firestore-configuration.js';
export { resolveFirestoreConfiguration } from './firestore-configuration.js';
export { createFirestoreProvider } from './firestore-lock-provider.js';
export { FirestoreStorageAccessor } from './firestore-storage-accessor.js';
