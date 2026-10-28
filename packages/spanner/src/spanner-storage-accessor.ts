import type { Database } from '@google-cloud/spanner';
import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  LockException,
  lockAtMostUntil,
  Utils,
  unlockTime,
} from '@tslock/core';
import { type SpannerColumnNames, validateSpannerIdentifiers } from './spanner-configuration.js';

function isTimestampValue(value: unknown): value is { getTime(): number } {
  return (
    value instanceof Date ||
    (typeof value === 'object' && value !== null && typeof (value as { getTime?: unknown }).getTime === 'function')
  );
}

function readLockUntilMillis(value: unknown, lockName: string): number {
  let millis = Number.NaN;
  if (isTimestampValue(value)) {
    millis = value.getTime();
  } else if (typeof value === 'string') {
    millis = Date.parse(value);
  }
  if (!Number.isFinite(millis)) {
    throw new LockException(`Invalid lockUntil for ${lockName}`);
  }
  return millis;
}

export class SpannerStorageAccessor extends AbstractStorageAccessor {
  private readonly database: Database;
  private readonly tableName: string;
  private readonly colNames: SpannerColumnNames;
  private readonly lockedByValue: string;

  constructor(database: Database, tableName: string, columnNames: SpannerColumnNames, lockedByValue: string) {
    super();
    validateSpannerIdentifiers(tableName, columnNames);
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
    } catch (e: unknown) {
      if ((e && (e as Record<string, unknown>).code === 6) || (e as Record<string, unknown>).code === 9) return false;
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
      if (rows.length === 0) throw new LockException(`Lock record not found: ${config.name}`);
      const currentLockUntil = readLockUntilMillis(
        (rows[0] as Record<string, unknown>)[this.colNames.lockUntil],
        config.name,
      );
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
        sql: `UPDATE \`${this.tableName}\` SET \`${this.colNames.lockUntil}\` = @unlockTime WHERE \`${this.colNames.name}\` = @name AND \`${this.colNames.lockedBy}\` = @lockedBy AND \`${this.colNames.lockUntil}\` = @expectedLockUntil`,
        params: {
          unlockTime: Utils.toIsoString(unlockTime(config)),
          name: config.name,
          lockedBy: this.lockedByValue,
          expectedLockUntil: Utils.toIsoString(lockAtMostUntil(config)),
        },
        types: {
          unlockTime: 'timestamp',
          expectedLockUntil: 'timestamp',
        },
      });
      await tx.commit();
    });
  }

  async extend(config: LockConfiguration, previousLockAtMostUntil?: number): Promise<boolean> {
    if (previousLockAtMostUntil === undefined) return false;
    return await this.database.runTransactionAsync(async (tx) => {
      const [rowCount] = await tx.runUpdate({
        sql: `UPDATE \`${this.tableName}\` SET \`${this.colNames.lockUntil}\` = @lockUntil WHERE \`${this.colNames.name}\` = @name AND \`${this.colNames.lockedBy}\` = @lockedBy AND \`${this.colNames.lockUntil}\` = @expectedLockUntil AND \`${this.colNames.lockUntil}\` > @now`,
        params: {
          lockUntil: Utils.toIsoString(lockAtMostUntil(config)),
          name: config.name,
          lockedBy: this.lockedByValue,
          expectedLockUntil: Utils.toIsoString(previousLockAtMostUntil),
          now: Utils.toIsoString(ClockProvider.now()),
        },
        types: {
          lockUntil: 'timestamp',
          expectedLockUntil: 'timestamp',
          now: 'timestamp',
        },
      });
      await tx.commit();
      return rowCount > 0;
    });
  }
}
