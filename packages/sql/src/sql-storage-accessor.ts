import { AbstractStorageAccessor, type LockConfiguration } from '@tslock/core';
import type { SqlStatementsSource } from '@tslock/sql-support';
import type { SqlConnection } from './sql-connection.js';

export class SqlStorageAccessor extends AbstractStorageAccessor {
  constructor(
    private readonly connection: SqlConnection,
    private readonly statementsSource: SqlStatementsSource,
  ) {
    super();
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const sql = this.statementsSource.getInsertStatement();
    const params = this.statementsSource.params(config);
    try {
      const result = await this.connection.query(sql, params);
      return result.affectedRows > 0;
    } catch (e) {
      if (this.connection.isDuplicateKeyError(e)) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const sql = this.statementsSource.getUpdateStatement();
    const params = this.statementsSource.params(config);
    const result = await this.connection.query(sql, params);
    return result.affectedRows > 0;
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const sql = this.statementsSource.getUnlockStatement();
    const params = this.statementsSource.params(config);
    await this.connection.query(sql, params);
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const sql = this.statementsSource.getExtendStatement();
    const params = this.statementsSource.params(config);
    const result = await this.connection.query(sql, params);
    return result.affectedRows > 0;
  }
}
