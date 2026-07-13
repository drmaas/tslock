import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { ExtensibleLockProvider, LockConfiguration, SimpleLock } from '@tslock/core';
import { DynamoDBAccessor } from './dynamodb-accessor.js';
import { type DynamoDBLockProviderOptions, validateOptions } from './dynamodb-lock-provider-options.js';

export class DynamoDBLockProvider implements ExtensibleLockProvider {
  private readonly accessor: DynamoDBAccessor;

  constructor(options: DynamoDBLockProviderOptions) {
    const opts = validateOptions(options);
    this.accessor = new DynamoDBAccessor(
      options.client ?? new DynamoDBClient({}),
      opts.tableName,
      opts.partitionKey,
      opts.sortKey,
    );
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}
