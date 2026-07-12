import { StorageBasedLockProvider } from '@tslock/core';
import { createSqlStatementsSource, type SqlConfiguration } from '@tslock/sql-support';
import type { Kysely } from 'kysely';
import { getDialectInfo, type KyselyDialectName } from './dialect-info.js';
import { KyselyStorageAccessor } from './kysely-storage-accessor.js';

export class KyselyLockProvider extends StorageBasedLockProvider {
  constructor(db: Kysely<unknown>, dialect: KyselyDialectName, config: SqlConfiguration) {
    const statementsSource = createSqlStatementsSource(config);
    const dialectInfo = getDialectInfo(dialect);
    const accessor = new KyselyStorageAccessor(db, statementsSource, dialectInfo);
    super(accessor);
  }
}
