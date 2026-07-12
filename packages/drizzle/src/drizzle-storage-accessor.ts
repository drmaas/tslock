import { AbstractStorageAccessor, type LockConfiguration } from '@tslock/core';
import type { SQL } from 'drizzle-orm';
import type { SqlStatementsSource } from '@tslock/sql-support';
import type { DrizzleDialectInfo } from './dialect-info.js';
import { buildDrizzleQuery } from './query-builder.js';

export interface DrizzleExecutor {
  execute(query: SQL): Promise<unknown>;
}

export class DrizzleStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly db: DrizzleExecutor,
    private readonly statementsSource: SqlStatementsSource,
    private readonly dialectInfo: DrizzleDialectInfo,
  ) {
    super();
  }

  private build(sqlText: string, params: Record<string, unknown>): SQL {
    return buildDrizzleQuery(sqlText, params);
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const sqlText = this.statementsSource.getInsertStatement();
    const params = this.statementsSource.params(config);
    const query = this.build(sqlText, params);
    try {
      const result = await this.db.execute(query);
      return this.dialectInfo.getAffectedRows(result) > 0;
    } catch (e) {
      if (this.dialectInfo.isDuplicateKeyError(e)) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const sqlText = this.statementsSource.getUpdateStatement();
    const params = this.statementsSource.params(config);
    const result = await this.db.execute(this.build(sqlText, params));
    return this.dialectInfo.getAffectedRows(result) > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const sqlText = this.statementsSource.getUnlockStatement();
    const params = this.statementsSource.params(config);
    await this.db.execute(this.build(sqlText, params));
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const sqlText = this.statementsSource.getExtendStatement();
    const params = this.statementsSource.params(config);
    const result = await this.db.execute(this.build(sqlText, params));
    return this.dialectInfo.getAffectedRows(result) > 0;
  }
}
