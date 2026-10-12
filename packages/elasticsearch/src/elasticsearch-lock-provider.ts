import type { Client } from '@elastic/elasticsearch';
import type { ExtensibleLockProvider, LockConfiguration, SimpleLock } from '@tslock/core';
import { SearchLockAccessor } from '@tslock/search-core';
import { ElasticsearchUpdateClient } from './elasticsearch-accessor.js';
import { type ElasticsearchFieldNames, FieldNames } from './field-names.js';

export interface ElasticsearchLockProviderOptions {
  index?: string;
  fieldNames?: ElasticsearchFieldNames;
}

export class ElasticsearchLockProvider implements ExtensibleLockProvider {
  private readonly accessor: SearchLockAccessor;

  constructor(client: Client, options?: ElasticsearchLockProviderOptions) {
    const index = options?.index ?? 'shedlock';
    const fieldNames = options?.fieldNames ?? FieldNames.DEFAULT;
    this.accessor = new SearchLockAccessor(new ElasticsearchUpdateClient(client), index, fieldNames);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}
