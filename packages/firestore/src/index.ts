export { createFirestoreProvider } from './firestore-lock-provider.js';
export type { FirestoreConfiguration, FirestoreFieldNames } from './firestore-configuration.js';
export { resolveFirestoreConfiguration } from './firestore-configuration.js';
export { FirestoreStorageAccessor } from './firestore-storage-accessor.js';
export { StorageBasedLockProvider, LockException } from '@tslock/core';
export type {
  StorageAccessor,
  AbstractStorageAccessor,
  LockConfiguration,
  LockProvider,
  ExtensibleLockProvider,
  SimpleLock,
} from '@tslock/core';
