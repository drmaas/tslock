import {
  AbstractStorageAccessor,
  ClockProvider,
  Utils,
  type LockConfiguration,
  lockAtMostUntil,
  unlockTime,
} from '@tslock/core';
import type {
  Firestore,
  DocumentReference,
  Transaction,
  Timestamp,
} from '@google-cloud/firestore';
import { Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import type { FirestoreFieldNames } from './firestore-configuration.js';

function toMillis(value: string | Timestamp): number {
  if (typeof value === 'object' && value !== null && typeof (value as Timestamp).toMillis === 'function') {
    return (value as Timestamp).toMillis();
  }
  return Date.parse(value as string);
}

export class FirestoreStorageAccessor extends AbstractStorageAccessor {
  private readonly firestore: Firestore;
  private readonly collectionName: string;
  private readonly fieldNames: FirestoreFieldNames;
  private readonly lockedByValue: string;
  private readonly useTimestamps: boolean;

  constructor(
    firestore: Firestore,
    collectionName: string,
    fieldNames: FirestoreFieldNames,
    lockedByValue: string,
    useTimestamps: boolean,
  ) {
    super();
    this.firestore = firestore;
    this.collectionName = collectionName;
    this.fieldNames = fieldNames;
    this.lockedByValue = lockedByValue;
    this.useTimestamps = useTimestamps;
  }

  private docRef(name: string): DocumentReference {
    return this.firestore.collection(this.collectionName).doc(name);
  }

  private toFieldValue(epochMillis: number): string | Timestamp {
    if (this.useTimestamps) {
      return FirestoreTimestamp.fromMillis(epochMillis);
    }
    return Utils.toIsoString(epochMillis);
  }

  private toData(config: LockConfiguration): Record<string, string | Timestamp> {
    return {
      [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
      [this.fieldNames.lockedAt]: this.toFieldValue(ClockProvider.now()),
      [this.fieldNames.lockedBy]: this.lockedByValue,
    };
  }

  async insertRecord(config: LockConfiguration): Promise<boolean> {
    const ref = this.docRef(config.name);
    return await this.firestore.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (snap.exists) return false;
      txn.create(ref, this.toData(config));
      return true;
    });
  }

  async updateRecord(config: LockConfiguration): Promise<boolean> {
    const ref = this.docRef(config.name);
    return await this.firestore.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return false;
      const current = toMillis(snap.get(this.fieldNames.lockUntil) as string | Timestamp);
      if (current > ClockProvider.now()) return false;
      txn.update(ref, this.toData(config));
      return true;
    });
  }

  async unlock(config: LockConfiguration): Promise<void> {
    const ref = this.docRef(config.name);
    await this.firestore.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return;
      if (snap.get(this.fieldNames.lockedBy) !== this.lockedByValue) return;
      const current = toMillis(snap.get(this.fieldNames.lockUntil) as string | Timestamp);
      if (current < ClockProvider.now()) return;
      txn.update(ref, {
        [this.fieldNames.lockUntil]: this.toFieldValue(unlockTime(config)),
      });
    });
  }

  async extend(config: LockConfiguration): Promise<boolean> {
    const ref = this.docRef(config.name);
    return await this.firestore.runTransaction(async (txn: Transaction) => {
      const snap = await txn.get(ref);
      if (!snap.exists) return false;
      if (snap.get(this.fieldNames.lockedBy) !== this.lockedByValue) return false;
      const current = toMillis(snap.get(this.fieldNames.lockUntil) as string | Timestamp);
      if (current < ClockProvider.now()) return false;
      txn.update(ref, {
        [this.fieldNames.lockUntil]: this.toFieldValue(lockAtMostUntil(config)),
      });
      return true;
    });
  }
}
