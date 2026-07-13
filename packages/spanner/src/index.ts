export type {
  AbstractStorageAccessor,
  ExtensibleLockProvider,
  LockConfiguration,
  LockProvider,
  SimpleLock,
  StorageAccessor,
} from '@tslock/core';
export { LockException, StorageBasedLockProvider } from '@tslock/core';
export type { SpannerColumnNames, SpannerConfiguration } from './spanner-configuration.js';
export { resolveSpannerConfiguration } from './spanner-configuration.js';
export { createSpannerProvider } from './spanner-lock-provider.js';
export { SpannerStorageAccessor } from './spanner-storage-accessor.js';
