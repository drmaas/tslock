import type { Client } from '@elastic/elasticsearch';
import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
} from '@tslock/core';
import { ElasticsearchAccessor } from './elasticsearch-accessor.js';
import { FieldNames, type ElasticsearchFieldNames } from './field-names.js';

export interface ElasticsearchLockProviderOptions {
  index?: string;
  fieldNames?: ElasticsearchFieldNames;
}

export class ElasticsearchLockProvider implements ExtensibleLockProvider {
  private readonly accessor: ElasticsearchAccessor;

  constructor(client: Client, options?: ElasticsearchLockProviderOptions) {
    const index = options?.index ?? 'shedlock';
    const fieldNames = options?.fieldNames ?? FieldNames.DEFAULT;
    this.accessor = new ElasticsearchAccessor(client, index, fieldNames);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}
