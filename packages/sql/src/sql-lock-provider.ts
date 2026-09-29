import { StorageBasedLockProvider } from '@tslock/core';
import { createSqlStatementsSource, type SqlConfiguration } from '@tslock/sql-support';
import type { SqlConnection } from './sql-connection.js';
import { SqlStorageAccessor } from './sql-storage-accessor.js';

export class SqlLockProvider extends StorageBasedLockProvider {
  constructor(connection: SqlConnection, config: SqlConfiguration) {
    const statementsSource = createSqlStatementsSource(config);
    const accessor = new SqlStorageAccessor(connection, statementsSource);
    super(accessor);
  }
}
