import type { Client } from '@opensearch-project/opensearch';
import {
  type ExtensibleLockProvider,
  type LockConfiguration,
  type SimpleLock,
} from '@tslock/core';
import { OpenSearchAccessor } from './opensearch-accessor.js';
import { FieldNames, type OpenSearchFieldNames } from './field-names.js';

export interface OpenSearchLockProviderOptions {
  index?: string;
  fieldNames?: OpenSearchFieldNames;
}

export class OpenSearchLockProvider implements ExtensibleLockProvider {
  private readonly accessor: OpenSearchAccessor;

  constructor(client: Client, options?: OpenSearchLockProviderOptions) {
    const index = options?.index ?? 'shedlock';
    const fieldNames = options?.fieldNames ?? FieldNames.DEFAULT;
    this.accessor = new OpenSearchAccessor(client, index, fieldNames);
  }

  async lock(config: LockConfiguration): Promise<SimpleLock | undefined> {
    return this.accessor.lock(config);
  }
}
