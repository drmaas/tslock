import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';

export interface DynamoDBLockProviderOptions {
  client?: DynamoDBClient;
  tableName: string;
  partitionKey?: string;
  sortKey?: { name: string; value: string };
}

export interface ResolvedOptions {
  tableName: string;
  partitionKey: string;
  sortKey?: { name: string; value: string };
}

export function validateOptions(options: DynamoDBLockProviderOptions): ResolvedOptions {
  if (!options.tableName) throw new Error('tableName is required');
  return {
    tableName: options.tableName,
    partitionKey: options.partitionKey ?? '_id',
    sortKey: options.sortKey,
  };
}
