export interface SearchUpdateRequest {
  id: string;
  index: string;
  refresh: 'wait_for';
  script: { source: string; params: Record<string, string> };
  upsert?: Record<string, string>;
}

export interface SearchUpdateClient {
  update(request: SearchUpdateRequest): Promise<{ result?: string }>;
}
