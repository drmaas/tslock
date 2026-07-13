import type { Database } from '@google-cloud/spanner';
import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  Utils,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';
import type { SpannerColumnNames } from './spanner-configuration.js';

export class SpannerStorageAccessor extends AbstractStorageAccessor {
  private readonly database: Database;
  private readonly tableName: string;
  private readonly colNames: SpannerColumnNames;
  private readonly lockedByValue: string;

  constructor(database: Database, tableName: string, columnNames: SpannerColumnNames, lockedByValue: string) {
    super();
    this.database = database;
    this.tableName = tableName;
    this.colNames = columnNames;
    this.lockedByValue = lockedByValue;
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    try {
      return await this.database.runTransactionAsync(async (tx) => {
        tx.insert(this.tableName, {
          [this.colNames.name]: config.name,
          [this.colNames.lockUntil]: Utils.toIsoString(lockAtMostUntil(config)),
          [this.colNames.lockedAt]: Utils.toIsoString(ClockProvider.now()),
          [this.colNames.lockedBy]: this.lockedByValue,
        });
        await tx.commit();
        return true;
      });
    } catch (e: any) {
      if (e && (e.code === 6 || e.code === 9)) return false;
      throw e;
    }
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    return await this.database.runTransactionAsync(async (tx) => {
      const [rows] = await tx.read(this.tableName, {
        keys: [config.name],
        columns: [this.colNames.lockUntil],
        json: true,
      });
      if (rows.length === 0) return false;
      const currentLockUntil = Date.parse((rows[0] as any)[this.colNames.lockUntil] as string);
      if (currentLockUntil > ClockProvider.now()) return false;
      tx.update(this.tableName, {
        [this.colNames.name]: config.name,
        [this.colNames.lockUntil]: Utils.toIsoString(lockAtMostUntil(config)),
        [this.colNames.lockedAt]: Utils.toIsoString(ClockProvider.now()),
        [this.colNames.lockedBy]: this.lockedByValue,
      });
      await tx.commit();
      return true;
    });
  }

  async unlock(config: LockConfiguration): Promise<void> {
    await this.database.runTransactionAsync(async (tx) => {
      await tx.runUpdate({
        sql: `UPDATE \`${this.tableName}\` SET \`${this.colNames.lockUntil}\` = @unlockTime WHERE \`${this.colNames.name}\` = @name AND \`${this.colNames.lockedBy}\` = @lockedBy`,
        params: {
          unlockTime: Utils.toIsoString(unlockTime(config)),
          name: config.name,
          lockedBy: this.lockedByValue,
        },
      });
      await tx.commit();
    });
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    return await this.database.runTransactionAsync(async (tx) => {
      const [rowCount] = await tx.runUpdate({
        sql: `UPDATE \`${this.tableName}\` SET \`${this.colNames.lockUntil}\` = @lockUntil WHERE \`${this.colNames.name}\` = @name AND \`${this.colNames.lockedBy}\` = @lockedBy AND \`${this.colNames.lockUntil}\` > @now`,
        params: {
          lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
          name: config.name,
          lockedBy: this.lockedByValue,
          now: Utils.toIsoString(ClockProvider.now()),
        },
      });
      await tx.commit();
      return rowCount > 0;
    });
  }
}
