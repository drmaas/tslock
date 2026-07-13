import type { Datastore, Transaction } from '@google-cloud/datastore';
import {
  AbstractStorageAccessor,
  ClockProvider,
  type LockConfiguration,
  lockAtMostUntil,
  Utils,
  unlockTime,
} from '@tslock/core';
import type { DatastoreFieldNames } from './datastore-configuration.js';

type DatastoreEntity = Record<string, any>;

function isNotFound(e: any): boolean {
  if (e?.code === 5) return true;
  if (typeof e?.message === 'string') {
    const msg = e.message.toLowerCase();
    return msg.includes('not found') || msg.includes('no entity') || msg.includes('no matching');
  }
  return false;
}

export class DatastoreStorageAccessor extends AbstractStorageAccessor {
  private readonly datastore: Datastore;
  private readonly entityName: string;
  private readonly fieldNames: DatastoreFieldNames;
  private readonly lockedByValue: string;
  private readonly useDate: boolean;

  constructor(
    datastore: Datastore,
    entityName: string,
    fieldNames: DatastoreFieldNames,
    lockedByValue: string,
    useDate: boolean,
  ) {
    super();
    this.datastore = datastore;
    this.entityName = entityName;
    this.fieldNames = fieldNames;
    this.lockedByValue = lockedByValue;
    this.useDate = useDate;
  }

  private key(lockName: string): any {
    return this.datastore.key([this.entityName, lockName]);
  }

  private toFieldValue(epochMillis: number): string | Date {
    if (this.useDate) {
      return new Date(epochMillis);
    }
    return Utils.toIsoString(epochMillis);
  }

  private parseFieldValue(value: string | Date): number {
    if (
      value instanceof Date ||
      (typeof value === 'object' && value !== null && typeof (value as Date).getTime === 'function')
    ) {
      return (value as Date).getTime();
    }
    return Date.parse(value as string);
  }

  private toData(config: LockConfiguration): Record<string, string | Date> {
    return {
      [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
      [this.fieldNames.lockedAt]: this.toFieldValue(ClockProvider.now()),
      [this.fieldNames.lockedBy]: this.lockedByValue,
    };
  }

  private async safeGet(txn: Transaction, key: any): Promise<DatastoreEntity | undefined> {
    try {
      const [entity] = await txn.get(key);
      return entity;
    } catch (e: any) {
      if (isNotFound(e)) return undefined;
      throw e;
    }
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const key = this.key(config.name);
    return await this.datastore.runTransaction(async (txn: Transaction) => {
      const existing = await this.safeGet(txn, key);
      if (existing) return false;
      txn.upsert({ key, data: this.toData(config) });
      return true;
    });
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const key = this.key(config.name);
    return await this.datastore.runTransaction(async (txn: Transaction) => {
      const existing = await this.safeGet(txn, key);
      if (!existing) return false;
      const current = this.parseFieldValue(existing[this.fieldNames.lockUntil]);
      if (current > ClockProvider.now()) return false;
      txn.upsert({ key, data: this.toData(config) });
      return true;
    });
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const key = this.key(config.name);
    await this.datastore.runTransaction(async (txn: Transaction) => {
      const existing = await this.safeGet(txn, key);
      if (!existing) return;
      if (existing[this.fieldNames.lockedBy] !== this.lockedByValue) return;
      txn.upsert({
        key,
        data: {
          ...existing,
          [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)),
        },
      });
    });
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const key = this.key(config.name);
    return await this.datastore.runTransaction(async (txn: Transaction) => {
      const existing = await this.safeGet(txn, key);
      if (!existing) return false;
      if (existing[this.fieldNames.lockedBy] !== this.lockedByValue) return false;
      const current = this.parseFieldValue(existing[this.fieldNames.lockUntil]);
      if (current < ClockProvider.now()) return false;
      txn.upsert({
        key,
        data: {
          ...existing,
          [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
        },
      });
      return true;
    });
  }
}
