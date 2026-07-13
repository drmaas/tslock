import type { Database } from '@google-cloud/spanner';
import { StorageBasedLockProvider } from '@tslock/core';
import type { SpannerColumnNames } from './spanner-configuration.js';
import { SpannerStorageAccessor } from './spanner-storage-accessor.js';

export function createSpannerProvider(
  database: Database,
  tableName: string,
  columnNames: SpannerColumnNames,
  lockedByValue: string,
): StorageBasedLockProvider {
  const accessor = new SpannerStorageAccessor(database, tableName, columnNames, lockedByValue);
  return new StorageBasedLockProvider(accessor);
}
