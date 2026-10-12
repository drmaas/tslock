import type { Client } from '@opensearch-project/opensearch';
import type { SearchUpdateClient, SearchUpdateRequest } from '@tslock/search-core';

export class OpenSearchUpdateClient implements SearchUpdateClient {
  constructor(private readonly client: Client) {}

  async update(request: SearchUpdateRequest): Promise<{ result?: string }> {
    const { script, upsert, ...rest } = request;
    const response = await this.client.update({
      ...rest,
      body: { script, upsert },
    });
    return { result: response.body?.result };
  }
}
