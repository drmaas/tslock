import type { Client } from '@elastic/elasticsearch';
import type { SearchUpdateClient, SearchUpdateRequest } from '@tslock/search-core';

export class ElasticsearchUpdateClient implements SearchUpdateClient {
  constructor(private readonly client: Client) {}

  async update(request: SearchUpdateRequest): Promise<{ result?: string }> {
    const response = await this.client.update(request);
    return { result: response.result };
  }
}
