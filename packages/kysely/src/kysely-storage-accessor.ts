import { AbstractStorageAccessor, type LockConfiguration } from '@tslock/core';
import { CompiledQuery, type Kysely } from 'kysely';
import type { SqlStatementsSource } from '@tslock/sql-support';
import type { KyselyDialectInfo } from './dialect-info.js';

export class KyselyStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly db: Kysely<unknown>,
    private readonly statementsSource: SqlStatementsSource,
    private readonly dialectInfo: KyselyDialectInfo,
  ) {
    super();
  }

  private async run(sqlText: string, params: Record<string, unknown>): Promise<unknown> {
    const { sql: translatedSql, values } = this.dialectInfo.translateParams(sqlText, params);
    const compiled = CompiledQuery.raw(translatedSql, values);
    return this.db.executeQuery(compiled);
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const sqlText = this.statementsSource.getInsertStatement();
    const params = this.statementsSource.params(config);
    try {
      const result = await this.run(sqlText, params);
      return this.dialectInfo.numAffectedRows(result) > 0;
    } catch (e) {
      if (this.dialectInfo.isDuplicateKeyError(e)) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const sqlText = this.statementsSource.getUpdateStatement();
    const params = this.statementsSource.params(config);
    const result = await this.run(sqlText, params);
    return this.dialectInfo.numAffectedRows(result) > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const sqlText = this.statementsSource.getUnlockStatement();
    const params = this.statementsSource.params(config);
    await this.run(sqlText, params);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const sqlText = this.statementsSource.getExtendStatement();
    const params = this.statementsSource.params(config);
    const result = await this.run(sqlText, params);
    return this.dialectInfo.numAffectedRows(result) > 0;
  }
}
