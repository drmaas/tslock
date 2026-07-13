import type { Firestore } from '@google-cloud/firestore';
import { Utils } from '@tslock/core';

export interface FirestoreFieldNames {
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface FirestoreConfiguration {
  readonly firestore: Firestore;
  readonly collectionName?: string;
  readonly fieldNames?: Partial<FirestoreFieldNames>;
  readonly lockedByValue?: string;
  readonly useTimestamps?: boolean;
}

interface ResolvedFirestoreConfiguration {
  readonly firestore: Firestore;
  readonly collectionName: string;
  readonly fieldNames: FirestoreFieldNames;
  readonly lockedByValue: string;
  readonly useTimestamps: boolean;
}

const DEFAULT_FIELD_NAMES: FirestoreFieldNames = {
  lockUntil: 'lockUntil',
  lockedAt: 'lockedAt',
  lockedBy: 'lockedBy',
};

export function resolveFirestoreConfiguration(input: FirestoreConfiguration): ResolvedFirestoreConfiguration {
  if (!input.firestore) {
    throw new Error('FirestoreConfiguration: firestore is required');
  }

  const collectionName = input.collectionName ?? 'shedlock';
  if (collectionName === '') {
    throw new Error('FirestoreConfiguration: collectionName must not be empty');
  }

  const merged: FirestoreFieldNames = {
    ...DEFAULT_FIELD_NAMES,
    ...input.fieldNames,
  };

  for (const [key, value] of Object.entries(merged)) {
    if (value === '') {
      throw new Error(`FirestoreConfiguration: fieldNames.${key} must not be empty`);
    }
  }

  const lockedByValue = input.lockedByValue ?? Utils.getHostname();
  const useTimestamps = input.useTimestamps ?? false;

  return Object.freeze({
    firestore: input.firestore,
    collectionName,
    fieldNames: merged,
    lockedByValue,
    useTimestamps,
  });
}
