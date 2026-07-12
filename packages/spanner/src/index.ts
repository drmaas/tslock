export { createSpannerProvider } from './spanner-lock-provider.js';
export type { SpannerConfiguration, SpannerColumnNames } from './spanner-configuration.js';
export { resolveSpannerConfiguration } from './spanner-configuration.js';
export { SpannerStorageAccessor } from './spanner-storage-accessor.js';
export { StorageBasedLockProvider } from '@tslock/core';
export type {
  StorageAccessor,
  AbstractStorageAccessor,
  LockConfiguration,
  LockProvider,
  ExtensibleLockProvider,
  SimpleLock,
} from '@tslock/core';
export { LockException } from '@tslock/core';
