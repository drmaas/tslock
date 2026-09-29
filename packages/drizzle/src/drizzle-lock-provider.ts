import { StorageBasedLockProvider } from '@tslock/core';
import { createSqlStatementsSource, type SqlConfiguration } from '@tslock/sql-support';
import type { DrizzleDialectInfo, DrizzleDialectName } from './dialect-info.js';
import { type DrizzleExecutor, DrizzleStorageAccessor } from './drizzle-storage-accessor.js';

export const DRIZZLE_DIALECT_INFOS: Record<DrizzleDialectName, DrizzleDialectInfo> = {
  postgresql: {
    dialect: 'postgresql',
    isDuplicateKeyError: (e) => typeof e === 'object' && e !== null && (e as { code?: string }).code === '23505',
    getAffectedRows: (result) => {
      if (typeof result !== 'object' || result === null) return 0;
      const r = result as { affectedRows?: number; rowCount?: number };
      return r.affectedRows ?? r.rowCount ?? 0;
    },
  },
  mysql: {
    dialect: 'mysql',
    isDuplicateKeyError: (e) => typeof e === 'object' && e !== null && (e as { errno?: number }).errno === 1062,
    getAffectedRows: (result) => {
      if (typeof result !== 'object' || result === null) return 0;
      const r = result as { affectedRows?: number };
      return r.affectedRows ?? 0;
    },
  },
  sqlite: {
    dialect: 'sqlite',
    isDuplicateKeyError: (e) =>
      typeof e === 'object' && e !== null && ((e as Error).message ?? '').includes('UNIQUE constraint failed'),
    getAffectedRows: (result) => {
      if (typeof result !== 'object' || result === null) return 0;
      const r = result as { changes?: number; rowsAffected?: number };
      return r.changes ?? r.rowsAffected ?? 0;
    },
  },
};

export class DrizzleLockProvider extends StorageBasedLockProvider {
  constructor(db: DrizzleExecutor, dialect: DrizzleDialectName, config: SqlConfiguration) {
    const statementsSource = createSqlStatementsSource(config);
    const dialectInfo = DRIZZLE_DIALECT_INFOS[dialect];
    const accessor = new DrizzleStorageAccessor(db, statementsSource, dialectInfo);
    super(accessor);
  }
}
