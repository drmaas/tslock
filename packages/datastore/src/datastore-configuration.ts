import type { Datastore } from '@google-cloud/datastore';
import { Utils } from '@tslock/core';

export interface DatastoreFieldNames {
  readonly lockUntil: string;
  readonly lockedAt: string;
  readonly lockedBy: string;
}

export interface DatastoreConfiguration {
  readonly datastore: Datastore;
  readonly entityName?: string;
  readonly fieldNames?: Partial<DatastoreFieldNames>;
  readonly lockedByValue?: string;
  readonly useDate?: boolean;
}

interface ResolvedDatastoreConfiguration {
  readonly datastore: Datastore;
  readonly entityName: string;
  readonly fieldNames: DatastoreFieldNames;
  readonly lockedByValue: string;
  readonly useDate: boolean;
}

const DEFAULT_FIELD_NAMES: DatastoreFieldNames = {
  lockUntil: 'lockUntil',
  lockedAt: 'lockedAt',
  lockedBy: 'lockedBy',
};

export function resolveDatastoreConfiguration(input: DatastoreConfiguration): ResolvedDatastoreConfiguration {
  if (!input.datastore) {
    throw new Error('DatastoreConfiguration: datastore is required');
  }

  const entityName = input.entityName ?? 'shedlock';
  if (entityName === '') {
    throw new Error('DatastoreConfiguration: entityName must not be empty');
  }

  const merged: DatastoreFieldNames = {
    ...DEFAULT_FIELD_NAMES,
    ...input.fieldNames,
  };

  for (const [key, value] of Object.entries(merged)) {
    if (value === '') {
      throw new Error(`DatastoreConfiguration: fieldNames.${key} must not be empty`);
    }
  }

  const lockedByValue = input.lockedByValue ?? Utils.getHostname();
  const useDate = input.useDate ?? false;

  return Object.freeze({
    datastore: input.datastore,
    entityName,
    fieldNames: merged,
    lockedByValue,
    useDate,
  });
}
